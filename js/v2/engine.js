// Движок 2 — трекинг под слабые телефоны.
//
// Чем отличается от первого (MindAR):
//  • Видео с камеры рисуем сами, и сцену ставим по ориентации телефона РОВНО на момент съёмки этого кадра.
//    Поэтому сцена не «плавает» и не отстаёт от видео — даже если распознавание медленное.
//  • Поворот телефона берётся из гироскопа (каждый кадр, бесплатно). Сдвиг — из акселерометра
//    на доли секунды между распознаваниями. Распознавание листа только поправляет, где лист лежит в комнате.
//  • Распознавание — в отдельном фоновом потоке и только на небольшом участке кадра вокруг листа,
//    уменьшенном до ~240×320. Сколько раз в секунду успеет телефон — столько и хорошо: 5 раз тоже работает.
//  • Задержка кадра и угол обзора камеры подбираются сами, по ходу (без перезагрузки).
// Наружу — тот же набор, что у первого движка: renderer, scene, camera, content (ширина листа = 1, Z — вверх от листа).
import * as THREE from 'three';
import { createSensors } from './sensors.js?v=6.6';
import { createFusion } from './fusion.js?v=6.6';

const VER = '6.6';
const CAL_KEY = 'ar-earth-v2-cal-5.1';   // новая версия подбора обзора — старые (смещённые) значения не берём

