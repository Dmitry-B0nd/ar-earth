// Движок 2: слияние гироскопа, акселерометра и распознавания листа меток.
//
// Идея: лист лежит в комнате неподвижно. Поэтому храним не «позу метки в кадре», а то, где лист
// находится В КОМНАТЕ: его поворот qMW и положение p (относительно телефона, в осях комнаты).
//   • поворот телефона на каждый кадр даёт гироскоп — точно и без задержки на распознавание;
//   • сдвиг телефона — акселерометр (на доли секунды между распознаваниями) + фильтр Калмана;
//   • распознавание (в отдельном потоке, с какой частотой успевает телефон) лишь поправляет qMW и p.
// Сцену рисуем ровно на момент съёмки показываемого кадра камеры — тогда она не «плавает» относительно видео.
//
// Единицы: ширина листа (поле меток) = 1; время в фильтре — секунды.
// Оси «комнаты» — как у датчиков: Z вверх. Оси камеры — как в three.js: X вправо, Y вверх, Z из экрана.
// Координаты на листе: X вправо, Y к верхнему краю листа, Z — от листа вверх (центр поля меток — 0).
import * as THREE from 'three';

const DEG = Math.PI / 180;

// ---------- Гомография → поза ----------
// h: «лист (bx, by в долях ширины, y вниз) → пиксель видео», по строкам.
// Возвращает поворот R (3×3 по строкам, из координат листа в оси камеры OpenCV: x вправо, y вниз, z вперёд)
// и сдвиг t (в ширинах листа), или null.
export function decomposeH(h, f, cx, cy) {
  // переход к координатам листа с центром в середине и Y вверх: (bx, by) = (X + 0.5, 0.5 − Y)
  const c0 = [h[0], h[3], h[6]], c1 = [-h[1], -h[4], -h[7]];
  const c2 = [0.5 * h[0] + 0.5 * h[1] + h[2], 0.5 * h[3] + 0.5 * h[4] + h[5], 0.5 * h[6] + 0.5 * h[7] + h[8]];
  const kinv = (c) => [(c[0] - cx * c[2]) / f, (c[1] - cy * c[2]) / f, c[2]];
  let r1 = kinv(c0), r2 = kinv(c1), t = kinv(c2);
  const n1 = Math.hypot(r1[0], r1[1], r1[2]), n2 = Math.hypot(r2[0], r2[1], r2[2]);
  if (!(n1 > 0 && n2 > 0)) return null;
  let lam = 2 / (n1 + n2);
  if (t[2] * lam < 0) lam = -lam;                         // лист перед камерой
  const sg = Math.sign(lam);
  r1 = r1.map((v) => v / n1 * sg); r2 = r2.map((v) => v / n2 * sg); t = t.map((v) => v * lam);
  // ортогонализация (биссектрисы): ближайшая пара перпендикулярных осей
  const s = [r1[0] + r2[0], r1[1] + r2[1], r1[2] + r2[2]], q = [r1[0] - r2[0], r1[1] - r2[1], r1[2] - r2[2]];
  const ns = Math.hypot(...s), nq = Math.hypot(...q);
  if (!(ns > 0 && nq > 0)) return null;
  for (let i = 0; i < 3; i++) { const u = s[i] / ns, w = q[i] / nq; r1[i] = (u + w) / Math.SQRT2; r2[i] = (u - w) / Math.SQRT2; }
  const r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
  return { R: [r1[0], r2[0], r3[0], r1[1], r2[1], r3[1], r1[2], r2[2], r3[2]], t };
}

// Сдвиг при известном повороте (по всем углам меток — линейная задача, 3 неизвестных).
// pts: [bx, by, u, v] × n. Возвращает { t, rms } (rms — ошибка повторной проекции, пиксели) или null.
export function solveT(R, pts, n, f, cx, cy) {
  let a00 = 0, a01 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0, b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const X = pts[i * 4] - 0.5, Y = 0.5 - pts[i * 4 + 1];
    const x = (pts[i * 4 + 2] - cx) / f, y = (pts[i * 4 + 3] - cy) / f;
    const qx = R[0] * X + R[1] * Y, qy = R[3] * X + R[4] * Y, qz = R[6] * X + R[7] * Y;
    // tx − x·tz = x·qz − qx ;  ty − y·tz = y·qz − qy
    const r0 = x * qz - qx, r1 = y * qz - qy;
    a00 += 1; a02 += -x; a22 += x * x; b0 += r0; b2 += -x * r0;
    a11 += 1; a12 += -y; a22 += y * y; b1 += r1; b2 += -y * r1;
  }
  const t = solve3([a00, a01, a02, a01, a11, a12, a02, a12, a22], [b0, b1, b2]);
  if (!t || !(t[2] > 0)) return null;
  return { t, rms: reprojRms(R, t, pts, n, f, cx, cy) };
}

export function reprojRms(R, t, pts, n, f, cx, cy) {
  let e = 0;
  for (let i = 0; i < n; i++) {
    const X = pts[i * 4] - 0.5, Y = 0.5 - pts[i * 4 + 1];
    const px = R[0] * X + R[1] * Y + t[0], py = R[3] * X + R[4] * Y + t[1], pz = R[6] * X + R[7] * Y + t[2];
    const du = f * px / pz + cx - pts[i * 4 + 2], dv = f * py / pz + cy - pts[i * 4 + 3];
    e += du * du + dv * dv;
  }
  return Math.sqrt(e / Math.max(1, n));
}

