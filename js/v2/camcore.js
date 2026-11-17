// Режим «только по камере» (телефоны без ARCore и без хорошего гироскопа): ядро без датчиков.
// Каждое распознавание листа → поза листа относительно камеры → мягкое сглаживание (фильтр 1€: телефон неподвижен —
// шум усредняется, двигается — сглаживание почти исчезает) → кадры между распознаваниями — плавный переход
// между соседними позами. Кадр показывается с небольшой задержкой, когда для него уже есть распознавания с обеих сторон.
// Никаких прогнозов, калибровок и переключений режимов.
import * as THREE from 'three';
import { decomposeH, quatFromRcv } from './fusion.js?v=7.0';

const DEG = Math.PI / 180;
const alphaF = (fc, dt) => { const r = 2 * Math.PI * fc * dt; return r / (r + 1); };

export function createCamCore(o = {}) {
  const opt = {
    minPos: 0, betaPos: 0,           // сглаживание центра листа (0 — выкл.: по прогону записей только запаздывает)
    minRot: 4, betaRot: 0.2,         // Гц, Гц на (°/с) — сглаживание поворота листа (дрожь Земли вблизи — от шума поворота)
    dcut: 1.0,                       // Гц — сглаживание оценки скорости
    hold: 300, gap: 300,             // мс: держать позу без новых распознаваний (дольше — прячем: сцене без датчиков не на что опереться); самый длинный промежуток для перехода
    ...o,
  };
  let f = 500, cx = 320, cy = 240;
  const list = [];                   // [{ tf, q, p }] — сглаженные позы по распознаваниям
  const flt = { t: null, q: new THREE.Quaternion(), p: new THREE.Vector3(), vp: 0, vr: 0 };
  const tq = new THREE.Quaternion(), tp = new THREE.Vector3();
  const st = { n: 0, rej: 0, last: -1e9, dist: 0, alt: 0, err: 0 };

  function setCamera(w, h, f0) { cx = (w - 1) / 2; cy = (h - 1) / 2; if (f0) f = f0; }

  // ---- уточнение позы по всем углам меток (метод Гаусса — Ньютона) ----
  // pts: [bx, by, u, v] × n (лист 0…1, пиксели видео). Поза: q — «лист → камера three», p — центр листа (ширины листа).
  const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _dq = new THREE.Quaternion(), _ax = new THREE.Vector3();
  function resid(q, p, pts, n, out) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const v = _v.set(pts[i * 4] - 0.5, 0.5 - pts[i * 4 + 1], 0).applyQuaternion(q).add(p);
      const z = Math.max(1e-3, -v.z);
      const du = cx + f * v.x / z - pts[i * 4 + 2], dv = cy - f * v.y / z - pts[i * 4 + 3];
      if (out) { out[i * 2] = du; out[i * 2 + 1] = dv; }
      s += du * du + dv * dv;
    }
    return Math.sqrt(s / Math.max(1, n));
  }
  const rotStep = (q, i, e, out) => { _ax.set(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0); return out.setFromAxisAngle(_ax, e).multiply(q); };
  function refine(q0, p0, pts, n) {
    const q = q0.clone(), p = p0.clone(), m = n * 2;
    const r0 = new Float64Array(m), r1 = new Float64Array(m), J = new Float64Array(m * 6);
    const qa = new THREE.Quaternion(), pa = new THREE.Vector3();
    let err = resid(q, p, pts, n, r0), lam = 1e-3;
    for (let it = 0; it < 8; it++) {
      for (let k = 0; k < 6; k++) {
        const e = k < 3 ? 1e-4 : 1e-4 * Math.max(1, -p.z);
        if (k < 3) { rotStep(q, k, e, qa); pa.copy(p); } else { qa.copy(q); pa.copy(p); pa.setComponent(k - 3, pa.getComponent(k - 3) + e); }
        resid(qa, pa, pts, n, r1);
        for (let i = 0; i < m; i++) J[i * 6 + k] = (r1[i] - r0[i]) / e;
      }
      const A = new Float64Array(36), b = new Float64Array(6);
      for (let i = 0; i < m; i++) for (let a = 0; a < 6; a++) { b[a] -= J[i * 6 + a] * r0[i]; for (let c = a; c < 6; c++) A[a * 6 + c] += J[i * 6 + a] * J[i * 6 + c]; }
      for (let a = 0; a < 6; a++) for (let c = 0; c < a; c++) A[a * 6 + c] = A[c * 6 + a];
      let improved = false;
      for (let tries = 0; tries < 4 && !improved; tries++) {
        const M = A.slice(); for (let a = 0; a < 6; a++) M[a * 6 + a] *= 1 + lam;
        const d = solve6(M, b.slice());
        if (!d) break;
        _ax.set(d[0], d[1], d[2]); const ang = _ax.length();
        if (ang > 1e-12) qa.setFromAxisAngle(_ax.multiplyScalar(1 / ang), ang).multiply(q); else qa.copy(q);
        pa.set(p.x + d[3], p.y + d[4], p.z + d[5]);
        const e2 = resid(qa, pa, pts, n, r1);
        if (e2 < err) { q.copy(qa); p.copy(pa); err = e2; r0.set(r1); lam *= 0.3; improved = true; } else lam *= 10;
      }
      if (!improved) break;
    }
    return { q, p, err };
  }
  function solve6(A, b) {
    const N = 6;
    for (let c = 0; c < N; c++) {
      let pv = c; for (let r = c + 1; r < N; r++) if (Math.abs(A[r * N + c]) > Math.abs(A[pv * N + c])) pv = r;
      if (Math.abs(A[pv * N + c]) < 1e-12) return null;
      if (pv !== c) { for (let k = 0; k < N; k++) { const t = A[c * N + k]; A[c * N + k] = A[pv * N + k]; A[pv * N + k] = t; } const t = b[c]; b[c] = b[pv]; b[pv] = t; }
      for (let r = c + 1; r < N; r++) { const fct = A[r * N + c] / A[c * N + c]; for (let k = c; k < N; k++) A[r * N + k] -= fct * A[c * N + k]; b[r] -= fct * b[c]; }
    }
    const x = new Array(N);
    for (let r = N - 1; r >= 0; r--) { let s = b[r]; for (let k = r + 1; k < N; k++) s -= A[r * N + k] * x[k]; x[r] = s / A[r * N + r]; }
    return x;
  }

  // распознавание кадра tf: гомография «лист (0…1) → пиксели видео» и углы меток pts (n штук)
  function add(tf, H, pts, n) {
    const dec = decomposeH(H, f, cx, cy);
    if (!dec || !(dec.t[2] > 0)) { st.rej++; return false; }
    let q = quatFromRcv(dec.R, tq);
    let p = tp.set(dec.t[0], -dec.t[1], -dec.t[2]);
    if (pts && n >= 4 && opt.refine !== false) {
      // Плоский лист издалека выглядит почти одинаково при двух разных наклонах — разложение может взять не тот,
      // и поза перескакивает. Уточняем оба варианта по всем углам; почти равные — берём ближний к прежнему.
      const a = refine(q, p, pts, n);
      _ax.copy(p).normalize();
      const q2 = _q.setFromAxisAngle(_ax, Math.PI).multiply(q).multiply(_dq.setFromAxisAngle(_v.set(0, 0, 1), Math.PI));
      const b = refine(q2, p, pts, n);
      let pick = a;
      if (b.err < a.err * 0.8) pick = b;
      else if (!(a.err < b.err * 0.8) && flt.t !== null && tf - flt.t <= opt.hold) {
        const da = Math.abs(a.q.dot(flt.q)), db = Math.abs(b.q.dot(flt.q));
        if (db > da) pick = b;
      }
      if (pick === b) st.alt++;
      st.err = pick.err;
      q = tq.copy(pick.q); p = tp.copy(pick.p);
    }
    st.dist = -p.z;
    // знак кватерниона — как у предыдущего (для сглаживания и перехода)
    if (flt.t !== null && q.dot(flt.q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
    if (flt.t === null || tf - flt.t > opt.hold || tf <= flt.t) {
      flt.t = tf; flt.q.copy(q); flt.p.copy(p); flt.vp = 0; flt.vr = 0;
      list.length = 0;
    } else {
      const dt = (tf - flt.t) / 1000; flt.t = tf;
      // скорость (сглаженная): положение — в ширинах листа/с, поворот — °/с
      const sp = p.distanceTo(flt.p) / dt, sr = 2 * Math.acos(Math.min(1, Math.abs(q.dot(flt.q)))) / DEG / dt;
      flt.vp += (sp - flt.vp) * alphaF(opt.dcut, dt);
      flt.vr += (sr - flt.vr) * alphaF(opt.dcut, dt);
      // вдали шум положения больше: частоту среза делим на расстояние (в ширинах листа, от 1)
      const dk = Math.max(1, p.length());
      if (opt.minPos > 0) flt.p.lerp(p, alphaF((opt.minPos + opt.betaPos * flt.vp) / Math.sqrt(dk), dt)); else flt.p.copy(p);
      flt.q.slerp(q, alphaF(opt.minRot + opt.betaRot * flt.vr, dt));
    }
    list.push({ tf, q: flt.q.clone(), p: flt.p.clone() });
    if (list.length > 30) list.shift();
    st.n++; st.last = tf;
    return true;
  }

  // поза для показа кадра tf: outQ — «лист → камера three», outP — центр листа (ширины листа). false — показывать нечего.
  function poseAt(tf, outQ, outP) {
    let a = null, b = null;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].tf > tf + 0.5) { b = list[i]; continue; }
      a = list[i]; break;
    }
    if (a && b && b.tf - a.tf <= opt.gap) {
      const w = (tf - a.tf) / Math.max(1, b.tf - a.tf);
      outQ.copy(a.q).slerp(b.q, w); outP.copy(a.p).lerp(b.p, w);
      return true;
    }
    if (a && tf - a.tf <= opt.hold) { outQ.copy(a.q); outP.copy(a.p); return true; }
    if (!a && b && b.tf - tf <= 60) { outQ.copy(b.q); outP.copy(b.p); return true; }
    return false;
  }
  // уже есть распознавание не раньше tf (кадр можно ставить «между»)
  const covered = (tf) => list.length > 0 && list[list.length - 1].tf >= tf - 0.5;
  // где углы листа на кадре tf (для участка поиска): по последней позе
  function predictCorners(tf) {
    if (!list.length || tf - list[list.length - 1].tf > opt.hold) return null;
    const L = list[list.length - 1], out = [];
    for (const [bx, by] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const v = tp.set(bx - 0.5, 0.5 - by, 0).applyQuaternion(L.q).add(L.p);
      if (v.z > -0.05) return null;
      out.push([cx + f * v.x / -v.z, cy - f * v.y / -v.z]);
    }
    return out;
  }
  return { add, poseAt, covered, predictCorners, setCamera, st, opt, reset() { list.length = 0; flt.t = null; },
    get f() { return f; }, get cx() { return cx; }, get cy() { return cy; } };
}
