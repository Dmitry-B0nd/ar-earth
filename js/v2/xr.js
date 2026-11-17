// Режим ARCore (Android, Chrome): телефон в комнате отслеживает сам ARCore (как в обычных AR-приложениях), через WebXR.
// Мы только находим лист меток на кадре камеры (тем же распознавателем, что и движок 2) и «прибиваем» его к месту
// в пространстве ARCore. Дальше сцену держит ARCore: ему не мешают ни стабилизация камеры, ни округление датчиков,
// ни задержки — кадр и положение телефона приходят от него уже согласованными.
// Кадр камеры: XRWebGLBinding.getCameraImage (функция WebXR «camera-access»). Уменьшаем и переводим в серый
// на видеокарте, читаем без остановки рисования (через буфер и «забор»), распознаём в фоновом потоке.
import * as THREE from 'three';
import { decomposeH, quatFromRcv } from './fusion.js?v=6.6';

const VER = '6.6';
const DEG = Math.PI / 180;

// Поддерживает ли браузер такой режим (без запроса разрешений)
export async function xrAvailable() {
  try { return !!(navigator.xr && navigator.xr.isSessionSupported && await navigator.xr.isSessionSupported('immersive-ar')); } catch (e) { return false; }
}
// Запрос сессии — строго сразу по нажатию кнопки (иначе браузер откажет)
// Доступ к кадру камеры (camera-access) есть не на всех телефонах — он необязателен: без него Землю ставят касанием
// на поверхность, где лежит лист (поиск поверхности — hit-test ARCore), и дальше её точно так же держит ARCore.
export function requestXrSession(root) {
  return navigator.xr.requestSession('immersive-ar', {
    optionalFeatures: ['camera-access', 'hit-test', 'dom-overlay', 'local'],
    domOverlay: { root },
  });
}

// Место листа в пространстве ARCore по гомографии «лист (0…1, y вниз) → пиксели уменьшенного кадра w×h».
// P — матрица проекции вида (по столбцам), qView/pView — поза камеры в момент съёмки этого кадра.
// Возвращает { dist } (расстояние до листа, м), 'mirror' (кадр зеркален — перевёрнут) или null.
const _q = new THREE.Quaternion(), _v = new THREE.Vector3();
export function boardPoseWorld(H, P, w, h, qView, pView, boardM, outQ, outP) {
  // внутренние параметры камеры — из матрицы проекции (кадр ARCore совмещён с видом); координаты — индексы пикселей
  const fx = w / 2 * P[0], fy = h / 2 * P[5], cx = w / 2 * (1 - P[8]) - 0.5, cy = h / 2 * (1 + P[9]) - 0.5;
  // лист, видимый спереди, отображается без отражения: знак определителя производной «лист → кадр» в центре листа
  // (от общего множителя H не зависит). Отражён — значит, кадр прочитан вверх ногами.
  const zc = H[6] * 0.5 + H[7] * 0.5 + H[8], uc = (H[0] * 0.5 + H[1] * 0.5 + H[2]) / zc, vc = (H[3] * 0.5 + H[4] * 0.5 + H[5]) / zc;
  const det = (H[0] - uc * H[6]) * (H[4] - vc * H[7]) - (H[1] - uc * H[7]) * (H[3] - vc * H[6]);
  if (det < 0) return 'mirror';
  // пиксели не квадратные (вдруг) — приводим вертикаль к фокусу fx
  const k = fx / fy;
  const Hs = [H[0], H[1], H[2], k * H[3] + cy * (1 - k) * H[6], k * H[4] + cy * (1 - k) * H[7], k * H[5] + cy * (1 - k) * H[8], H[6], H[7], H[8]];
  const dec = decomposeH(Hs, fx, cx, cy);
  if (!dec || !(dec.t[2] > 0)) return null;
  // лист в осях камеры three (поворот и центр, м) → в пространство ARCore
  const qCM = quatFromRcv(dec.R, _q);
  outQ.copy(qView).multiply(qCM);
  outP.copy(_v.set(dec.t[0], -dec.t[1], -dec.t[2]).multiplyScalar(boardM)).applyQuaternion(qView).add(pView);
  return { dist: dec.t[2] * boardM };
}