function solve3(A, b) {
  const [a, B, c, d, e, f, g, h, k] = A;
  const C0 = e * k - f * h, C1 = -(d * k - f * g), C2 = d * h - e * g;
  const det = a * C0 + B * C1 + c * C2;
  if (Math.abs(det) < 1e-12) return null;
  const inv = [C0, -(B * k - c * h), B * f - c * e, C1, a * k - c * g, -(a * f - c * d), C2, -(a * h - B * g), a * e - B * d];
  return [0, 1, 2].map((i) => (inv[i * 3] * b[0] + inv[i * 3 + 1] * b[1] + inv[i * 3 + 2] * b[2]) / det);
}
function inv3(A) {
  const [a, B, c, d, e, f, g, h, k] = A;
  const C0 = e * k - f * h, C1 = -(d * k - f * g), C2 = d * h - e * g;
  const det = a * C0 + B * C1 + c * C2;
  if (Math.abs(det) < 1e-18) return null;
  return [C0, -(B * k - c * h), B * f - c * e, C1, a * k - c * g, -(a * f - c * d), C2, -(a * h - B * g), a * e - B * d].map((v) => v / det);
}

// поворот (по строкам, оси OpenCV) → кватернион three.js «лист → камера three» (y и z камеры обратные)
const _m4 = new THREE.Matrix4();
export function quatFromRcv(R, out) {
  _m4.set(R[0], R[1], R[2], 0, -R[3], -R[4], -R[5], 0, -R[6], -R[7], -R[8], 0, 0, 0, 0, 1);
  return out.setFromRotationMatrix(_m4);
}
// кватернион «лист → камера three» → поворот по строкам в осях OpenCV
export function rcvFromQuat(q, out = new Array(9)) {
  const e = _m4.makeRotationFromQuaternion(q).elements;      // по столбцам
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[i * 3 + j] = (i === 0 ? 1 : -1) * e[j * 4 + i];
  return out;
}

