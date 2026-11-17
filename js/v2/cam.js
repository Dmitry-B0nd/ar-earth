// Движок «только по камере» (бюджетные Android и всё, где нет ARCore и надёжного гироскопа).
// Кадр камеры → поиск листа в фоновом потоке → сцена ставится по этому же кадру (ядро camcore.js).
// Кадр показывается с небольшой задержкой — когда для него уже готово распознавание; так сцена «приклеена» к картинке.
// Датчики не используются вовсе; ничего не подбирается и не переключается на ходу.
import * as THREE from 'three';
import { createCamCore } from './camcore.js?v=7.0';

const VER = '7.0';

export function createEngineCam(opts) {
  const { container, onFound, onLost, onStall, FOV = 66, CAMFPS = 30, BOARDM = 0.18, AA = true, CAMW = 640, CAMH = 480,
    MAXPIX = 76800, TAGPX = 28, MAXDELAY = 160 } = opts;

  // ---------- Рисование: видео как текстура, несколько последних кадров в видеопамяти ----------
  const renderer = new THREE.WebGLRenderer({ antialias: AA, powerPreference: 'default' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const video = document.createElement('video');
  video.setAttribute('playsinline', ''); video.setAttribute('muted', ''); video.muted = true; video.autoplay = true;
  Object.assign(video.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'cover', zIndex: '0' });
  Object.assign(renderer.domElement.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', zIndex: '1' });
  container.appendChild(video);
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.02, 100);
  const content = new THREE.Group();
  content.matrixAutoUpdate = false; content.visible = false;
  scene.add(content);
  const mkTex = () => {
    const t = new THREE.Texture(video);
    t.isVideoTexture = true; t.update = () => {};          // см. движок 2: обновляем сами, только на новом кадре
    t.colorSpace = THREE.SRGBColorSpace; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
    return t;
  };
  const ring = Array.from({ length: 8 }, () => ({ tex: mkTex(), n: -1, tf: 0, ta: 0 }));
  let ringI = -1, shownSlot = null, texSize = '';
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: ring[0].tex, depthTest: false, depthWrite: false, toneMapped: false }));
  bg.renderOrder = -1000; bg.frustumCulled = false; bg.visible = false;
  scene.add(bg);

  const core = createCamCore(opts.CORE || {});
  let started = false, paused = false, frozen = false, wasShown = false, needRender = true, lastRenderT = 0;
  let vw = 0, vh = 0, f0 = 0;
  const vf = { t: 0, n: 0, fresh: false, last: 0, mode: '—' };
  const sec = { frames: 0, sent: 0, res: 0, found: 0, ms: 0, grabMs: 0, tags: 0 };
  let secSnap = { ...sec }, secT = performance.now();
  const gaps = { pose: 0, proc: 0, lastPose: 0, lastProc: 0 };
  let loops = 0, roiTxt = '—', lastTags = 0, lastSide = 0, lastErr = 0;

  // ---------- Распознавание в фоновом потоке ----------
  let worker = null, workerOk = false, busy = false, busySince = 0, id = 0, fails = 0;
  let grabMode = typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function' ? 'bitmap' : 'pixels';
  let bitmapProbed = false, lastTagsT = 0, visionSince = 0;
  const grabCv = document.createElement('canvas'), grabCtx = grabCv.getContext('2d', { willReadFrequently: true });
  const sent = new Map();
  function startVision() {
    worker = new Worker(new URL('./vision-worker.js?v=' + VER, import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'ready') { workerOk = true; visionSince = performance.now(); console.log('[по камере] распознаватель готов'); return; }
      if (m.type === 'fail') { console.error('[по камере] распознаватель не загрузился:', m.msg); return; }
      onResult(m);
    };
    worker.onerror = (e) => console.error('[по камере] фоновый поток:', e.message || e);
  }
  function planRoi(tf) {
    const pc = fails < 2 ? core.predictCorners(tf) : null;
    let sx = 0, sy = 0, sw = vw, sh = vh, scale;
    if (pc) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of pc) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      const side = Math.max(x1 - x0, y1 - y0), m = side * 0.35 + 24;
      sx = Math.max(0, Math.floor(x0 - m)); sy = Math.max(0, Math.floor(y0 - m));
      sw = Math.min(vw, Math.ceil(x1 + m)) - sx; sh = Math.min(vh, Math.ceil(y1 + m)) - sy;
      if (sw < 48 || sh < 48) { sx = 0; sy = 0; sw = vw; sh = vh; scale = Math.sqrt(MAXPIX / (vw * vh)); }
      else scale = TAGPX / Math.max(4, side * 0.28);
    } else scale = Math.sqrt(MAXPIX / (vw * vh));
    scale = Math.min(scale, 1);
    let dw = Math.max(32, Math.round(sw * scale)), dh = Math.max(32, Math.round(sh * scale));
    const cap = pc ? 120000 : MAXPIX;
    if (dw * dh > cap) { const k = Math.sqrt(cap / (dw * dh)); dw = Math.max(32, Math.round(dw * k)); dh = Math.max(32, Math.round(dh * k)); }
    return { sx, sy, sw, sh, dw, dh, roi: !!pc };
  }
  function sendFrame(tf) {
    if (busy || paused || frozen || !vw || !workerOk) return;
    const r = planRoi(tf);
    const map = { sx: r.sx, sy: r.sy, kx: r.sw / r.dw, ky: r.sh / r.dh };
    roiTxt = r.dw + '×' + r.dh + (r.roi ? ' (участок)' : ' (весь кадр)');
    const myId = ++id;
    busy = true; busySince = performance.now();
    sent.set(myId, { ta: vf.last, roi: r.roi });
    const t0 = performance.now();
    if (grabMode === 'bitmap') {
      createImageBitmap(video, r.sx, r.sy, r.sw, r.sh, { resizeWidth: r.dw, resizeHeight: r.dh, resizeQuality: 'low' }).then((bmp) => {
        worker.postMessage({ type: 'frame', id: myId, tFrame: tf, w: r.dw, h: r.dh, map, bitmap: bmp }, [bmp]);
      }).catch((e) => { console.warn('[по камере] картинка кадра не получилась — читаю пиксели:', e); grabMode = 'pixels'; busy = false; });
      sec.grabMs += performance.now() - t0; sec.sent++;
      return;
    }
    if (grabCv.width !== r.dw || grabCv.height !== r.dh) { grabCv.width = r.dw; grabCv.height = r.dh; }
    grabCtx.drawImage(video, r.sx, r.sy, r.sw, r.sh, 0, 0, r.dw, r.dh);
    const img = grabCtx.getImageData(0, 0, r.dw, r.dh);
    sec.grabMs += performance.now() - t0; sec.sent++;
    worker.postMessage({ type: 'frame', id: myId, tFrame: tf, w: r.dw, h: r.dh, map, data: img.data }, [img.data.buffer]);
  }

  // задержка показа: сколько обычно ждать распознавания кадра + промежуток до следующего (чтобы кадр был «между»)
  let lat = 40, interval = 50, lastResT = 0, delayMs = 60;
  const REC = { det: [], frames: [] };
  function onResult(m) {
    busy = false;
    const s = sent.get(m.id); sent.delete(m.id);
    if (m.type === 'err') { if (grabMode === 'bitmap') { grabMode = 'pixels'; console.warn('[по камере] поток не читает картинку — читаю пиксели:', m.msg); } return; }
    const now = performance.now();
    loops++; sec.res++; sec.ms += m.ms;
    if (gaps.lastProc) gaps.proc = Math.max(gaps.proc, now - gaps.lastProc);
    gaps.lastProc = now;
    if (s) { const L = now - s.ta; lat += (L - lat) * (L > lat ? 0.3 : 0.05); }
    if (lastResT) { const I = Math.min(200, now - lastResT); interval += (I - interval) * (I > interval ? 0.3 : 0.05); }
    lastResT = now;
    const target = Math.max(20, Math.min(MAXDELAY, lat + interval + 8));
    if (target > delayMs + 4 || target < delayMs - 12) delayMs += (target - delayMs) * 0.5;   // ступеньками: ровнее кадры
    lastTags = m.tags || 0; lastSide = m.side || 0; lastErr = m.err || 0;
    if (m.tags > 0) lastTagsT = now;
    // картинкой ничего не находится 5 с — возможно, браузер отдаёт пустую картинку: один раз пробуем пиксели
    if (grabMode === 'bitmap' && !bitmapProbed && now - Math.max(lastTagsT, visionSince) > 5000) { bitmapProbed = true; grabMode = 'pixels'; console.warn('[по камере] картинкой меток не видно — пробую пиксели'); }
    if (opts.DEV) { REC.det.push({ tf: +m.tFrame.toFixed(1), t: Math.round(now), n: m.n || 0, tags: m.tags || 0, err: +(m.err || 0).toFixed(3), H: m.H ? m.H.map((v) => +v.toPrecision(7)) : null }); if (REC.det.length > 1500) REC.det.shift(); }
    const ok = m.n >= 4 && m.H;
    if (ok && m.tags > 0) fails = 0; else if (s && s.roi) fails++;
    if (!ok || frozen || paused) return;
    // первое нахождение (и после потери) — минимум по двум меткам: одну метку легче спутать с узором
    if (!core.poseAt(m.tFrame, tq, tp) && m.tags < 2) return;
    if (core.add(m.tFrame, m.H, m.pts, m.n)) sec.found++;
  }
  const tq = new THREE.Quaternion(), tp = new THREE.Vector3();

  // ---------- Кадры камеры ----------
  const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  function onVideoFrame(now, md) {
    const pn = performance.now(), ok = (v) => typeof v === 'number' && v > pn - 500 && v <= pn + 2;
    let tf = now, mode = 'кадр';
    if (md && ok(md.captureTime)) { tf = md.captureTime; mode = 'съёмки'; }
    else if (md && ok(md.presentationTime)) { tf = md.presentationTime; mode = 'показа'; }
    vf.mode = mode;
    onFrame(tf);
    video.requestVideoFrameCallback(onVideoFrame);
  }
  let lastVT = -1;
  function pollFrame(now) { if (video.currentTime !== lastVT) { lastVT = video.currentTime; vf.mode = 'кадр*'; onFrame(now); } }
  function onFrame(tf) {
    if (tf <= vf.t) tf = vf.t + 0.1;
    vf.t = tf; vf.n++; vf.fresh = true; vf.last = performance.now();
    sec.frames++;
    if (opts.DEV) { REC.frames.push([+tf.toFixed(1), Math.round(vf.last)]); if (REC.frames.length > 4000) REC.frames.shift(); }
    if (!frozen) sendFrame(tf);
  }

  // ---------- Раскладка: проекция камеры под обрезку видео экраном ----------
  let layoutKey = '';
  function layout(force) {
    const cw = container.clientWidth || window.innerWidth, ch = container.clientHeight || window.innerHeight;
    if (!vw || !cw || !ch) return;
    const key = cw + 'x' + ch + ':' + vw + 'x' + vh;
    if (!force && key === layoutKey) return;
    layoutKey = key;
    renderer.setSize(cw, ch, false);
    const s = Math.max(cw / vw, ch / vh), fs = f0 * s;
    camera.fov = 2 * Math.atan(ch / 2 / fs) * 180 / Math.PI; camera.aspect = cw / ch; camera.updateProjectionMatrix();
    const D = 50;
    bg.position.set(0, 0, -D); bg.scale.set(D * cw / fs, D * ch / fs, 1);
    const rx = cw / (s * vw), ry = ch / (s * vh);
    for (const r of ring) { r.tex.repeat.set(rx, ry); r.tex.offset.set((1 - rx) / 2, (1 - ry) / 2); }
  }
  function onVideoSize() {
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h || (w === vw && h === vh)) return;
    vw = w; vh = h;
    f0 = (Math.max(w, h) / 2) / Math.tan(FOV * Math.PI / 360);
    core.setCamera(w, h, f0); core.reset();
    console.log('[по камере] кадр', w + '×' + h, ', угол обзора', FOV + '°');
    layout(true);
  }
  video.addEventListener('resize', onVideoSize);
  video.addEventListener('loadedmetadata', onVideoSize);
  window.addEventListener('resize', () => setTimeout(() => layout(true), 50));

  let stream = null;
  async function openCamera() {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: CAMW }, height: { ideal: CAMH }, frameRate: { ideal: CAMFPS } } });
    video.srcObject = stream;
    await video.play().catch(() => {});
    const t0 = performance.now();
    while (!video.videoWidth && performance.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 30));
    onVideoSize();
  }
  // сторож: камера перестала присылать кадры / поток не отвечает
  let stalls = 0, stallReported = false;
  function watchdog() {
    setInterval(async () => {
      if (!started || paused || frozen || document.hidden) { stalls = 0; return; }
      if (busy && performance.now() - busySince > 3000) busy = false;
      if (performance.now() - vf.last < 2000) { stalls = 0; return; }
      stalls++;
      console.warn('[по камере] нет кадров с камеры', stalls);
      video.play().catch(() => {});
      if (stalls === 3) { try { stream && stream.getTracks().forEach((t) => t.stop()); await openCamera(); } catch (e) { console.warn(e); } }
      if (stalls >= 6 && !stallReported) { stallReported = true; onStall && onStall(); }
    }, 1000);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && started) video.play().catch(() => {}); });

  // ---------- Каждый кадр отрисовки ----------
  const qOut = new THREE.Quaternion(), pOut = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  function frame(now) {
    if (!started) return;
    if (!hasRVFC) pollFrame(now);
    if (frozen) { needRender = true; return; }
    if (vf.fresh && video.videoWidth && video.readyState >= 2) {
      const sz = video.videoWidth + 'x' + video.videoHeight;
      if (sz !== texSize) { if (texSize) ring.forEach((r) => { r.tex.dispose(); r.n = -1; }); texSize = sz; }
      ringI = (ringI + 1) % ring.length;
      const r = ring[ringI];
      r.tex.needsUpdate = true; renderer.initTexture(r.tex);
      r.n = vf.n; r.tf = vf.t; r.ta = vf.last;
      vf.fresh = false;
    }
    // какой кадр показать: самый свежий из пришедших не позже delayMs назад (а если уже есть распознавание «после» него — можно и свежее)
    let pick = null;
    for (const r of ring) if (r.n >= 0 && (now - r.ta >= delayMs || core.covered(r.tf)) && (!pick || r.n > pick.n)) pick = r;
    if (!pick) for (const r of ring) if (r.n >= 0 && (!pick || r.n < pick.n)) pick = r;
    if (pick && pick !== shownSlot) { shownSlot = pick; bg.material.map = pick.tex; bg.visible = true; needRender = true; }
    else needRender = now - lastRenderT > 66;
    if (needRender) lastRenderT = now;
    if (!shownSlot) return;
    const ok = core.poseAt(shownSlot.tf, qOut, pOut);
    if (ok) {
      content.matrix.compose(pOut, qOut, one); content.matrixWorldNeedsUpdate = true;
      if (gaps.lastPose) gaps.pose = Math.max(gaps.pose, now - gaps.lastPose);
      gaps.lastPose = now;
    }
    if (ok !== content.visible) { content.visible = ok; needRender = true; }
    if (ok && !wasShown) onFound && onFound();
    if (!ok && wasShown) onLost && onLost();
    wasShown = ok;
  }

  // ---------- Запись для разбора (режим разработчика) ----------
  async function saveRecord() {
    const trk = stream && stream.getVideoTracks()[0], cs = trk && trk.getSettings ? trk.getSettings() : {};
    const data = { build: VER, engine: 'cam', ua: navigator.userAgent, camSettings: { w: cs.width, h: cs.height, fps: cs.frameRate }, at: new Date().toISOString(),
      cam: [vw, vh], f: f0, lag: 0, raw: { o: [], m: [], det: REC.det, frames: REC.frames } };
    const name = 'ar-zapis-kamera-' + new Date().toISOString().slice(11, 19).replace(/:/g, '-') + '.json';
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    try {
      const file = new File([blob], name, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  if (opts.DEV) {
    const b = document.createElement('button');
    b.textContent = 'Сохранить запись';
    Object.assign(b.style, { position: 'fixed', left: '8px', bottom: 'calc(env(safe-area-inset-bottom, 0px) + 120px)', zIndex: '30',
      padding: '8px 12px', borderRadius: '10px', border: '0', background: 'rgba(200,60,60,.85)', color: '#fff', font: '14px system-ui' });
    b.addEventListener('click', (ev) => { ev.stopPropagation(); saveRecord(); });
    document.body.appendChild(b);
  }

  function markerState() {
    if (content.visible) return 'найден' + (core.st.dist ? `, ${(core.st.dist * BOARDM * 100).toFixed(0)} см` : '');
    return 'не найден';
  }
  function devText() {
    const now = performance.now(), dt = Math.max(0.2, (now - secT) / 1000);
    const d = {}; for (const k in sec) d[k] = sec[k] - (secSnap[k] || 0);
    secSnap = { ...sec }; secT = now;
    const per = (v) => (v / dt).toFixed(0);
    const trk = stream && stream.getVideoTracks()[0], fr = trk && trk.getSettings ? trk.getSettings().frameRate : null;
    return `движок: ТОЛЬКО ПО КАМЕРЕ (без датчиков)\n` +
      `камера ${vw}×${vh} ${fr ? Math.round(fr) + ' к/с' : ''}, новых ${per(d.frames)}/с (время ${vf.mode})\n` +
      `поиск ${per(d.res)}/с: ${d.res ? (d.ms / d.res).toFixed(1) : '—'} мс в фоне + захват ${d.sent ? (d.grabMs / d.sent).toFixed(1) : '—'} мс (${grabMode === 'bitmap' ? 'картинкой' : 'пикселями'})\n` +
      `  ${roiTxt}  меток ${lastTags}${lastSide ? ' (сторона ' + lastSide.toFixed(0) + ' px)' : ''}  нашёл ${per(d.found)}/с  ошибка углов ${lastErr.toFixed(2)} px\n` +
      `показ с задержкой ${delayMs.toFixed(0)} мс (распознавание ${lat.toFixed(0)} + промежуток ${interval.toFixed(0)} мс)\n` +
      `лист: ${markerState()}\n`;
  }

  return {
    engine: 'cam', renderer, scene, camera, content, video,
    async start() { await openCamera(); startVision(); if (hasRVFC) video.requestVideoFrameCallback(onVideoFrame); started = true; watchdog(); layout(true); return video; },
    frame,
    get needRender() { return needRender; },
    get frames() { return vf.n; },
    get shownFrame() { return shownSlot ? shownSlot.n : -1; },
    get f() { return f0; },
    get shown() { return content.visible; },
    get frozen() { return frozen; },
    get restarting() { return false; },
    get loops() { return loops; },
    get markerState() { return markerState(); },
    devText,
    takeGaps() { const g = { pose: gaps.pose, proc: gaps.proc }; gaps.pose = gaps.proc = 0; return g; },
    gravityInContent() { return false; },          // ось Земли — перпендикулярно листу
    setFrozen(on) { if (on === frozen) return; frozen = on && content.visible; if (!frozen) busy = false; },
    setPaused(on) { paused = on; if (!on) setTimeout(() => layout(true), 300); },
    setLite(on) {
      const trk = stream && stream.getVideoTracks()[0];
      if (trk && trk.applyConstraints) trk.applyConstraints({ width: { ideal: CAMW }, height: { ideal: CAMH }, frameRate: { ideal: on ? 24 : CAMFPS } }).catch(() => {});
    },
  };
}