// Уменьшение кадра камеры на видеокарте: серый, 4 пикселя в одном (RGBA), чтение без остановки рисования
// (через буфер и «забор»: результат — через кадр-другой). flip — читать кадр с другим порядком строк.
export function createGrabber(gl, renderer) {
  const st = { grabMs: 0 };
  let prog = null, vao = null, fbo = null, fboTex = null, gw = 0, gh = 0, uTex, uOut, uFlip;
  const pbos = [];                       // [{ buf, sync, meta }]
  function sh(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('шейдер: ' + gl.getShaderInfoLog(s));
    return s;
  }
  function initGL() {
    if (prog) return;
    const vs = `#version 300 es
      void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
    // выход: пиксель (x, y) кадра-приёмника хранит серый 4 соседних пикселей строки y (сверху вниз) уменьшенного кадра;
    // каждый — среднее 4 отсчётов (сглаживание при уменьшении)
    const fs = `#version 300 es
      precision highp float;
      uniform sampler2D uTex; uniform vec2 uOut; uniform float uFlip;
      out vec4 o;
      float lum(vec2 s) { vec2 t = vec2(s.x, uFlip > 0.5 ? s.y : 1.0 - s.y); return dot(texture(uTex, t).rgb, vec3(0.299, 0.587, 0.114)); }
      float g(float x, float y) {
        vec2 a = vec2((x + 0.25) / uOut.x, (y + 0.25) / uOut.y), b = vec2((x + 0.75) / uOut.x, (y + 0.75) / uOut.y);
        return 0.25 * (lum(a) + lum(vec2(b.x, a.y)) + lum(vec2(a.x, b.y)) + lum(b));
      }
      void main() { float x = floor(gl_FragCoord.x) * 4.0, y = floor(gl_FragCoord.y);
        o = vec4(g(x, y), g(x + 1.0, y), g(x + 2.0, y), g(x + 3.0, y)); }`;
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('программа: ' + gl.getProgramInfoLog(p));
    prog = p; uTex = gl.getUniformLocation(p, 'uTex'); uOut = gl.getUniformLocation(p, 'uOut'); uFlip = gl.getUniformLocation(p, 'uFlip');
    vao = gl.createVertexArray();
  }
  function ensureTarget(w, h) {
    if (w === gw && h === gh && fbo) return;
    gw = w; gh = h;
    if (fbo) { gl.deleteFramebuffer(fbo); gl.deleteTexture(fboTex); }
    for (const p of pbos) { if (p.sync) gl.deleteSync(p.sync); gl.deleteBuffer(p.buf); }
    pbos.length = 0;
    fboTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, fboTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w / 4, h);
    fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0);
    for (let i = 0; i < 2; i++) {
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, w * h, gl.STREAM_READ);
      pbos.push({ buf, sync: null, meta: null });
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  }
  // снять кадр: уменьшить на видеокарте и поставить чтение в очередь (результат — через кадр-другой)
  function capture(tex, meta) {
    const slot = pbos.find((p) => !p.sync);
    if (!slot) return false;
    const t0 = performance.now();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, gw / 4, gh);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(uTex, 0); gl.uniform2f(uOut, gw, gh); gl.uniform1f(uFlip, meta.flip);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buf);
    gl.readPixels(0, 0, gw / 4, gh, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    slot.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    slot.meta = meta;
    gl.flush();
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    renderer.resetState();                 // three.js должен заново выставить всё своё
    st.grabMs += performance.now() - t0;
    return true;
  }
  // готовые чтения — забрать
  // want() — нужен ли сейчас кадр (распознаватель свободен); cb(data, meta) — серый кадр gw×gh, строки сверху вниз
  function collect(want, cb) {
    for (const p of pbos) {
      if (!p.sync) continue;
      const s = gl.clientWaitSync(p.sync, 0, 0);
      if (s !== gl.ALREADY_SIGNALED && s !== gl.CONDITION_SATISFIED) continue;
      gl.deleteSync(p.sync); p.sync = null;
      const meta = p.meta; p.meta = null;
      if (!want()) continue;                                // распознаватель занят — кадр не нужен
      const data = new Uint8ClampedArray(gw * gh);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, p.buf);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      cb(data, meta);
    }
  }
  return { st, init: initGL, ensure: ensureTarget, capture, collect,
    get pending() { return pbos.some((p) => p.sync); }, get w() { return gw; }, get h() { return gh; } };
}

export function createEngineXR(opts) {
  const { container, session, onFound, onLost, BOARDM = 0.18, XRW = 360, XRSCALE = 1, AA = true } = opts;

  const renderer = new THREE.WebGLRenderer({ antialias: AA, alpha: true, powerPreference: 'default' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  renderer.setSize(window.innerWidth, window.innerHeight);
  // холст в режиме AR не виден (картинку показывает сам браузер), но его размер — экран: по нему считаются тапы
  Object.assign(renderer.domElement.style, { position: 'fixed', left: '0', top: '0', width: '100vw', height: '100vh', visibility: 'hidden' });
  container.appendChild(renderer.domElement);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local');
  if (XRSCALE !== 1) renderer.xr.setFramebufferScaleFactor(XRSCALE);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.02, 100);
  const content = new THREE.Group();
  content.matrixAutoUpdate = false;
  content.visible = false;
  scene.add(content);

  const gl = renderer.getContext();
  const gl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;

  // ---------- Состояние ----------
  let started = false, frozen = false, paused = false, wasShown = false, binding = null;
  let xrFrames = 0, loops = 0, tracking = 'нет', camSize = '—', lastTrackOk = 0;
  const sec = { res: 0, found: 0, ms: 0, tags: 0, acc: 0, rej: 0, jumps: 0, grabMs: 0 };
  let secSnap = { ...sec }, secT = performance.now();
  const gaps = { pose: 0, proc: 0, lastPose: 0, lastProc: 0 };

  const grab = createGrabber(gl, renderer);
  let flip = 0, flipVotes = 0, flipLocked = false;

  // ---------- Режим «поставить касанием» (нет доступа к кадру камеры) ----------
  // mode: 'marker' — ищем лист на кадре; 'place' — кольцо на поверхности в центре экрана, касание ставит Землю
  let mode = 'marker', hitSource = null, hitOk = false, placed = false, camChecks = 0;
  const hitP = new THREE.Vector3(), camFwd = new THREE.Vector3();
  const reticle = new THREE.Mesh(new THREE.RingGeometry(0.035, 0.045, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xff9628, transparent: true, opacity: 0.9, depthTest: false }));
  reticle.visible = false; reticle.renderOrder = 999; scene.add(reticle);
  async function enterPlaceMode(why) {
    if (mode === 'place') return;
    mode = 'place';
    console.warn('[ARCore] кадр камеры недоступен (' + why + ') — режим «поставить касанием»');
    const h = document.querySelector('#hint div'); if (h) h.textContent = 'Наведите на лист на столе и коснитесь экрана';
    try {
      const viewer = await session.requestReferenceSpace('viewer');
      hitSource = await session.requestHitTestSource({ space: viewer });
    } catch (e) { console.error('[ARCore] поиск поверхности недоступен:', e); }
  }
  function placeHere() {
    if (mode !== 'place' || placed || !hitOk) return;
    // лист — горизонтально в точке касания, «верх листа» — от зрителя (Земля повёрнута к нему)
    const yaw = Math.atan2(-camFwd.x, -camFwd.z);
    est.q.setFromAxisAngle(up, yaw).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
    est.p.copy(hitP); est.n = 2; est.snapped = true; est.lastT = performance.now();
    placed = true; reticle.visible = false;
    console.log('[ARCore] Земля поставлена касанием');
  }

  // ---------- Распознавание в фоновом потоке ----------
  let worker = null, workerOk = false, workerBusy = false, reqId = 0;
  const pending = new Map();
  function startWorker() {
    worker = new Worker(new URL('./vision-worker.js?v=' + VER, import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'ready') { workerOk = true; console.log('[ARCore] распознаватель готов'); return; }
      if (m.type === 'fail') { console.error('[ARCore] распознаватель не загрузился:', m.msg); return; }
      workerBusy = false;
      const meta = pending.get(m.id); pending.delete(m.id);
      if (m.type === 'err') { console.warn('[ARCore] ошибка распознавания:', m.msg); return; }
      if (!meta) return;
      loops++; sec.res++; sec.ms += m.ms;
      const now = performance.now();
      if (gaps.lastProc) gaps.proc = Math.max(gaps.proc, now - gaps.lastProc);
      gaps.lastProc = now;
      onResult(m, meta);
    };
    worker.onerror = (e) => console.error('[ARCore] фоновый поток:', e.message || e);
  }
  function send(data, meta) {
    if (!workerOk) return;
    const id = ++reqId;
    pending.set(id, meta);
    workerBusy = true;
    worker.postMessage({ type: 'frame', id, tFrame: meta.t, w: meta.w, h: meta.h, gray: true, map: { sx: 0, sy: 0, kx: 1, ky: 1 }, data }, [data.buffer]);
  }

  // ---------- Лист → место в пространстве ARCore ----------
  // Лист неподвижен, поэтому оценки с разных кадров усредняем (сильно — пока они согласны друг с другом).
  // Сильно расходящиеся оценки — выбросы; если несколько подряд согласны между собой — лист передвинули (или ARCore
  // уточнил карту комнаты): переставляем сцену.
  const est = { n: 0, p: new THREE.Vector3(), q: new THREE.Quaternion(), snapped: false, tilt: 0, lastT: 0, dev: [] };
  let pend = [];
  const up = new THREE.Vector3(0, 1, 0);
  const tq = new THREE.Quaternion(), tq2 = new THREE.Quaternion(), tv = new THREE.Vector3(), tv2 = new THREE.Vector3();
  const qView = new THREE.Quaternion(), pView = new THREE.Vector3();
  function onResult(m, meta) {
    sec.tags += m.tags || 0;
    if (frozen || !(m.n >= 8) || !m.H) {
      // ориентация кадра ещё не известна и меток не видно — пробуем перевёрнутый кадр (вдруг метки не читаются из-за этого)
      if (!flipLocked && !(m.tags > 0) && meta.flip === flip) { if (++flipVotes >= 3) { flip = 1 - flip; flipVotes = 0; } }
      return;
    }
    const Qw = tq2, Pw = tv2;
    const r = boardPoseWorld(m.H, meta.proj, meta.w, meta.h, meta.q, meta.p, BOARDM, Qw, Pw);
    if (r === 'mirror') {
      if (meta.flip === flip) { flip = 1 - flip; flipVotes = 0; flipLocked = false; console.log('[ARCore] кадр перевёрнут — переворачиваю'); }
      return;
    }
    if (!r) return;
    if (!flipLocked) { flipLocked = true; console.log('[ARCore] ориентация кадра:', flip ? 'прямая' : 'обычная (GL)'); }
    sec.found++;
    const dist = r.dist;
    // лист почти горизонтален — кладём его ровно (наклон — по тяжести ARCore, от кадра — только поворот вокруг вертикали)
    const nrm = new THREE.Vector3(0, 0, 1).applyQuaternion(Qw);
    const tilt = Math.acos(Math.max(-1, Math.min(1, nrm.dot(up)))) / DEG;
    est.tilt = est.tilt ? est.tilt * 0.9 + tilt * 0.1 : tilt;
    const snap = tilt < 12;
    if (snap) Qw.premultiply(new THREE.Quaternion().setFromUnitVectors(nrm, up));
    est.snapped = snap;
    addMeas(Pw, Qw, m.n, dist);
  }
  function addMeas(Pw, Qw, n, dist) {
    const now = performance.now();
    if (!est.n) { est.p.copy(Pw); est.q.copy(Qw); est.n = 1; est.lastT = now; return; }
    const dp = Pw.distanceTo(est.p), dq = 2 * Math.acos(Math.min(1, Math.abs(Qw.dot(est.q)))) / DEG;
    // допуск — от расстояния (вдали распознавание грубее)
    const tolP = Math.max(0.03, 0.08 * dist), tolQ = 8;
    if (dp > tolP || dq > tolQ) {
      sec.rej++;
      pend.push({ p: Pw.clone(), q: Qw.clone() });
      if (pend.length > 4) pend.shift();
      if (pend.length >= 4) {
        const c = pend[pend.length - 1];
        if (pend.every((x) => x.p.distanceTo(c.p) < tolP * 0.6 && 2 * Math.acos(Math.min(1, Math.abs(x.q.dot(c.q)))) / DEG < 5)) {
          // лист передвинули — переставляем
          est.p.set(0, 0, 0); for (const x of pend) est.p.add(x.p); est.p.multiplyScalar(1 / pend.length);
          est.q.copy(c.q); est.n = pend.length; pend = []; sec.jumps++; est.dev.length = 0;
          console.log('[ARCore] лист переставлен');
        }
      }
      return;
    }
    pend = [];
    est.n++; sec.acc++;
    const a = Math.max(1 / est.n, 0.08);
    est.p.lerp(Pw, a); est.q.slerp(Qw, a);
    est.lastT = now;
    est.dev.push([dp * 1000, dq]); if (est.dev.length > 30) est.dev.shift();
  }

  // ---------- Каждый кадр ----------
  const one = new THREE.Vector3();
  function frame(now) {
    if (!started) return;
    const xf = renderer.xr.getFrame();
    const ref = renderer.xr.getReferenceSpace();
    if (!xf || !ref) return;
    xrFrames++;
    const pose = xf.getViewerPose(ref);
    const ok = !!pose && !pose.emulatedPosition;
    tracking = !pose ? 'нет' : pose.emulatedPosition ? 'потерян (только поворот)' : 'есть';
    if (ok) lastTrackOk = now;
    // кадр камеры так и не появился — значит, доступа к нему нет
    if (mode === 'marker' && pose && ok && !(pose.views[0] && pose.views[0].camera) && ++camChecks > 30) enterPlaceMode('нет кадра в виде');
    if (mode === 'place' && pose) {
      const m = pose.transform.matrix;
      camFwd.set(-m[8], 0, -m[10]).normalize();
      hitOk = false;
      if (hitSource && !placed && ok) {
        const hr = xf.getHitTestResults(hitSource);
        const hp = hr.length ? hr[0].getPose(ref) : null;
        if (hp) { hitOk = true; hitP.set(hp.transform.position.x, hp.transform.position.y, hp.transform.position.z); reticle.position.copy(hitP); }
      }
      reticle.visible = hitOk && !placed;
    }
    if (mode === 'marker' && gl2 && binding && pose && ok && !paused && !frozen) {
      grab.collect(() => !workerBusy, send);
      const view = pose.views[0];
      if (view && view.camera && workerOk && !workerBusy && !grab.pending) {
        try {
          const tex = binding.getCameraImage(view.camera);
          if (tex) {
            const cw = view.camera.width, ch = view.camera.height;
            camSize = cw + '×' + ch;
            const w = Math.max(64, Math.round(Math.min(XRW, cw) / 4) * 4), h = Math.round(w * ch / cw);
            grab.init(); grab.ensure(w, h);
            const tr = view.transform;
            grab.capture(tex, {
              t: now, flip, w, h,
              proj: Array.from(view.projectionMatrix),
              q: new THREE.Quaternion(tr.orientation.x, tr.orientation.y, tr.orientation.z, tr.orientation.w),
              p: new THREE.Vector3(tr.position.x, tr.position.y, tr.position.z),
            });
          }
        } catch (e) { if (!frame.errLogged) { frame.errLogged = true; console.error('[ARCore] кадр камеры:', e); } }
      }
    }
    const want = est.n >= 2 && (ok || now - lastTrackOk < 500);
    if (want) {
      content.matrix.compose(est.p, est.q, one.setScalar(BOARDM));
      content.matrixWorldNeedsUpdate = true;
      if (gaps.lastPose) gaps.pose = Math.max(gaps.pose, now - gaps.lastPose);
      gaps.lastPose = now;
    }
    if (want !== content.visible) content.visible = want;
    if (want && !wasShown) onFound && onFound();
    if (!want && wasShown) onLost && onLost();
    wasShown = want;
  }

  function markerState() {
    if (mode === 'place') return placed ? 'поставлена касанием (сцену держит ARCore)' : hitOk ? 'поверхность найдена — коснитесь экрана' : 'ищу поверхность';
    if (!est.n) return 'не найден';
    const ago = (performance.now() - est.lastT) / 1000;
    return (est.snapped ? 'горизонтально' : 'наклон ' + est.tilt.toFixed(0) + '°') + (ago > 0.5 ? `, не видно ${ago.toFixed(1)} с (сцену держит ARCore)` : '');
  }
  function devText() {
    const now = performance.now(), dt = Math.max(0.2, (now - secT) / 1000);
    sec.grabMs = grab.st.grabMs;
    const d = {}; for (const k in sec) d[k] = sec[k] - (secSnap[k] || 0);
    secSnap = { ...sec }; secT = now;
    const per = (v) => (v / dt).toFixed(0);
    const dev = est.dev.length ? est.dev.reduce((a, x) => [a[0] + x[0], a[1] + x[1]], [0, 0]).map((v) => v / est.dev.length) : null;
    const feats = session.enabledFeatures ? [...session.enabledFeatures].join(', ') : '?';
    if (mode === 'place') return `движок: ARCore (WebXR), КАСАНИЕМ (нет кадра камеры)  слежение: ${tracking}\n` +
      `функции: ${feats}\nЗемля: ${markerState()}\n`;
    return `движок: ARCore (WebXR)  слежение: ${tracking}\n` + `функции: ${feats}\n` +
      `кадр камеры ${camSize} → поиск ${grab.w}×${grab.h}${flipLocked ? '' : ' (ориентация?)'}\n` +
      `поиск ${per(d.res)}/с: ${d.res ? (d.ms / d.res).toFixed(1) : '—'} мс в фоне + захват ${d.res ? (d.grabMs / d.res).toFixed(1) : '—'} мс  нашёл ${per(d.found)}/с  меток ${d.res ? (d.tags / d.res).toFixed(1) : 0}\n` +
      `лист в комнате: оценок ${est.n}, принято ${d.acc}, отсев ${sec.rej}, перестановок ${sec.jumps}\n` +
      `  разброс оценок ${dev ? dev[0].toFixed(1) + ' мм, ' + dev[1].toFixed(2) + '°' : '—'}\n` +
      `лист: ${markerState()}\n`;
  }

  return {
    engine: 'xr', renderer, scene, camera, content, video: null,
    async start() {
      startWorker();
      session.addEventListener('end', () => { console.warn('[ARCore] сеанс завершён — перезагрузка'); setTimeout(() => location.reload(), 200); });
      await renderer.xr.setSession(session);
      if (!gl2) console.error('[ARCore] нет WebGL2 — кадр камеры не прочитать');
      try { binding = new XRWebGLBinding(session, gl); } catch (e) { console.error('[ARCore] нет доступа к кадру камеры:', e); }
      const feats = session.enabledFeatures ? [...session.enabledFeatures] : null;
      if (!gl2 || !binding) enterPlaceMode(!gl2 ? 'нет WebGL2' : 'нет XRWebGLBinding');
      else if (feats && !feats.includes('camera-access')) enterPlaceMode('браузер не дал camera-access');
      // касание экрана (в AR — событие select сеанса); касания кнопок поверх сцены сюда не доходят — их отсекаем
      session.addEventListener('select', () => placeHere());
      document.addEventListener('beforexrselect', (e) => { if (e.target.closest && e.target.closest('button, #card, #viewPanel, #chooser')) e.preventDefault(); });
      started = true;
      console.log('[ARCore] сеанс запущен; функции:', session.enabledFeatures ? [...session.enabledFeatures].join(', ') : '?',
        '| интерфейс поверх:', session.domOverlayState ? session.domOverlayState.type : 'нет');
      return null;
    },
    frame,
    get needRender() { return true; },
    get frames() { return xrFrames; },
    get shown() { return content.visible; },
    get frozen() { return frozen; },
    get restarting() { return false; },
    get loops() { return loops; },
    get markerState() { return markerState(); },
    devText,
    takeGaps() { const g = { pose: gaps.pose, proc: gaps.proc }; gaps.pose = gaps.proc = 0; return g; },
    // «вверх» (против тяжести; в ARCore это ось Y) в координатах листа
    gravityInContent(out) {
      if (!content.visible) return false;
      content.matrix.decompose(tv, tq, one);
      return out.set(0, 1, 0).applyQuaternion(tq.invert()).normalize(), true;
    },
    // «заморозка»: сцена и так стоит на месте в комнате — просто перестаём её уточнять
    setFrozen(on) { frozen = on; },
    get xrMode() { return mode; },
    setPaused(on) { paused = on; },
    setLite() {},
  };
}