// ---------- Фильтр Калмана: положение листа относительно телефона (в осях комнаты) ----------
// Состояние: p (3), v (3). Ускорение телефона a (комната) — вход: p'' = −a.
// mode: 'acc' — с акселерометром; 'cv' — без него (скорость затухает).
// Распознавание приходит с опозданием (кадр снят раньше, чем обработан) — поправку вносим на момент
// съёмки кадра и переносим вперёд по истории, чтобы следующие поправки сравнивались с исправленными данными.
export class Kf {
  static adapt = false;    // «разброс по обстановке» — на тестах дал меньше, чем повышение чёткости участка; выключен
  constructor(mode, { sigA, tauV, sig0 = null, kAct = 0 }) {
    this.mode = mode; this.sigA = sigA; this.tauV = tauV;
    // разброс ускорений «по обстановке»: телефон почти неподвижен — фильтр сильно усредняет распознавания (сцена не дрожит),
    // телефон резко двигают — быстро следует за ними. act — сколько сейчас ускоряется телефон (ед./с²), если известно
    this.sig0 = sig0; this.kAct = kAct; this.act = null;
    this.x = new Float64Array(6); this.P = new Float64Array(36);
    this.t = 0; this.ok = false;
    this.HN = 256; this.ht = new Float64Array(this.HN); this.hx = new Float64Array(this.HN * 6); this.hi = 0; this.hn = 0;
    this.nis = 3; this.perr = 4; this.lastMeasT = -1e9;
  }
  reset(p, t, sigP = 0.05, sigV = 2, v = null) {
    this.x.fill(0); this.x[0] = p[0]; this.x[1] = p[1]; this.x[2] = p[2];
    if (v && this.mode !== 'hold') { this.x[3] = v[0]; this.x[4] = v[1]; this.x[5] = v[2]; }
    this.P.fill(0);
    for (let i = 0; i < 3; i++) { this.P[i * 7] = sigP * sigP; this.P[(i + 3) * 7] = sigV * sigV; }
    this.t = t; this.ok = true; this.hn = 0; this.push(); this.lastMeasT = t;
  }
  push() {
    this.hi = (this.hi + 1) % this.HN; this.ht[this.hi] = this.t;
    for (let i = 0; i < 6; i++) this.hx[this.hi * 6 + i] = this.x[i];
    if (this.hn < this.HN) this.hn++;
  }
  // шаг вперёд до времени t (с), a — ускорение телефона в осях комнаты (ед./с²) или null
  predict(t, a, act) {
    if (act != null) this.act = act;
    if (!this.ok) return;
    let dt = t - this.t;
    if (dt <= 0) return;
    if (dt > 0.25) dt = 0.25;
    const x = this.x;
    // без распознавания дольше 0,5 с — перестаём «ехать»: сцена стоит в комнате на месте
    const stale = t - this.lastMeasT > 0.5;
    let useA = this.mode === 'acc' && a && !stale;
    // ускорение на отрезке — среднее между началом и концом (а не значение в конце: иначе запаздывание на полшага)
    let am = a;
    if (useA && this.lastA) { am = this._am || (this._am = [0, 0, 0]); for (let i = 0; i < 3; i++) am[i] = (a[i] + this.lastA[i]) / 2; }
    if (a) { this.lastA = this.lastA || [0, 0, 0]; this.lastA[0] = a[0]; this.lastA[1] = a[1]; this.lastA[2] = a[2]; } else this.lastA = null;
    const tau = stale || this.mode === 'hold' ? 0.02 : this.tauV;
    const d = Math.exp(-dt / tau);
    for (let i = 0; i < 3; i++) {
      const ai = useA ? -am[i] : 0;
      x[i] += x[i + 3] * dt * (1 + d) / 2 + 0.5 * ai * dt * dt;
      x[i + 3] = x[i + 3] * d + ai * dt;
    }
    // P = Φ P Φᵀ + Q (Φ: p += v·dt·(1+d)/2, v *= d)
    const P = this.P, g = dt * (1 + d) / 2;
    const T = this.T || (this.T = new Float64Array(36));
    for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) {     // T = Φ P
      if (r < 3) T[r * 6 + c] = P[r * 6 + c] + g * P[(r + 3) * 6 + c];
      else T[r * 6 + c] = d * P[r * 6 + c];
    }
    for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) {     // P = T Φᵀ
      if (c < 3) P[r * 6 + c] = T[r * 6 + c] + g * T[r * 6 + c + 3];
      else P[r * 6 + c] = d * T[r * 6 + c];
    }
    const sA = this.sig0 != null && this.act != null && Kf.adapt ? this.sig0 + this.kAct * this.act : this.sigA;
    const q = sA * sA * (stale ? 0.1 : 1);
    const q11 = q * dt * dt * dt * dt / 4, q12 = q * dt * dt * dt / 2, q22 = q * dt * dt;
    for (let i = 0; i < 3; i++) { P[i * 7] += q11; P[i * 6 + i + 3] += q12; P[(i + 3) * 6 + i] += q12; P[(i + 3) * 7] += q22; }
    this.t += dt; if (this.t < t) this.t = t;
    this.push();
  }
  // состояние на момент t (из истории), в out[6]; true — нашлось
  stateAt(t, out) {
    if (!this.ok) return false;
    if (t >= this.t) {
      const dt = Math.min(t - this.t, 0.1);
      for (let i = 0; i < 3; i++) { out[i] = this.x[i] + this.x[i + 3] * dt; out[i + 3] = this.x[i + 3]; }
      return true;
    }
    let k = this.hi;
    for (let n = 0; n < this.hn; n++) {
      const tk = this.ht[k];
      if (tk <= t) {
        const k2 = (k + 1) % this.HN;
        if (n > 0) {
          const t2 = this.ht[k2], w = t2 > tk ? (t - tk) / (t2 - tk) : 0;
          for (let i = 0; i < 6; i++) out[i] = this.hx[k * 6 + i] * (1 - w) + this.hx[k2 * 6 + i] * w;
        } else for (let i = 0; i < 6; i++) out[i] = this.hx[k * 6 + i];
        return true;
      }
      k = (k - 1 + this.HN) % this.HN;
    }
    // старше всей истории — самое раннее
    const k0 = (this.hi - this.hn + 1 + this.HN) % this.HN;
    for (let i = 0; i < 6; i++) out[i] = this.hx[k0 * 6 + i];
    return true;
  }
  // поправка по распознаванию: z (3) — положение листа на момент tm, Rm — его погрешность (3×3, по строкам)
  // Возвращает NIS (насколько поправка неожиданна) — или -1, если отброшена.
  update(tm, z, Rm, gate = Infinity, minPass = 0) {
    if (!this.ok) return -1;
    if (tm > this.t) this.predict(tm, null);
    const xs = new Float64Array(6);
    this.stateAt(tm, xs);
    const y = [z[0] - xs[0], z[1] - xs[1], z[2] - xs[2]];
    const P = this.P;
    const S = [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => P[r * 6 + c] + Rm[r * 3 + c]));
    const Si = inv3(S);
    if (!Si) return -1;
    const nis = y[0] * (Si[0] * y[0] + Si[1] * y[1] + Si[2] * y[2]) + y[1] * (Si[3] * y[0] + Si[4] * y[1] + Si[5] * y[2]) + y[2] * (Si[6] * y[0] + Si[7] * y[1] + Si[8] * y[2]);
    this.nis = this.nis * 0.85 + Math.min(nis, 60) * 0.15;
    // насколько предсказание промахнулось относительно погрешности самого измерения —
    // по этому сравниваем фильтры (NIS для сравнения не годится: у «осторожного» фильтра он всегда мал)
    const Ri = inv3(Rm);
    if (Ri) {
      const pe = y[0] * (Ri[0] * y[0] + Ri[1] * y[1] + Ri[2] * y[2]) + y[1] * (Ri[3] * y[0] + Ri[4] * y[1] + Ri[5] * y[2]) + y[2] * (Ri[6] * y[0] + Ri[7] * y[1] + Ri[8] * y[2]);
      this.lastPe = Math.log(1 + pe);
      this.perr = this.perr * 0.9 + this.lastPe * 0.1;      // в логарифме: различает и малые, и огромные промахи
    }
    if (nis > gate && Math.hypot(y[0], y[1], y[2]) > minPass) return -1;
    // K = P[:,0:3] S⁻¹ (6×3)
    const K = new Float64Array(18);
    for (let r = 0; r < 6; r++) for (let c = 0; c < 3; c++) K[r * 3 + c] = P[r * 6] * Si[c] + P[r * 6 + 1] * Si[3 + c] + P[r * 6 + 2] * Si[6 + c];
    const dx = new Float64Array(6);
    for (let r = 0; r < 6; r++) dx[r] = K[r * 3] * y[0] + K[r * 3 + 1] * y[1] + K[r * 3 + 2] * y[2];
    // переносим поправку вперёд: в историю после tm и в текущее состояние
    // (поправка скорости со временем затухает так же, как скорость в модели фильтра)
    const tau = this.mode === 'hold' ? 0.02 : this.tauV;
    const gp = (dt) => tau * (1 - Math.exp(-dt / tau)), gv = (dt) => Math.exp(-dt / tau);
    let k = this.hi;
    for (let n = 0; n < this.hn; n++) {
      const tk = this.ht[k];
      if (tk < tm) break;
      const a = gp(tk - tm), b = gv(tk - tm);
      for (let i = 0; i < 3; i++) { this.hx[k * 6 + i] += dx[i] + a * dx[i + 3]; this.hx[k * 6 + i + 3] += b * dx[i + 3]; }
      k = (k - 1 + this.HN) % this.HN;
    }
    const an = gp(this.t - tm), bn = gv(this.t - tm);
    for (let i = 0; i < 3; i++) { this.x[i] += dx[i] + an * dx[i + 3]; this.x[i + 3] += bn * dx[i + 3]; }
    // P = P − K S Kᵀ  (= P − K·P[0:3,:])
    const P0 = P.slice(0, 18);
    for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) P[r * 6 + c] -= K[r * 3] * P0[c] + K[r * 3 + 1] * P0[6 + c] + K[r * 3 + 2] * P0[12 + c];
    for (let r = 0; r < 6; r++) for (let c = r + 1; c < 6; c++) { const m = (P[r * 6 + c] + P[c * 6 + r]) / 2; P[r * 6 + c] = P[c * 6 + r] = m; }
    this.lastMeasT = Math.max(this.lastMeasT, tm);
    return nis;
  }
}

