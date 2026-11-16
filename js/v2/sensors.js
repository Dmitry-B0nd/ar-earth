// Движок 2: датчики телефона с точными отметками времени.
// Ориентация (гироскоп, уже «склеенный» системой с акселерометром) и ускорение — в кольцевых буферах,
// чтобы брать положение телефона на любой момент последних секунд (с интерполяцией):
// кадр камеры снят раньше, чем показан, — и сцену надо ставить по ориентации на момент съёмки.
// Время событий — e.timeStamp (когда событие возникло), а не когда до него дошла очередь:
// на слабом телефоне главный поток бывает занят, и события обрабатываются пачкой с опозданием.
import * as THREE from 'three';

const DEG = Math.PI / 180;

export function createSensors() {
  const N = 2048;
  const ot = new Float64Array(N), oq = new Float32Array(N * 4);
  let oi = -1, on = 0;
  const euler = new THREE.Euler(), q = new THREE.Quaternion(), qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  const qr1 = new THREE.Quaternion(), qr2 = new THREE.Quaternion();   // для rateAt (devAt пользуется qa/qb внутри)
  const qScreen = new THREE.Quaternion(), zAxis = new THREE.Vector3(0, 0, 1);
  const motionQ = [];          // новые показания ускорения, ещё не отданные фильтру
  const diag = { rel: 0, relNull: 0, abs: 0, absNull: 0, mot: 0, acc: 0, late: 0, rateO: 0, rateM: 0 };
  let relT = -1e9, source = '—', listening = false, lastMotionT = -1e9;

  const stamp = (e) => {
    const now = performance.now(), ts = e && e.timeStamp;
    if (typeof ts === 'number' && ts > now - 1000 && ts <= now + 5) { if (now - ts > 30) diag.late++; return ts; }
    return now;
  };
  function onOrient(e, kind) {
    if (e.beta == null || e.gamma == null) { diag[kind + 'Null']++; return; }
    diag[kind]++;
    const t = stamp(e);
    if (kind === 'rel') relT = t;
    else if (t - relT < 500) return;                     // обычная ориентация работает — компасная не нужна
    source = kind === 'rel' ? 'гироскоп' : 'компас';
    if (on && t <= ot[oi]) return;                       // не по порядку — пропускаем
    euler.set(e.beta * DEG, e.gamma * DEG, (e.alpha || 0) * DEG, 'ZXY');
    q.setFromEuler(euler);
    // без скачков знака (q и −q — один поворот): для интерполяции
    if (on && q.x * oq[oi * 4] + q.y * oq[oi * 4 + 1] + q.z * oq[oi * 4 + 2] + q.w * oq[oi * 4 + 3] < 0) { q.x = -q.x; q.y = -q.y; q.z = -q.z; q.w = -q.w; }
    oi = (oi + 1) % N; on = Math.min(N, on + 1);
    ot[oi] = t; oq[oi * 4] = q.x; oq[oi * 4 + 1] = q.y; oq[oi * 4 + 2] = q.z; oq[oi * 4 + 3] = q.w;
  }
  const onRel = (e) => onOrient(e, 'rel'), onAbs = (e) => onOrient(e, 'abs');
  function onMotion(e) {
    diag.mot++;
    const a = e.acceleration, g = e.accelerationIncludingGravity;
    const t = stamp(e);
    const acc = a && a.x != null ? [a.x, a.y, a.z] : null;
    if (acc) diag.acc++;
    motionQ.push({ t, acc, accG: g && g.x != null ? [g.x, g.y, g.z] : null });
    if (motionQ.length > 400) motionQ.splice(0, motionQ.length - 400);
    lastMotionT = t;
  }
  const screenAngle = () => ((screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0) * DEG;
  const load = (k, out) => out.set(oq[k * 4], oq[k * 4 + 1], oq[k * 4 + 2], oq[k * 4 + 3]);

  // ориентация телефона в комнате на момент t (мс): «из осей телефона в оси комнаты»
  function devAt(t, out) {
    if (!on) return false;
    if (t >= ot[oi]) {
      // новее последнего показания: продолжаем последний поворот (не дальше 50 мс)
      load(oi, out);
      if (on > 1) {
        const k0 = (oi - 1 + N) % N, dt = ot[oi] - ot[k0];
        if (dt > 0 && dt < 100) {
          const ex = Math.min(t - ot[oi], 50) / dt;
          load(k0, qa); qb.copy(qa).invert().multiply(out);       // поворот за последний шаг (в осях телефона)
          qa.identity().slerp(qb, ex);
          out.multiply(qa);
        }
      }
      return true;
    }
    let k = oi;
    for (let n = 0; n < on; n++) {
      const k0 = (k - 1 + N) % N;
      if (n === on - 1 || ot[k0] <= t) {
        if (n === on - 1) { load(k, out); return true; }   // старше всей истории
        const w = (t - ot[k0]) / (ot[k] - ot[k0] || 1);
        load(k0, out); load(k, qb);
        out.slerp(qb, w);
        return true;
      }
      k = k0;
    }
    return false;
  }
  return {
    request() {
      const D = window.DeviceOrientationEvent, M = window.DeviceMotionEvent;
      const ask = (E) => (E && typeof E.requestPermission === 'function') ? E.requestPermission().then((r) => r === 'granted').catch(() => false) : Promise.resolve(!!E);
      return Promise.all([ask(D), ask(M)]).then(([o, m]) => o || m);
    },
    start() {
      if (listening) return;
      listening = true;
      window.addEventListener('deviceorientation', onRel);
      if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', onAbs);
      window.addEventListener('devicemotion', onMotion);
    },
    stop() {
      listening = false;
      window.removeEventListener('deviceorientation', onRel);
      window.removeEventListener('deviceorientationabsolute', onAbs);
      window.removeEventListener('devicemotion', onMotion);
    },
    devAt,
    // ориентация камеры в комнате (оси камеры three.js с учётом поворота экрана)
    camAt(t, out) {
      if (!devAt(t, out)) return false;
      return out.multiply(qScreen.setFromAxisAngle(zAxis, -screenAngle())), true;
    },
    // скорость поворота около момента t, рад/с
    rateAt(t) {
      if (on < 2 || !devAt(t - 20, qr1) || !devAt(t + 5, qr2)) return 0;
      return 2 * Math.acos(Math.min(1, Math.abs(qr1.dot(qr2)))) / 0.025;
    },
    // забрать накопленные показания ускорения (по порядку)
    takeMotion() { const a = motionQ.splice(0, motionQ.length); a.sort((x, y) => x.t - y.t); return a; },
    get hasOrientation() { return on > 0 && performance.now() - ot[oi] < 500; },
    get motionFresh() { return performance.now() - lastMotionT < 300; },
    get lastT() { return on ? ot[oi] : -1e9; },
    get source() { return source; },
    get diag() { return diag; },
  };
}