export function createEngine2(opts) {
  const { container, onFound, onLost, onStall, FOV = 66, CAMFPS = 60, MAXPIX = 76800, BOARDM = 0.18, BG = 'gl',
    SKIPBLUR = 30, KEEP = 8000, TT0 = 0, BUDGET = 0, DELAY = -1, MAXDELAY = 140, LOCK = 0.7, DUTY = 1, FILT = '', ROIFIX = 1, CAMW = 640, CAMH = 480, EURO = 0, LAG = null, SMOOTHCLK = false, GRAB = 'auto', AA = true, AUTOCAL = true, NATIVELAG = 60 } = opts;

  // ---------- Рисование ----------
  const renderer = new THREE.WebGLRenderer({ antialias: AA, alpha: BG === 'native', powerPreference: 'default' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  if (BG === 'native') renderer.setClearColor(0x000000, 0);
  const video = document.createElement('video');
  video.setAttribute('playsinline', ''); video.setAttribute('muted', ''); video.muted = true; video.autoplay = true;
  Object.assign(video.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'cover', zIndex: '0' });
  Object.assign(renderer.domElement.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', zIndex: '1' });
  container.appendChild(video);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.02, 100);
  const content = new THREE.Group();
  content.matrixAutoUpdate = false;
  content.visible = false;
  scene.add(content);

  // фон — кадр камеры как текстура (обновляем только когда пришёл новый кадр)
  // Несколько последних кадров храним в видеопамяти (кольцо): показываем кадр с небольшой задержкой — когда
  // для него уже готово распознавание. Тогда сцена ставится по фактическому положению листа на этом самом кадре,
  // а не по прогнозу: вблизи мелкие сдвиги руки (их не предскажешь) больше не дают дрожи.
  const RING = 8;
  const mkTex = () => {
    const t = new THREE.Texture(video);
    // помечаем как видео: three.js тогда не выделяет «неизменяемое» хранилище по размеру элемента (у <video> он 0×0),
    // а обновляем текстуру сами — только на новом кадре (поэтому update() пустой)
    t.isVideoTexture = true; t.update = () => {};
    t.colorSpace = THREE.SRGBColorSpace; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
    return t;
  };
  const ring = Array.from({ length: DELAY === 0 ? 1 : RING }, () => ({ tex: mkTex(), n: -1, tf: 0, ta: 0 }));
  let ringI = -1, shownSlot = null;
  const vtex = ring[0].tex;
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: vtex, depthTest: false, depthWrite: false, toneMapped: false }));
  bg.renderOrder = -1000; bg.frustumCulled = false; bg.visible = false;
  if (BG === 'gl') scene.add(bg);

  // ---------- Датчики и слияние ----------
  const sensors = createSensors();
  let saved = {};
  // ?resetcal=1 — забыть подобранные задержку и угол обзора (если подбор однажды ушёл не туда)
  if (opts.RESETCAL) try { localStorage.removeItem(CAL_KEY); } catch (e) {}
  try { saved = JSON.parse(localStorage.getItem(CAL_KEY) || '{}') || {}; } catch (e) {}
  const fusion = createFusion({ sensors, boardM: BOARDM, lag: LAG ?? 50, autoLag: AUTOCAL, autoF: AUTOCAL, lock: DELAY === 0 ? 0 : LOCK, force: FILT || undefined, euroMin: EURO, lockMode: opts.LOCKMODE || 'frame', fewTags: !!opts.FEWTAGS, visMode: opts.VISMODE || 'auto' });

  // ---------- Состояние ----------
  let started = false, paused = false, frozen = false, frozenWant = false;
  let vw = 0, vh = 0, f0 = 0, lastF = 0, layoutKey = '';
  const vf = { t: 0, n: 0, fresh: false, mode: '—', last: 0 };   // последний кадр камеры
  let needRender = true, lastRenderT = 0, wasShown = false, texSize = '';
  const stats = { updates: 0, rejected: 0, fused: 0, imuAngSum: 0, imuN: 0, newFrames: 0, dups: 0, redetect: 0, coast: 0, pred: 0, jerks: 0 };
  const sec = { frames: 0, sent: 0, res: 0, found: 0, blurSkip: 0, dutySkip: 0, procMs: 0, grabMs: 0, readMs: 0, tags: 0, side: 0, roi: '', err: 0, fails: 0 };
  let secSnap = { ...sec }, secT = performance.now();
  const gaps = { pose: 0, proc: 0, lastPose: 0, lastProc: 0 };
  let visionLoops = 0;

  // ---------- Распознавание (фоновый поток или, если нельзя, здесь же) ----------
  let worker = null, workerOk = false, localDetect = null, busy = false, busySince = 0, frameId = 0;
  const grabCv = document.createElement('canvas');
  const grabCtx = grabCv.getContext('2d', { willReadFrequently: true });
  const freeBufs = [];
  // 'bitmap' — кадр отдаём потоку картинкой (пиксели читает он, основной поток свободен; нужен OffscreenCanvas в потоке),
  // 'pixels' — читаем пиксели здесь (работает везде, но это 2–8 мс основного потока на кадр)
  let grabMode = GRAB === 'auto' ? (typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function' ? 'bitmap' : 'pixels') : GRAB;
  let bitmapFails = 0, bitmapProbed = false, lastTagsT = 0;
  const bitmapSince = performance.now();
  let searchFlip = 0, lastGrabMs = 0, nextSendT = 0, roiFails = 0, roiUsed = false;

  function startVision() {
    try {
      worker = new Worker(new URL('./vision-worker.js?v=' + VER, import.meta.url), { type: 'module' });
      const t0 = performance.now();
      worker.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === 'ready') { workerOk = true; console.log('[движок 2] фоновый поток готов за', Math.round(performance.now() - t0), 'мс'); return; }
        if (m.type === 'fail') { console.warn('[движок 2] фоновый поток не запустился:', m.msg); fallbackLocal(); return; }
        onResult(m);
      };
      worker.onerror = (e) => { console.warn('[движок 2] ошибка фонового потока:', e.message || e); if (!workerOk) fallbackLocal(); };
      setTimeout(() => { if (!workerOk && !localDetect) { console.warn('[движок 2] фоновый поток молчит — распознаю в основном'); fallbackLocal(); } }, 4000);
    } catch (e) { console.warn('[движок 2] фоновые потоки недоступны:', e); fallbackLocal(); }
  }
  async function fallbackLocal() {
    if (localDetect) return;
    try { if (worker) worker.terminate(); } catch (e) {}
    worker = null; workerOk = false; grabMode = 'pixels';
    const m = await import('./detect.js?v=' + VER);
    localDetect = m.createDetector();
    busy = false;
  }

  // какой участок кадра смотреть и в каком масштабе
  // Сторона метки на уменьшенном участке, пиксели. 22 — хватает, чтобы прочитать код, но углы точнее при большей:
  // вблизи участок сильно уменьшается, и шум углов в пикселях видео растёт — сцена дрожит.
  // Поэтому чёткость подстраивается под телефон: успевает быстро — смотрим подробнее (до 44), не успевает — грубее (до 18).
  let TARGET_TAG = TT0 || 26;
  const qual = { t: performance.now(), ms: 0, n: 0 }; let qualAvg = 0;
  function adaptQuality(ms) {
    qual.ms += ms; qual.n++;
    const now = performance.now();
    if (now - qual.t < 1000 || qual.n < 3) return;
    const avg = qual.ms / qual.n; qual.ms = 0; qual.n = 0; qual.t = now; qualAvg = avg;
    if (TT0) return;
    // Распознавание идёт в фоновом потоке (другое ядро) — ему можно отдать почти весь промежуток между кадрами.
    // Шум углов важнее частоты: при показе с задержкой кадры между распознаваниями сглаживаются, а шумные — дрожат.
    const frameMs = Math.max(33, clk.T || 33);
    const budget = BUDGET > 0 ? BUDGET : frameMs * 0.7;
    if (avg < budget * 0.6 && TARGET_TAG < 48) TARGET_TAG = Math.min(48, TARGET_TAG + 3);
    else if (avg > budget && TARGET_TAG > 18) TARGET_TAG -= 3;
  }
  function planRoi(tf) {
    let sx = 0, sy = 0, sw = vw, sh = vh, scale;
    // Ищем вокруг предсказанного места. Но если там уже не нашлось (лист быстро сдвинули, прогноз отстал) —
    // в следующий раз смотрим шире, а после второй неудачи — по всему кадру (раньше ждали 0,6 с — это и были «сносы»
    // на слабом телефоне: распознавание раз за разом смотрело мимо листа).
    const tracking = fusion.st.init && performance.now() - fusion.st.lastMeas < 600 && (!ROIFIX || roiFails < 2);
    const pc = tracking ? fusion.predictCorners(tf) : null;
    roiUsed = !!pc;
    if (pc) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of pc) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      const side = (Math.hypot(pc[1][0] - pc[0][0], pc[1][1] - pc[0][1]) + Math.hypot(pc[2][0] - pc[1][0], pc[2][1] - pc[1][1]) +
        Math.hypot(pc[3][0] - pc[2][0], pc[3][1] - pc[2][1]) + Math.hypot(pc[0][0] - pc[3][0], pc[0][1] - pc[3][1])) / 4;
      // запас: четверть размера листа + насколько лист сдвинулся по прогнозу за последние ~120 мс (быстрее движется — шире)
      const pp = fusion.predictCorners(tf - 120);
      let mv = 0;
      if (pp) for (let i = 0; i < 4; i++) mv = Math.max(mv, Math.hypot(pc[i][0] - pp[i][0], pc[i][1] - pp[i][1]));
      const m = ROIFIX ? (Math.max(x1 - x0, y1 - y0) * 0.25 + 24 + mv) * (1 + roiFails) : Math.max(x1 - x0, y1 - y0) * 0.25 + 24;
      sx = Math.max(0, Math.floor(x0 - m)); sy = Math.max(0, Math.floor(y0 - m));
      sw = Math.min(vw, Math.ceil(x1 + m)) - sx; sh = Math.min(vh, Math.ceil(y1 + m)) - sy;
      if (sw < 48 || sh < 48) { sx = 0; sy = 0; sw = vw; sh = vh; }
      scale = Math.min(1, TARGET_TAG / Math.max(4, side * 0.28));
    } else {
      // ищем по всему кадру: попеременно обычный и более крупный масштаб (дальний лист мелкий)
      searchFlip ^= 1;
      const slow = qualAvg > 18;              // фоновый поток и так нагружен — крупный масштаб не берём
      scale = Math.sqrt(MAXPIX / (vw * vh)) * (searchFlip && !slow ? 1.5 : 1);
    }
    scale = Math.min(scale, 1);
    let dw = Math.max(32, Math.round(sw * scale)), dh = Math.max(32, Math.round(sh * scale));
    const cap = pc ? Math.min(MAXPIX * (TARGET_TAG / 22) ** 2, 260000) : MAXPIX * 2.25;
    if (dw * dh > cap) { const k = Math.sqrt(cap / (dw * dh)); dw = Math.max(32, Math.round(dw * k)); dh = Math.max(32, Math.round(dh * k)); }
    return { sx, sy, sw, sh, dw, dh };
  }

  function sendFrame(tf) {
    if (busy || paused || frozen || !vw) return;
    if (!workerOk && !localDetect) return;
    // Фоновый поток не должен занимать процессор целиком: у старых телефонов всего 2 быстрых ядра, и если
    // распознавание молотит без передышки, основной поток (сцена, датчики) начинает подвисать — как раз на резких
    // движениях, когда лист теряется и поиск идёт по всему кадру. Поэтому после каждого распознавания — пауза той же длины.
    if (performance.now() < nextSendT) { sec.dutySkip++; return; }
    // сильный смаз (телефон резко поворачивают): кадр всё равно не распознается — не тратим силы,
    // сцену в это время держит гироскоп
    if (fusion.st.init && sensors.hasOrientation) {
      const blur = sensors.rateAt(tf - fusion.lag) * 0.016 * fusion.f;
      if (blur > SKIPBLUR && performance.now() - fusion.st.lastMeas < 1500) { sec.blurSkip++; return; }
    }
    const r = planRoi(tf);
    const map = { sx: r.sx, sy: r.sy, kx: r.sw / r.dw, ky: r.sh / r.dh };
    sec.roi = r.dw + '×' + r.dh + (r.sw < vw || r.sh < vh ? ' (участок)' : '');
    const id = ++frameId;
    busy = true; busySince = performance.now();
    sentTa.set(id, vf.last);
    const t0 = performance.now();
    if (grabMode === 'bitmap' && worker && workerOk) {
      createImageBitmap(video, r.sx, r.sy, r.sw, r.sh, { resizeWidth: r.dw, resizeHeight: r.dh, resizeQuality: 'low' }).then((bmp) => {
        lastGrabMs = 0; sec.grabMs += callMs;
        worker.postMessage({ type: 'frame', id, tFrame: tf, w: r.dw, h: r.dh, map, bitmap: bmp }, [bmp]);
        sec.sent++;
      }).catch((e) => { console.warn('[движок 2] картинка кадра не получилась — читаю пиксели сам:', e); grabMode = 'pixels'; busy = false; });
      const callMs = performance.now() - t0;
      return;
    }
    if (grabCv.width !== r.dw || grabCv.height !== r.dh) { grabCv.width = r.dw; grabCv.height = r.dh; }
    grabCtx.drawImage(video, r.sx, r.sy, r.sw, r.sh, 0, 0, r.dw, r.dh);
    const img = grabCtx.getImageData(0, 0, r.dw, r.dh);
    lastGrabMs = performance.now() - t0;
    sec.grabMs += lastGrabMs;
    sec.sent++;
    if (worker && workerOk) {
      worker.postMessage({ type: 'frame', id, tFrame: tf, w: r.dw, h: r.dh, map, data: img.data }, [img.data.buffer]);
    } else if (localDetect) {
      setTimeout(() => {
        const t1 = performance.now();
        let res;
        try { res = localDetect(img.data, r.dw, r.dh, map); } catch (e) { res = { n: 0, tags: 0, side: 0 }; console.warn(e); }
        onResult({ type: 'res', id, tFrame: tf, ms: performance.now() - t1, readMs: 0, w: r.dw, h: r.dh, ...res });
      }, 0);
    }
  }

  function flushMotion() { for (const m of sensors.takeMotion()) fusion.motion(m.t, m.acc, m.accG); }

  // задержка показа: сколько обычно проходит от прихода кадра до готового распознавания (+ запас)
  const sentTa = new Map();
  let visLat = 40, delayMs = DELAY > 0 ? DELAY : 0, measInt = 50, lastFoundT = 0;
  function onResult(m) {
    busy = false;
    const ta = sentTa.get(m.id); sentTa.delete(m.id);
    if (ta) {
      const L = performance.now() - ta;
      visLat += (L - visLat) * (L > visLat ? 0.3 : 0.05);         // вверх быстро, вниз медленно
      // задержку показа меняем редко и ступеньками: если она «гуляет» от кадра к кадру, кадры идут неровно
      if (DELAY < 0) {
        // Камера со стабилизацией (многие Android): сцена ставится «по кадру» — между соседними распознаваниями.
        // Для этого к моменту показа кадра должно быть готово и СЛЕДУЮЩЕЕ распознавание: задержка больше на промежуток
        // между распознаваниями (по прогону записи с Android: ошибка 5,6 → 2,1 px при задержке ~110 мс).
        const target = Math.min(MAXDELAY, visLat + 8 + (fusion.st.eis ? 1.3 * measInt : 0));
        if (target > delayMs + 4 || target < delayMs - 12) delayMs += (target - delayMs) * 0.5;
      }
    }
    if (m.type === 'err') {
      sec.fails++;
      if (grabMode === 'bitmap' && ++bitmapFails >= 2) { grabMode = 'pixels'; console.warn('[движок 2] поток не читает картинку кадра — читаю пиксели сам:', m.msg); }
      return;
    }
    const now = performance.now();
    visionLoops++; sec.res++;
    sec.procMs += m.ms; sec.readMs += m.readMs || 0;
    nextSendT = now + Math.max(0, m.ms * DUTY - 4);
    adaptQuality(worker && workerOk ? m.ms : m.ms + lastGrabMs);
    if (gaps.lastProc) gaps.proc = Math.max(gaps.proc, now - gaps.lastProc);
    gaps.lastProc = now;
    sec.tags = m.tags; sec.side = m.side; sec.err = m.err || 0;
    if (m.tags > 0) lastTagsT = now;
    if (grabMode === 'bitmap' && GRAB === 'auto' && !bitmapProbed && now - Math.max(lastTagsT, bitmapSince) > 5000) {
      // картинкой ничего не находится 5 с — возможно, браузер отдаёт пустую картинку: пробуем пикселями
      bitmapProbed = true; grabMode = 'pixels';
      console.warn('[движок 2] картинкой метки не находятся — пробую читать пиксели');
    }
    if (opts.RAW) {      // сырая запись распознаваний
      RAWD.push({ tf: +m.tFrame.toFixed(1), t: Math.round(now), n: m.n || 0, tags: m.tags || 0, err: m.err ? +m.err.toFixed(3) : 0, ms: +m.ms.toFixed(1),
        H: m.H ? m.H.map((v) => +v.toPrecision(7)) : null, pts: m.pts ? Array.from(m.pts, (v) => +v.toFixed(3)) : null });
      if (RAWD.length > 1500) RAWD.shift();
    }
    if (m.tags > 0 && m.n >= 4) roiFails = 0; else if (roiUsed) roiFails++;
    if (!(m.n >= 4)) recordFail(now, m);
    if (frozen || paused || !m.n || m.n < 4) return;
    // первое нахождение (и после долгой потери) — минимум по двум меткам: одну метку легче спутать с узором
    const lost = !fusion.st.init || now - fusion.st.lastMeas > 1500;
    if (lost && m.tags < 2) return;
    if (lost && fusion.st.init) fusion.reacquire();
    flushMotion();
    const r = fusion.measure({ tFrame: m.tFrame, pts: m.pts, n: m.n, H: m.H, err: m.n >= 8 ? m.err : null });
    if (r.ok) {
      stats.updates++; sec.found++;
      if (lastFoundT) measInt += (Math.min(250, now - lastFoundT) - measInt) * 0.1;
      lastFoundT = now;
    } else stats.rejected++;
    record(now, m, r);
    if (AUTOCAL) fusion.calibStep(now);
    saveCal(now);
  }

  // подобранные задержку и угол обзора запоминаем — со следующего запуска начнём с них (подбор всё равно идёт)
  let lastSave = 0;
  function saveCal(now) {
    if (now - lastSave < 5000) return;
    const c = fusion.st.calib;
    if (c.lagRuns + c.fRuns === 0 && !fusion.st.eis) return;
    lastSave = now;
    try { localStorage.setItem(CAL_KEY, JSON.stringify({ lag: Math.round(fusion.lag), fov: +fusion.fov.toFixed(1), mode: vf.mode, eis: fusion.st.eis && performance.now() - fusion.st.eisSince > 10000, eisV: 2, at: new Date().toISOString() })); } catch (e) {}
  }

  // ---------- Кадры камеры ----------
  const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  function onVideoFrame(now, md) {
    // время кадра: момент съёмки (если браузер его даёт), иначе — когда кадр пришёл; в крайнем случае — время вызова
    const pn = performance.now(), ok = (v) => typeof v === 'number' && v > pn - 500 && v <= pn + 2;
    let tf = now, mode = 'кадр';
    if (md && ok(md.captureTime)) { tf = md.captureTime; mode = 'съёмки'; }
    else if (md && ok(md.presentationTime)) { tf = md.presentationTime; mode = 'показа'; }
    if (mode !== vf.mode) {
      // способ отметки времени сменился (или первый кадр): начальная задержка — сохранённая для этого способа или по умолчанию
      if (vf.mode === '—' && LAG == null) {
        const L = saved.mode === mode && Number.isFinite(saved.lag) ? saved.lag : (mode === 'съёмки' ? -10 : 40);
        fusion.st.lag = L;
      }
      vf.mode = mode;
    }
    onFrame(SMOOTHCLK ? smoothClock(tf) : tf);
    video.requestVideoFrameCallback(onVideoFrame);
  }
  // Камера снимает кадры через равные промежутки, а до страницы они доходят неровно (±5–15 мс — как успеет
  // браузер). Неровность во времени = дрожь сцены при поворотах. Поэтому время кадра «выравниваем»:
  // держим ровные часы с шагом кадра и лишь слегка подтягиваем их к фактическому времени прихода.
  const clk = { t: 0, T: 0, n: 0 };
  function smoothClock(tf) {
    if (!clk.n) { clk.t = tf; clk.n = 1; return tf; }
    const d = tf - clk.t;
    if (!clk.T) { if (d > 5 && d < 200) clk.T = d; clk.t = tf; clk.n++; return tf; }
    const k = Math.max(1, Math.round(d / clk.T));                  // кадры могли пропасть
    const pred = clk.t + k * clk.T, e = tf - pred;
    if (Math.abs(e) > clk.T * 0.6 || d <= 0 || k > 6) { clk.t = tf; clk.n++; return tf; }   // сбились — начинаем заново
    clk.T += 0.02 * e / k;                                          // шаг кадра уточняем медленно
    clk.t = pred + 0.15 * e;
    // часы не должны «уплывать» в будущее относительно прихода кадра
    if (clk.t > tf + 2) clk.t = tf + 2;
    clk.n++;
    return clk.t;
  }
  let lastVT = -1;
  function pollFrame(now) {         // без requestVideoFrameCallback: замечаем смену кадра по времени видео
    if (video.currentTime !== lastVT) { lastVT = video.currentTime; vf.mode = 'кадр*'; onFrame(now); }
  }
  function onFrame(tf) {
    vf.t = tf; vf.n++; vf.fresh = true; vf.last = performance.now();
    if (opts.RAW) { RAWF.push([+tf.toFixed(1), Math.round(vf.last)]); if (RAWF.length > 4000) RAWF.shift(); }
    sec.frames++; stats.newFrames++;
    if (!frozen) sendFrame(tf);
  }

  // ---------- Раскладка: проекция камеры под обрезку видео экраном ----------
  function layout(force) {
    const cw = container.clientWidth || window.innerWidth, ch = container.clientHeight || window.innerHeight;
    if (!vw || !cw || !ch) return;
    const f = fusion.f;
    const key = cw + 'x' + ch + ':' + vw + 'x' + vh + ':' + f.toFixed(1);
    if (!force && key === layoutKey) return;
    layoutKey = key;
    renderer.setSize(cw, ch, false);
    const s = Math.max(cw / vw, ch / vh), fs = f * s;
    camera.fov = 2 * Math.atan(ch / 2 / fs) * 180 / Math.PI;
    camera.aspect = cw / ch;
    camera.updateProjectionMatrix();
    const D = 50;
    bg.position.set(0, 0, -D); bg.scale.set(D * cw / fs, D * ch / fs, 1);
    const rx = cw / (s * vw), ry = ch / (s * vh);
    for (const r of ring) { r.tex.repeat.set(rx, ry); r.tex.offset.set((1 - rx) / 2, (1 - ry) / 2); }
    lastF = f;
  }
  function onVideoSize() {
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h || (w === vw && h === vh)) return;
    const first = !vw;
    vw = w; vh = h;
    if (first) {
      const fov = Number.isFinite(saved.fov) && opts.FOV == null ? saved.fov : FOV;
      f0 = (Math.max(w, h) / 2) / Math.tan(fov * Math.PI / 360);
      fusion.setCamera(w, h, f0);
      if (saved.eis && saved.eisV === 2 && opts.VISMODE !== 'off') { fusion.st.eis = true; fusion.st.eisSince = performance.now(); }
    } else {
      fusion.setCamera(w, h);            // кадр повернулся: фокус в пикселях тот же, позу ищем заново
      fusion.reset();
    }
    console.log('[движок 2] кадр', w + '×' + h, ', угол обзора', fusion.fov.toFixed(1) + '°');
    layout(true);
  }
  video.addEventListener('resize', onVideoSize);
  video.addEventListener('loadedmetadata', onVideoSize);
  window.addEventListener('resize', () => setTimeout(() => layout(true), 50));

  // ---------- Камера ----------
  let stream = null;
  async function openCamera(fps) {
    const c = { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: CAMW }, height: { ideal: CAMH }, frameRate: { ideal: fps } } };
    stream = await navigator.mediaDevices.getUserMedia(c);
    video.srcObject = stream;
    await video.play().catch(() => {});
    const t0 = performance.now();
    while (!video.videoWidth && performance.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 30));
    onVideoSize();
  }

  // ---------- Сторож: камера перестала присылать кадры ----------
  let stalls = 0, stallReported = false;
  function watchdog() {
    setInterval(async () => {
      if (!started || paused || frozen || document.hidden) { stalls = 0; return; }
      if (busy && performance.now() - busySince > 3000) { busy = false; sec.fails++; }     // поток не ответил — не ждём вечно
      if (performance.now() - vf.last < 2000) { stalls = 0; return; }
      stalls++;
      console.warn('[движок 2] нет кадров с камеры', stalls);
      video.play().catch(() => {});
      if (stalls === 3) {
        try { stream && stream.getTracks().forEach((t) => t.stop()); await openCamera(CAMFPS); } catch (e) { console.warn(e); }
      }
      if (stalls >= 6 && !stallReported) { stallReported = true; onStall && onStall(); }
    }, 1000);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && started) video.play().catch(() => {}); });

  // ---------- Поза каждый кадр ----------
  const qOut = new THREE.Quaternion(), pOut = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  function frame(now) {
    if (!started) return;
    if (lastFrameNow) frameGapMax = Math.max(frameGapMax, now - lastFrameNow);
    lastFrameNow = now;
    if (!hasRVFC) pollFrame(now);
    if (frozen) { needRender = true; content.visible = frozenWant; return; }
    flushMotion();
    if (Math.abs(fusion.f - lastF) > 0.5) layout();
    let tDisp;
    if (BG === 'gl') {
      if (vf.fresh && video.videoWidth && video.readyState >= 2) {
        // размер кадра сменился (или первый кадр) — текстуры пересоздаём: у WebGL размер хранилища фиксирован
        const sz = video.videoWidth + 'x' + video.videoHeight;
        if (sz !== texSize) { if (texSize) ring.forEach((r) => { r.tex.dispose(); r.n = -1; }); texSize = sz; }
        ringI = (ringI + 1) % ring.length;
        const r = ring[ringI];
        r.tex.needsUpdate = true; renderer.initTexture(r.tex);     // загружаем в видеопамять сразу, пока кадр в <video> этот
        r.n = vf.n; r.tf = vf.t; r.ta = vf.last;
        vf.fresh = false;
      }
      // какой кадр показать: самый свежий из тех, что пришли не позже, чем delayMs назад
      let pick = null;
      // …и только тот, для момента съёмки которого уже есть показания гироскопа: на слабом телефоне при резких движениях
      // основной поток подвисает, события датчиков приходят с опозданием — лучше показать кадр чуть старее,
      // чем ставить сцену по угаданному повороту
      const sT = sensors.lastT;
      const covered = (r) => !sensors.hasOrientation || r.tf - fusion.lag - 20 <= sT;
      for (const r of ring) if (r.n >= 0 && (now - r.ta >= delayMs || ring.length === 1) && covered(r) && (!pick || r.n > pick.n)) pick = r;
      if (!pick) for (const r of ring) if (r.n >= 0 && (now - r.ta >= delayMs || ring.length === 1) && (!pick || r.n > pick.n)) pick = r;
      if (!pick) for (const r of ring) if (r.n >= 0 && (!pick || r.n < pick.n)) pick = r;      // все слишком свежие — самый старый
      if (pick && pick !== shownSlot) {
        shownSlot = pick; bg.material.map = pick.tex; bg.visible = true; needRender = true;
        bg.material.needsUpdate = false;
      } else needRender = now - lastRenderT > 66;           // кадр тот же — всё равно перерисовка не реже 15 раз/с
      tDisp = shownSlot ? shownSlot.tf : vf.t;
    } else { tDisp = now - NATIVELAG; needRender = true; }
    if (needRender) lastRenderT = now;
    const ok = fusion.poseAt(tDisp, qOut, pOut, now);
    if (ok) {
      content.matrix.compose(pOut, qOut, one);
      content.matrixWorldNeedsUpdate = true;
      if (gaps.lastPose) gaps.pose = Math.max(gaps.pose, now - gaps.lastPose);
      gaps.lastPose = now;
    }
    // Лист не распознаётся: если по расчёту он в кадре — значит, закрыт или поза неверна: через 1,5 с прячем.
    // Если лист вне кадра (смотрят на Землю вблизи, без листа) — держим сцену дольше (KEEP): гироскоп её удерживает.
    const age = now - fusion.st.lastMeas;
    const want = ok && (age < 1500 || (age < KEEP && !boardInView(tDisp)));
    if (want !== content.visible) content.visible = want;
    if (want && !wasShown) onFound && onFound();
    if (!want && wasShown) onLost && onLost();
    wasShown = want;
  }

  function boardInView(t) {
    const pc = fusion.predictCorners(t);
    if (!pc) return false;
    let x = 0, y = 0;
    for (const c of pc) { x += c[0] / 4; y += c[1] / 4; }
    return x > vw * 0.1 && x < vw * 0.9 && y > vh * 0.1 && y < vh * 0.9;
  }

  // ---------- Запись для разбора «сносов» (режим разработчика) ----------
  // По каждому распознаванию: насколько сцена разошлась с листом (по прогнозу, до поправки) и что в этот момент
  // происходило: скорость поворота, смаз, опоздание датчиков, выбранный фильтр, задержки, паузы основного потока.
  // Кнопка «Сохранить запись» отдаёт последние ~30 с файлом — его можно прислать для разбора.
  const REC = [], SLIDE_PX = 12, RAWD = [], RAWF = [];
  if (opts.RAW) sensors.recordRaw(true);
  let slides = 0, slideMax = 0, lastFrameNow = 0, frameGapMax = 0;
  function record(now, m, r) {
    const F = fusion.st, D = F.diag;
    const e = {
      t: Math.round(now), tf: Math.round(m.tFrame), ok: r.ok ? 1 : 0, why: r.why || (r.reset ? 'сброс' : ''),
      snos: D.innovPx != null ? +D.innovPx.toFixed(1) : null, ang: D.innovDeg != null ? +D.innovDeg.toFixed(2) : null,
      rate: Math.round((D.rate || 0) * 57.3), blur: +(D.blur || 0).toFixed(1), tags: m.tags, err: +(m.err || 0).toFixed(2),
      ms: +m.ms.toFixed(1), lat: Math.round(now - (vf.last || now)), sensAge: Math.round(now - sensors.lastT),
      filt: F.filt, lag: Math.round(fusion.lag), fov: +fusion.fov.toFixed(1), delay: Math.round(delayMs), lock: +(D.lockW || 0).toFixed(2),
      all: D.innovAll || null, gap: Math.round(frameGapMax), res: F.resets, rej: D.rej, sEv: Math.round(fusion.signEv || 0), g: fusion.gSign,
    };
    frameGapMax = 0;
    REC.push(e); if (REC.length > 900) REC.shift();
    if (e.snos != null && e.snos > SLIDE_PX) { slides++; slideMax = Math.max(slideMax, e.snos); }
  }
  function recordFail(now, m) {
    REC.push({ t: Math.round(now), tf: Math.round(m.tFrame), ok: 0, why: 'не найден', tags: m.tags || 0, ms: +(m.ms || 0).toFixed(1),
      rate: Math.round(sensors.rateAt(m.tFrame - fusion.lag) * 57.3), roi: roiUsed ? 1 : 0, roiFails, filt: fusion.st.filt });
    if (REC.length > 900) REC.shift();
  }
  async function saveRecord() {
    const sd = sensors.diag;
    const trk = stream && stream.getVideoTracks()[0], cs = trk && trk.getSettings ? trk.getSettings() : {};
    const data = { build: VER, ua: navigator.userAgent, camSettings: { w: cs.width, h: cs.height, fps: cs.frameRate }, at: new Date().toISOString(), cam: [vw, vh], tsMode: vf.mode, tt: TARGET_TAG,
      grab: grabMode, sensors: { ...sd }, rs: fusion.rs, arm: fusion.arm, rec: REC,
      f: fusion.f, lag: fusion.lag, raw: opts.RAW ? { ...sensors.raw, det: RAWD, frames: RAWF } : null };
    const name = 'ar-zapis-' + new Date().toISOString().slice(11, 19).replace(/:/g, '-') + '.json';
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

  // ---------- Строки для режима разработчика ----------
  function devText() {
    const now = performance.now(), dt = Math.max(0.2, (now - secT) / 1000);
    const d = {}; for (const k in sec) if (typeof sec[k] === 'number') d[k] = sec[k] - (secSnap[k] || 0);
    secSnap = { ...sec }; secT = now;
    const trk = stream && stream.getVideoTracks()[0], fr = trk && trk.getSettings ? trk.getSettings().frameRate : null;
    const F = fusion.st, sd = sensors.diag, c = F.calib;
    const fname = { 'acc+': 'с акселерометром', 'acc-': 'с акселерометром (обр. знак)', cv: 'по скорости', arm: 'по повороту руки', hold: 'на месте' }[F.filt] || F.filt;
    const per = (v) => (v / dt).toFixed(0);
    // средний «скачок» поправки за секунду, пиксели видео (до плавного растворения) — мерило дрожи от распознавания
    const lockTxt = F.diag.lockW != null ? `  привязка ${Math.round(F.diag.lockW * 100)}% (шум углов ${F.diag.sigC.toFixed(1)} px)` : '';
    const corr = F.diag.corrN ? (F.diag.corr / F.diag.corrN).toFixed(1) + ' px' : '—';
    F.diag.corr = 0; F.diag.corrN = 0;
    const ext = sd.extra || 0; sd.extra = 0;
    const tags = sec.tags ? `меток ${sec.tags} (сторона ${sec.side.toFixed(0)} px)` : 'меток 0';
    const slideTxt = `сносы (>${SLIDE_PX} px): ${slides}, макс ${slideMax.toFixed(0)} px` + (REC.length ? `, последний ${REC[REC.length - 1].snos ?? '—'} px` : '');
    return `${slideTxt}\n` + `движок 2  камера ${vw}×${vh} ${fr ? Math.round(fr) + ' к/с' : ''}, новых ${per(d.frames)}/с (время ${vf.mode})\n` +
      `показ с задержкой ${delayMs.toFixed(0)} мс${DELAY < 0 ? ' (авто)' : ''}  ` +
      `\nсцена: ${fusion.st.eis ? "ПО КАДРУ" : "по гироскопу"} (промах: по гироскопу ${(fusion.st.cmpG || 0).toFixed(1)} px, по кадру ${(fusion.st.cmpV || 0).toFixed(1)} px; видно ${Math.round(fusion.st.eisK * 100)}% поворота)\n` +
      `поиск ${per(d.res)}/с: ${d.res ? (d.procMs / d.res).toFixed(1) : '—'} мс ${worker && workerOk ? 'в фоне' : 'в основном потоке'}` +
      ` + захват ${d.sent ? (d.grabMs / d.sent).toFixed(1) : '—'} мс (${grabMode === 'bitmap' ? 'картинкой' : 'пикселями'})\n` +
      `  ${sec.roi} (чёткость ${TARGET_TAG})  ${tags}  нашёл ${per(d.found)}/с  смаз: пропуск ${d.blurSkip} отказ ${F.diag.blurRej}  передышка ${d.dutySkip}${d.fails ? '  сбоев ' + d.fails : ''}\n` +
      `сдвиг: ${fname}  отсев ${F.diag.rej}  сбросов ${F.resets}  рассогл. ${F.diag.inconsist}  поправки ${corr}${lockTxt}\n` +
      `  промахи ${Object.entries(F.diag.nis).map(([k, v]) => k + ' ' + v.toFixed(1)).join('  ')}\n` +
      `калибр.: задержка ${fusion.lag.toFixed(0)} мс  обзор ${fusion.fov.toFixed(1)}°  построчно ${fusion.rs.x.toFixed(0)}/${fusion.rs.y.toFixed(0)} мс  шарнир: выше ${fusion.arm.r.y.toFixed(0)}, впереди ${(-fusion.arm.r.z).toFixed(0)} см (${fusion.arm.n})  (подборов ${c.lagRuns}/${c.fRuns}/${c.rsRuns}${c.spread != null ? ', разброс ' + c.spread.toFixed(2) + '°' : ''})\n` +
      `датчики (${sensors.source}): ориент. ${sd.rel}/${sd.relNull} комп. ${sd.abs} движ. ${sd.mot} уск. ${sd.acc}  знак g ${fusion.gSign > 0 ? '+' : fusion.gSign < 0 ? '−' : '?'}${sd.late ? '  опозд. ' + sd.late : ''}  запаздывание до ${ext.toFixed(0)} мс\n` +
      `лист: ${markerState()}  смаз ${F.diag.blur.toFixed(0)} px  ошибка углов ${sec.err.toFixed(2)} px\n`;
  }
  function markerState() {
    const F = fusion.st;
    if (!F.init) return 'не найден';
    const ago = (performance.now() - F.lastMeas) / 1000;
    return (F.snapped ? 'горизонтально' : 'наклон ' + (F.tiltAvg || 0).toFixed(0) + '°') + (ago > 0.5 ? `, не видно ${ago.toFixed(1)} с` : '');
  }

  return {
    engine: 2, renderer, scene, camera, content, stats, fusion, sensors, video,
    async start() {
      await openCamera(CAMFPS);
      sensors.start();
      startVision();
      if (hasRVFC) video.requestVideoFrameCallback(onVideoFrame);
      started = true;
      watchdog();
      layout(true);
      return video;
    },
    frame,
    get needRender() { return needRender; },
    get frames() { return vf.n; },
    get shownFrame() { return shownSlot ? shownSlot.n : -1; },
    get delayMs() { return delayMs; },
    get rec() { return REC; },
    get shown() { return content.visible; },
    get frozen() { return frozen; },
    get restarting() { return false; },
    get loops() { return visionLoops; },
    get markerState() { return markerState(); },
    devText,
    takeGaps() { const g = { pose: gaps.pose, proc: gaps.proc }; gaps.pose = gaps.proc = 0; return g; },
    gravityInContent(out) { return fusion.upInMarker(out); },
    setFrozen(on) {
      if (on === frozen) return;
      frozen = on;
      frozenWant = on && content.visible;
      if (!on) { busy = false; }
    },
    setPaused(on) {
      if (on === paused) return;
      if (on && frozen) this.setFrozen(false);
      paused = on;
      if (!on) setTimeout(() => layout(true), 300);
    },
    setLite(on) {
      const trk = stream && stream.getVideoTracks()[0];
      const fps = on ? 30 : CAMFPS;
      if (trk && trk.applyConstraints) trk.applyConstraints({ width: { ideal: CAMW }, height: { ideal: CAMH }, frameRate: { ideal: fps } }).catch(() => {});
    },
  };
}