// ---------- Всё вместе ----------
// sensors: { camAt(t, outQ) → bool (ориентация камеры в комнате на момент t, мс), devAt(t, outQ) → bool, rateAt(t) → рад/с }
export function createFusion(opts = {}) {
  const o = {
    boardM: 0.18,        // ширина поля меток, метры (для акселерометра)
    lag: 50,             // начальная задержка кадра относительно датчиков, мс
    autoLag: true, autoF: true,
    alphaQ: 0.35,        // скорость поправки поворота листа
    blendMs: 90,         // поправки на экране — плавно за это время
    sigPx: 0.6,          // погрешность угла метки на кадре, пиксели (на резком кадре)
    expo: 0.016,         // время выдержки камеры, с (для оценки смаза)
    snapDeg: 12,         // лист лежит горизонтально, если наклон < этого
    sigAacc: 1.5, sigAcv: 5,   // разброс ускорений, м/с²: с акселерометром / без (если не знаем, как движется телефон)
    accSig0: 0.3, accK: 0.3,   // …а если знаем: с акселерометром — 0,3 м/с² + 30% текущего ускорения
    cvSig0: 0.8, cvK: 1.2,     // без использования ускорения в прогнозе — 0,8 м/с² + 120% ускорения
    ...opts,
  };
  const S = o.sensors;
  const nowf = o.now || (() => performance.now());
  const st = {
    f: o.f, cx: 0, cy: 0, W: 0, H: 0, lag: o.lag,
    init: false, qMW: new THREE.Quaternion(), snapped: false, tiltAvg: null,
    qOut: 0, qOutRef: new THREE.Quaternion(),
    filt: 'cv', posOut: 0, lastMeas: -1e9, lastMeasFrame: -1e9, resets: 0,
    gyro: false,
    calib: { lagJ: null, fJ: null, samples: [], lastRun: 0, turn: 0, lagRuns: 0, fRuns: 0, spread: null },
    diag: { n: 0, rej: 0, blurRej: 0, corr: 0, corrN: 0, rmsK: 0, rmsH: 0, nis: {}, blur: 0, inconsist: 0 },
  };
  const ka = o.sigAacc / o.boardM, kc = o.sigAcv / o.boardM, u = 1 / o.boardM;
  const filters = {
    'acc+': new Kf('acc', { sigA: ka, tauV: 3, sig0: o.accSig0 * u, kAct: o.accK }),
    'acc-': new Kf('acc', { sigA: ka, tauV: 3, sig0: o.accSig0 * u, kAct: o.accK }),
    cv: new Kf('cv', { sigA: kc, tauV: 0.6, sig0: o.cvSig0 * u, kAct: o.cvK }),
    hold: new Kf('hold', { sigA: kc * 2, tauV: 0.02, sig0: o.cvSig0 * 2 * u, kAct: o.cvK * 2 }),    // без скорости: «стоит, где видели» (запасной, никогда не разгоняется)
  };
  let gSign = 0, lastAccT = -1e9, actPeak = 0, actT = 0;     // знак ускорения у этого браузера: +1 как в стандарте, -1 обратный, 0 — неизвестно
  const offP = new THREE.Vector3(), qOff = new THREE.Quaternion();
  let lastOutT = null;
  const tq = new THREE.Quaternion(), tq2 = new THREE.Quaternion(), tv = new THREE.Vector3(), tv2 = new THREE.Vector3();
  const xs = new Float64Array(6);

  function setCamera(W, H, f) {
    st.W = W; st.H = H; st.cx = (W - 1) / 2; st.cy = (H - 1) / 2;
    if (f) st.f = f;
  }

  // ---- датчики движения: ускорение (м/с², оси телефона) с отметкой времени, мс ----
  const qD = new THREE.Quaternion(), qDi = new THREE.Quaternion(), up = new THREE.Vector3();
  let gVotes = 0;
  function motion(t, acc, accG) {
    const ts = t / 1000;
    let aW = null;
    if (S.devAt(t, qD)) {
      // знак: ускорение с учётом тяжести в покое по стандарту направлено ВВЕРХ
      if (accG && accG[0] != null) {
        const m = Math.hypot(accG[0], accG[1], accG[2]);
        if (m > 8.8 && m < 10.8) {
          up.set(0, 0, 1).applyQuaternion(qDi.copy(qD).invert());
          const d = (accG[0] * up.x + accG[1] * up.y + accG[2] * up.z) / m;
          if (Math.abs(d) > 0.8) { gVotes = Math.max(-50, Math.min(50, gVotes + Math.sign(d))); gSign = gVotes > 5 ? 1 : gVotes < -5 ? -1 : gSign; }
        }
      }
      if (acc && acc[0] != null) lastAccT = t;
      if (acc && acc[0] != null) aW = tv.set(acc[0], acc[1], acc[2]).applyQuaternion(qD).multiplyScalar(1 / o.boardM);
    }
    const s = gSign || 1;
    let act = null;
    if (aW) {
      const m = aW.length();
      actPeak = Math.max(m, actPeak * Math.exp(-Math.max(0, t - actT) / 150)); actT = t;
      act = actPeak;
    }
    if (aW) {
      const ap = [aW.x * s, aW.y * s, aW.z * s], am = [-ap[0], -ap[1], -ap[2]];
      filters['acc+'].predict(ts, ap, act); filters['acc-'].predict(ts, am, act);
    } else { filters['acc+'].predict(ts, null); filters['acc-'].predict(ts, null); }
    filters.cv.predict(ts, null, act); filters.hold.predict(ts, null, act);
  }
  // если датчик движения молчит — двигаем время фильтров сами
  function tickTo(t) { for (const k in filters) if (filters[k].t < t / 1000 - 0.03) filters[k].predict(t / 1000, null); }

  // ---- распознавание ----
  // d: { tFrame (мс), pts: Float32Array [bx,by,u,v]×n, n, H (9) } — в пикселях видео
  const qWC = new THREE.Quaternion(), qCM = new THREE.Quaternion(), qMeas = new THREE.Quaternion(), qT = new THREE.Quaternion();
  const zAx = new THREE.Vector3(0, 0, 1);
  const resetTimes = [], ban = {}; let forceReset = false;
  let outlierQ = 0, outlierP = 0, lastOutlierQ = new THREE.Quaternion(), lastZ = null, lastZt = 0, lastZblur = 0;
  function measure(d) {
    const tm = d.tFrame - st.lag;
    st.gyro = S.camAt(tm, qWC);
    if (!st.gyro) qWC.identity();
    const dec = decomposeH(d.H, st.f, st.cx, st.cy);
    if (!dec) { st.diag.rej++; return { ok: false, why: 'гомография' }; }
    const rmsH = reprojRms(dec.R, dec.t, d.pts, d.n, st.f, st.cx, st.cy);
    quatFromRcv(dec.R, qCM);
    qMeas.copy(qWC).multiply(qCM);                       // лист в комнате (по этому кадру)
    if (st.gyro && d.n >= 8) calibAdd(d, S.rateAt(tm));

    // смаз: скорость поворота × выдержка × фокус
    const rate = st.gyro ? S.rateAt(tm) : 0;
    const blurPx = rate * o.expo * st.f;
    st.diag.blur = blurPx;
    // погрешность углов — не меньше, чем фактическая ошибка подгонки гомографии на этом кадре
    const sig = Math.max(o.sigPx, d.n >= 8 ? 1.2 * rmsH : 0) + 0.35 * blurPx;
    // смазанный кадр с плохой подгонкой: углы найдены криво — такой кадр скорее утащит сцену, чем поправит
    if (o.blurRej !== false && st.init && blurPx > 10 && rmsH > 1.5 + 0.2 * blurPx) { st.diag.rej++; st.diag.blurRej++; return { ok: false, why: 'смаз' }; }

    // --- поворот листа ---
    const n = tv.copy(zAx).applyQuaternion(qMeas);
    const tilt = Math.acos(Math.max(-1, Math.min(1, n.z))) / DEG;
    if (st.gyro) {
      st.tiltAvg = st.tiltAvg === null ? tilt : st.tiltAvg + 0.15 * (tilt - st.tiltAvg);
      if (st.snapped ? st.tiltAvg > o.snapDeg + 4 : st.tiltAvg < o.snapDeg) st.snapped = !st.snapped;
    } else st.snapped = false;
    if (st.snapped) {
      // лежит горизонтально: наклон точно знаем по гравитации, по кадру берём только разворот на столе
      const xw = tv2.set(1, 0, 0).applyQuaternion(qMeas);
      qT.setFromAxisAngle(zAx, Math.atan2(xw.y, xw.x));
    } else qT.copy(qMeas);

    const qBefore = tq.copy(st.qMW);
    let reset = !st.init || forceReset;
    forceReset = false;
    if (st.init && !reset) {
      const ang = 2 * Math.acos(Math.min(1, Math.abs(qT.dot(st.qMW)))) / DEG;
      if (ang > 20) {
        // сильно не совпало: один раз — пропускаем; несколько раз подряд и согласованно — лист переложили
        const cons = outlierQ > 0 && 2 * Math.acos(Math.min(1, Math.abs(qT.dot(lastOutlierQ)))) / DEG < 8;
        outlierQ = cons ? outlierQ + 1 : 1; lastOutlierQ.copy(qT);
        if (outlierQ >= 3) reset = true;
        else { st.diag.rej++; return { ok: false, why: 'поворот' }; }
      } else {
        outlierQ = 0;
        // мелкое расхождение — скорее шум распознавания (особенно издалека): поправляем по чуть-чуть;
        // крупное — правда (гироскоп «уплыл», лист сдвинули): быстро
        const a = o.oldAlpha ? (st.snapped ? o.alphaQ : o.alphaQ * 0.6) : Math.min(o.alphaQ, Math.max(0.05, ang / (st.snapped ? 6 : 10)));
        st.qMW.slerp(qT, a * (d.n >= 8 ? 1 : 0.5));
      }
    }
    if (reset) { st.qMW.copy(qT); outlierQ = 0; }

    // --- положение: при известном повороте — по всем углам меток ---
    const qCMf = tq2.copy(qWC).invert().multiply(st.qMW);
    const Rk = rcvFromQuat(qCMf);
    let sol = solveT(Rk, d.pts, d.n, st.f, st.cx, st.cy);
    let tCam = sol ? sol.t : null, rms = sol ? sol.rms : Infinity;
    st.diag.rmsK = rms; st.diag.rmsH = rmsH;
    // поворот из фильтра не сходится с кадром (лист сдвинули/наклонили, или поворот ещё не устоялся) —
    // берём позу целиком по кадру и быстрее подтягиваем поворот
    if (!sol || rms > Math.max(3 * rmsH, 2.5 + blurPx * 0.5)) {
      st.diag.inconsist++;
      tCam = dec.t; rms = rmsH;
      if (!reset) st.qMW.slerp(qT, 0.5);
    }
    // в оси комнаты (из осей OpenCV: y, z обратные)
    const pW = tv.set(tCam[0], -tCam[1], -tCam[2]).applyQuaternion(qWC);
    // погрешность: поперёк взгляда — sig·Z/f, по глубине — Z·sig·2/(размах точек на кадре)
    let sx = 0, sy = 0, mx = 0, my = 0;
    for (let i = 0; i < d.n; i++) { mx += d.pts[i * 4 + 2]; my += d.pts[i * 4 + 3]; }
    mx /= d.n; my /= d.n;
    for (let i = 0; i < d.n; i++) { sx += (d.pts[i * 4 + 2] - mx) ** 2; sy += (d.pts[i * 4 + 3] - my) ** 2; }
    const span = Math.max(8, Math.sqrt((sx + sy) / d.n) * 2);
    const Z = tCam[2], s2 = sig + rms * 0.5;
    const sl = s2 * Z / st.f, sd = Z * s2 * 2.5 / span;
    // R_w = Rwc · diag(sl², sl², sd²) · Rwcᵀ  (ось взгляда камеры three — Z)
    const e = _m4.makeRotationFromQuaternion(qWC).elements;
    const Rm = new Array(9);
    const dg = [sl * sl, sl * sl, sd * sd];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      let v = 0;
      for (let k = 0; k < 3; k++) v += e[k * 4 + r] * dg[k] * e[k * 4 + c];
      Rm[r * 3 + c] = v;
    }

    const tms = tm / 1000, z = [pW.x, pW.y, pW.z];
    // что сейчас на экране — чтобы поправка вошла плавно
    const before = lastOutT !== null ? currentP(lastOutT, tv2.set(0, 0, 0)).clone() : null;
    // скорость — по двум последним распознаваниям (если были недавно), чтобы после сброса не начинать «с места»
    const vEst = lastZ && lastZblur < 8 && blurPx < 8 && tms - lastZt > 0.02 && tms - lastZt < 0.35 ? [0, 1, 2].map((i) => (z[i] - lastZ[i]) / (tms - lastZt)) : null;
    if (reset || !filters.cv.ok) {
      for (const k in filters) filters[k].reset(z, tms, Math.max(sl, sd) * 2, 2, vEst);
      st.resets += reset && st.init ? 1 : 0;
      outlierP = 0;
    } else {
      // сильно неожиданное положение: пропускаем; дважды подряд — значит, правда так, начинаем заново
      // (у каждого фильтра свой счётчик: запасной фильтр, отставший от жизни, тоже надо перезапускать)
      for (const k in filters) {
        const F = filters[k];
        const g = F.update(tms, z, Rm, 80, 0.05 * Z);
        if (g < 0) {
          F.rejects = (F.rejects || 0) + 1;
          if (k === st.filt) st.diag.rej++;
          if (F.rejects >= 2) {
            F.reset(z, tms, Math.max(sl, sd) * 2, 2, vEst); F.rejects = 0; F.perr = 4;
            if (k === st.filt) {
              st.resets++;
              // выбранный фильтр сбрасывается раз за разом — значит, его предсказание сейчас вредит:
              // на 2 с он не участвует в выборе
              resetTimes.push(nowf()); while (resetTimes.length && resetTimes[0] < nowf() - 2000) resetTimes.shift();
              if (resetTimes.length >= 2 && k !== 'hold') { ban[k] = nowf() + 2000; resetTimes.length = 0; }
            }
          }
        } else F.rejects = 0;
      }
      chooseFilter();
    }
    lastZ = z; lastZt = tms; lastZblur = blurPx;
    for (const k in filters) st.diag.nis[k] = filters[k].perr;
    // плавность: разница между старым и новым видом уходит за blendMs
    if (before && st.init && !reset) {
      const after = currentP(lastOutT, tv2.set(0, 0, 0));
      const dP = before.sub(after);
      offP.add(dP);
      st.diag.corr += dP.length() / Math.max(0.3, after.length()) * st.f; st.diag.corrN++;
      qOff.multiply(qBefore.multiply(tq2.copy(st.qMW).invert()));
    } else if (reset) { offP.set(0, 0, 0); qOff.identity(); }
    st.init = true; st.lastMeas = nowf(); st.lastMeasFrame = d.tFrame;
    st.diag.n++;
    return { ok: true, reset };
  }

  let signEv = 0;
  function chooseFilter() {
    const A = filters['acc+'], B = filters['acc-'];
    if (actPeak * o.boardM > 0.6 && A.lastPe != null && B.lastPe != null) signEv = Math.max(-40, Math.min(40, signEv * 0.98 + (A.lastPe - B.lastPe)));
    // лучший — у кого поправки самые «ожидаемые» (с запасом, чтобы не прыгать туда-сюда)
    // «обратный знак» ускорения — только если правда лучше (знак обычно известен по гравитации)
    // Знак ускорения: сначала — по гравитации; но если при заметных рывках «обратный» фильтр раз за разом
    // предсказывает лучше — значит, у этого браузера ускорение и гравитация с разными знаками: переходим на него
    const wrong = signEv > 25 ? 'acc+' : 'acc-';
    const score = (k) => filters[k].perr + (k === wrong && (gSign !== 0 || signEv > 25) ? (Math.abs(gVotes) >= 20 || signEv > 25 ? 5 : 0.5) : 0);
    if (o.force) { st.filt = o.force; return; }
    const banned = (k) => nowf() < (ban[k] || 0);
    if (banned(st.filt)) st.filt = 'hold';
    // нет данных акселерометра — фильтры «с ускорением» не участвуют
    const accOk = nowf() - lastAccT < 1000;
    if (!accOk && st.filt.startsWith('acc')) st.filt = filters.cv.perr <= filters.hold.perr ? 'cv' : 'hold';
    let best = st.filt;
    for (const k in filters) if ((accOk || !k.startsWith('acc')) && !banned(k) && score(k) < score(best) - 0.35) best = k;
    if (best !== st.filt) st.filt = best;
  }

  function currentP(tMs, out) {
    filters[st.filt].stateAt(tMs / 1000, xs);
    return out.set(xs[0], xs[1], xs[2]);
  }

  // ---- поза для показа: на момент съёмки показываемого кадра ----
  // outQ: поворот «лист → камера three», outP: центр листа в осях камеры three. false — показывать нечего.
  let lastPoseNow = null;
  const qCam = new THREE.Quaternion();
  function poseAt(tFrame, outQ, outP, now = nowf()) {
    if (!st.init) return false;
    const t = tFrame - st.lag;
    if (!S.camAt(t, qCam)) qCam.identity();
    // плавное «растворение» поправок
    const dt = lastPoseNow === null ? 0 : Math.max(0, now - lastPoseNow);
    lastPoseNow = now;
    const k = Math.exp(-dt / o.blendMs);
    offP.multiplyScalar(k);
    qOff.slerp(tq.identity(), 1 - k);
    tickTo(t);
    currentP(t, outP).add(offP);
    lastOutT = t;
    const qInv = tq2.copy(qCam).invert();
    outQ.copy(qInv).multiply(qOff).multiply(st.qMW);
    outP.applyQuaternion(qInv);
    return true;
  }
  // «вверх» (против тяжести) в координатах листа
  function upInMarker(out) {
    if (!st.init || !st.gyro) return false;
    return out.set(0, 0, 1).applyQuaternion(tq.copy(qOff).multiply(st.qMW).invert()).normalize();
  }

  // ---- автокалибровка: задержка кадра и фокус камеры ----
  // Лист неподвижен, значит его поворот в комнате (гироскоп × поворот по кадру) должен быть одним и тем же
  // на всех кадрах. При неверной задержке он «гуляет» при поворотах телефона, при неверном фокусе —
  // при смене угла взгляда. Ищем задержку и фокус, при которых разброс меньше всего.
  // Сдвиги телефона на это не влияют (используется только поворот) — в отличие от прошлой калибровки.
  const C = st.calib;
  function calibAdd(d, rate) {
    C.samples.push({ t: d.tFrame, H: Array.from(d.H), rate });
    const cut = nowf() - 8000;
    while (C.samples.length && (C.samples[0].t < cut || C.samples.length > 80)) C.samples.shift();
  }
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  // разброс поворота листа в комнате: cams[i] — поворот камеры, cms[i] — поворот листа относительно камеры
  // sys=true — без «шумовой» части: разброс между соседними кадрами (быстрый шум распознавания) вычитаем,
  // иначе подбор фокуса тянется туда, где шум просто меньше (а не туда, где фокус верный)
  function spread(cams, cms, sys = false) {
    const arr = [], ts = [];
    const mean = [0, 0, 0, 0];
    let ref = null;
    for (let i = 0; i < cams.length; i++) {
      if (!cams[i] || !cms[i]) continue;
      const q = qa.copy(cams[i]).multiply(cms[i]).clone();
      if (!ref) ref = q;
      const sg = q.dot(ref) < 0 ? -1 : 1;
      mean[0] += q.x * sg; mean[1] += q.y * sg; mean[2] += q.z * sg; mean[3] += q.w * sg;
      arr.push(q); ts.push(C.samples[i].t);
    }
    if (arr.length < 15) return null;
    const m = new THREE.Quaternion(mean[0], mean[1], mean[2], mean[3]).normalize();
    const angs = arr.map((q) => 2 * Math.acos(Math.min(1, Math.abs(q.dot(m)))) / DEG).sort((a, b) => a - b);
    if (!sys) return angs[Math.floor(angs.length * 0.5)] * 0.5 + angs[Math.floor(angs.length * 0.75)] * 0.5;
    const trim = (a) => { a.sort((x, y) => x - y); const k = Math.max(1, Math.floor(a.length * 0.9)); let q2 = 0; for (let i = 0; i < k; i++) q2 += a[i] * a[i]; return q2 / k; };
    const tot = trim(angs.slice());
    const dif = [];
    for (let i = 1; i < arr.length; i++) if (ts[i] - ts[i - 1] < 150) dif.push(2 * Math.acos(Math.min(1, Math.abs(arr[i].dot(arr[i - 1])))) / DEG);
    if (dif.length < 10) return null;
    return Math.sqrt(Math.max(0, tot - trim(dif) / 2));
  }
  // Фокус по гравитации: лист лежит горизонтально, значит его нормаль (по кадру, переведённая в комнату гироскопом)
  // должна смотреть строго вверх. При неверном фокусе она отклоняется — тем сильнее, чем косее смотрят на лист.
  // Работает и когда телефон почти неподвижен (в отличие от разброса), и шум на неё почти не влияет.
  function gravErr(cams, cms) {
    const a = [];
    for (let i = 0; i < cams.length; i++) {
      if (!cams[i] || !cms[i] || C.samples[i].rate > 0.5) continue;
      const n = tv.set(0, 0, 1).applyQuaternion(cms[i]).applyQuaternion(cams[i]);
      a.push(Math.acos(Math.max(-1, Math.min(1, n.z))) / DEG);
    }
    if (a.length < 12) return null;
    a.sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  }
  const camsAt = (lag) => C.samples.map((s) => { const q = new THREE.Quaternion(); return S.camAt(s.t - lag, q) ? q : null; });
  const cmsAt = (f) => C.samples.map((s) => { const d = decomposeH(s.H, f, st.cx, st.cy); return d ? quatFromRcv(d.R, new THREE.Quaternion()) : null; });
  // насколько «раскачан» телефон в окне: поворот (для задержки) и разнообразие углов взгляда (для фокуса)
  function excitation() {
    let maxRot = 0, minV = Infinity, maxV = -Infinity, sumV = 0, nV = 0;
    const s0 = C.samples[0];
    if (!s0 || !S.camAt(s0.t - st.lag, qa)) return { rot: 0, view: 0 };
    for (const s of C.samples) {
      if (!S.camAt(s.t - st.lag, qb)) continue;
      maxRot = Math.max(maxRot, 2 * Math.acos(Math.min(1, Math.abs(qa.dot(qb)))) / DEG);
      const dec = decomposeH(s.H, st.f, st.cx, st.cy);
      if (dec) { const v = Math.acos(Math.min(1, Math.abs(dec.R[8]))) / DEG; minV = Math.min(minV, v); maxV = Math.max(maxV, v); sumV += v; nV++; }
    }
    return { rot: maxRot, view: maxV - minV, oblique: nV ? sumV / nV : 0 };
  }
  function calibStep(now = nowf()) {
    if (now - C.lastRun < 700 || C.samples.length < 20) return;
    C.lastRun = now;
    const ex = excitation();
    C.turn = (C.turn + 1) % 2;
    if (C.turn === 0 && o.autoLag && ex.rot > 8) {
      const cms = cmsAt(st.f);
      const cur = spread(camsAt(st.lag), cms);
      let best = st.lag, bj = cur;
      for (let L = -60; L <= 200; L += 15) { const j = spread(camsAt(L), cms); if (j !== null && (bj === null || j < bj)) { bj = j; best = L; } }
      for (let L = best - 9; L <= best + 9; L += 3) { const j = spread(camsAt(L), cms); if (j !== null && j < bj) { bj = j; best = L; } }
      C.lagJ = bj; C.spread = cur;
      // далеко от текущей и заметно лучше — сразу; близко — понемногу (оценка шумит)
      if (cur !== null && bj < cur * 0.98 && Math.abs(best - st.lag) >= 2) {
        st.lag += (best - st.lag) * (bj < cur * 0.8 ? 0.8 : 0.4); C.lagRuns++;
      }
    } else if (C.turn === 1 && o.autoF && st.snapped && st.tiltAvg < 8 && ex.oblique > 20) {
      // лист на столе: фокус — по гравитации
      const cams = camsAt(st.lag);
      const cur = gravErr(cams, cmsAt(st.f));
      let best = 1, bj = cur;
      for (let k = 0.85; k <= 1.151; k += 0.01) { const j = gravErr(cams, cmsAt(st.f * k)); if (j !== null && j < bj) { bj = j; best = k; } }
      C.fJ = bj; C.spread = cur; C.fMode = 'гравит.';
      const dir = cur !== null && cur - bj > 0.3 && Math.abs(best - 1) > 0.008 ? Math.sign(best - 1) : 0;
      if (dir && dir === C.fDir) {
        const long = Math.max(st.W, st.H);
        const nf = st.f * (1 + Math.max(-0.04, Math.min(0.04, (best - 1) * 0.6)));
        const fov = 2 * Math.atan(long / 2 / nf) / DEG;
        if (fov > 50 && fov < 82) { st.f = nf; C.fRuns++; }
      }
      C.fDir = dir;
    } else if (C.turn === 1 && o.autoF && ex.view > 12) {
      C.fMode = 'разброс';
      const cams = camsAt(st.lag);
      const cur = spread(cams, cmsAt(st.f), true);
      let best = 1, bj = cur;
      for (let k = 0.88; k <= 1.121; k += 0.02) { const j = spread(cams, cmsAt(st.f * k), true); if (j !== null && j < bj) { bj = j; best = k; } }
      C.fJ = bj; C.spread = cur;
      // меняем, только если два подбора подряд согласны (одиночный — может быть случайностью шума), и не больше чем на 3%
      const dir = cur !== null && bj < cur * 0.85 && Math.abs(best - 1) > 0.015 ? Math.sign(best - 1) : 0;
      if (dir && dir === C.fDir) {
        const long = Math.max(st.W, st.H);
        const nf = st.f * (1 + Math.max(-0.03, Math.min(0.03, (best - 1) * 0.5)));
        const fov = 2 * Math.atan(long / 2 / nf) / DEG;
        if (fov > 50 && fov < 82) { st.f = nf; C.fRuns++; }
      }
      C.fDir = dir;
    }
  }

  return {
    st, filters, setCamera, motion, measure, poseAt, upInMarker, calibStep, tickTo,
    get f() { return st.f; }, get lag() { return st.lag; }, get gSign() { return gSign; },
    get signEv() { return signEv; },
    get fov() { return 2 * Math.atan(Math.max(st.W, st.H) / 2 / st.f) / DEG; },
    reset() { st.init = false; for (const k in filters) filters[k].ok = false; offP.set(0, 0, 0); qOff.identity(); },
    // лист долго не было видно: следующее распознавание принимаем как есть (телефон могли унести, лист — переложить),
    // но плавно — без рывка на экране
    reacquire() { forceReset = true; },
    // предсказанные углы поля меток на кадре (пиксели видео) на момент tFrame — для выбора области поиска
    predictCorners(tFrame) {
      if (!st.init) return null;
      const t = tFrame - st.lag;
      if (!S.camAt(t, qCam)) qCam.identity();
      filters[st.filt].stateAt(t / 1000, xs);
      const qInv = tq2.copy(qCam).invert();
      const qc = tq.copy(qInv).multiply(st.qMW);
      const pc = tv.set(xs[0], xs[1], xs[2]).applyQuaternion(qInv);
      const out = [];
      for (const [X, Y] of [[-0.5, 0.5], [0.5, 0.5], [0.5, -0.5], [-0.5, -0.5]]) {
        const p = tv2.set(X, Y, 0).applyQuaternion(qc).add(pc);
        if (p.z > -0.01) return null;                         // за камерой
        out.push([st.cx + st.f * p.x / -p.z, st.cy - st.f * p.y / -p.z]);
      }
      return out;
    },
  };
}
