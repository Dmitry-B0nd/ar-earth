// Движок 2: поиск листа квадратных меток (AprilTag 16h5, 3×3) на кадре. Без DOM — работает в фоновом потоке.
// Вход — RGBA уменьшенного участка кадра; выход — углы найденных меток в пикселях полного видео
// (уточнённые до долей пикселя) и гомография «лист → видео».
import { AR, CV } from '../vendor/aruco.mjs';
import jsfeat from '../vendor/jsfeat.mjs';

// раскладка листа (как в tools/make-aruco-board.py и js/fiducial.js): 3×3 метки, сторона s, промежуток g, в долях ширины поля
export const BOARD = { cols: 3, rows: 3, s: 0.28, g: 0.08 };
export function tagCorners(id) {
  if (id < 0 || id >= BOARD.cols * BOARD.rows) return null;
  const c = id % BOARD.cols, r = Math.floor(id / BOARD.cols), x = c * (BOARD.s + BOARD.g), y = r * (BOARD.s + BOARD.g), s = BOARD.s;
  return [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
}

export function createDetector() {
  const det = new AR.Detector({ dictionaryName: 'APRILTAG_16h5', maxHammingDistance: 1 });
  let W = 0, H = 0, gray = null, img = null;
  const MAXP = 64;
  const Hm = new jsfeat.matrix_t(3, 3, jsfeat.F32_t | jsfeat.C1_t);
  const homo = new jsfeat.motion_model.homography2d();
  const rp = new jsfeat.ransac_params_t(4, 2.5, 0.3, 0.995);
  const from = Array.from({ length: MAXP }, () => ({ x: 0, y: 0 })), to = Array.from({ length: MAXP }, () => ({ x: 0, y: 0 }));
  const mask = new jsfeat.matrix_t(MAXP, 1, jsfeat.U8_t | jsfeat.C1_t);

  function subpix(px, py) {
    let x = px, y = py;
    const R = 3;
    for (let it = 0; it < 8; it++) {
      const cx = Math.round(x), cy = Math.round(y);
      if (cx < R + 2 || cy < R + 2 || cx > W - R - 3 || cy > H - R - 3) return [x, y];
      let a = 0, b = 0, c = 0, bx = 0, by = 0;
      for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) {
        const qx = cx + i, qy = cy + j, o = qy * W + qx;
        const gx = (gray[o + 1] - gray[o - 1]) * 0.5, gy = (gray[o + W] - gray[o - W]) * 0.5;
        const wgt = Math.exp(-(i * i + j * j) / (2 * 2 * 2));
        const gxx = gx * gx * wgt, gxy = gx * gy * wgt, gyy = gy * gy * wgt;
        a += gxx; b += gxy; c += gyy;
        bx += gxx * qx + gxy * qy; by += gxy * qx + gyy * qy;
      }
      const d2 = a * c - b * b;
      if (Math.abs(d2) < 1e-6) return [x, y];
      const nx = (c * bx - b * by) / d2, ny = (a * by - b * bx) / d2;
      if (Math.hypot(nx - px, ny - py) > 2.5) return [px, py];
      const done = Math.hypot(nx - x, ny - y) < 0.02;
      x = nx; y = ny;
      if (done) break;
    }
    return [x, y];
  }

  // rgba: Uint8ClampedArray w×h×4 (или уже серый: gray=true); map: участок видео { sx, sy, kx, ky }:
  // пиксель (x, y) участка → видео (sx + (x + 0.5)·kx − 0.5, …)
  return function detect(rgba, w, h, map, isGray = false) {
    if (w !== W || h !== H) { W = w; H = h; gray = new Uint8ClampedArray(w * h); img = new CV.Image(w, h, gray); }
    if (isGray) gray.set(rgba.subarray(0, w * h));
    else for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (rgba[j] * 77 + rgba[j + 1] * 151 + rgba[j + 2] * 28) >> 8;
    det.grey = img;
    CV.adaptiveThreshold(img, det.thres, 2, 7);
    det.contours = CV.findContours(det.thres, det.binary);
    let cand = det.findCandidates(det.contours, w * 0.01, 0.05, 6);
    cand = det.clockwiseCorners(cand);
    cand = det.notTooNear(cand, 6);
    const markers = det.findMarkers(img, cand, 36);
    let n = 0, side = 0, nt = 0;
    const seen = new Set(), ids = [];
    for (const m of markers) {
      const bc = tagCorners(m.id);
      if (!bc || seen.has(m.id) || n + 4 > MAXP) continue;
      seen.add(m.id); ids.push(m.id);
      const c = m.corners;
      side += (Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y) + Math.hypot(c[2].x - c[1].x, c[2].y - c[1].y) + Math.hypot(c[3].x - c[2].x, c[3].y - c[2].y) + Math.hypot(c[0].x - c[3].x, c[0].y - c[3].y)) / 4;
      nt++;
      for (let i = 0; i < 4; i++) {
        const [x, y] = subpix(c[i].x, c[i].y);
        from[n].x = bc[i][0]; from[n].y = bc[i][1];
        to[n].x = map.sx + (x + 0.5) * map.kx - 0.5; to[n].y = map.sy + (y + 0.5) * map.ky - 0.5;
        n++;
      }
    }
    const res = { n: 0, tags: nt, ids, side: nt ? side / nt : 0, H: null, err: 0, pts: null };
    if (n < 4) return res;
    let ok;
    if (n >= 12) {
      ok = jsfeat.motion_estimator.ransac(rp, homo, from, to, n, Hm, mask, 100);
      if (ok) {
        let k = 0;
        for (let i = 0; i < n; i++) if (mask.data[i]) { from[k].x = from[i].x; from[k].y = from[i].y; to[k].x = to[i].x; to[k].y = to[i].y; k++; }
        n = k;
        if (n >= 4) ok = homo.run(from, to, Hm, n);
      }
    } else ok = homo.run(from, to, Hm, n);
    if (!ok || n < 4) return res;
    const hm = Array.from(Hm.data.subarray(0, 9));
    const pts = new Float32Array(n * 4);
    let e = 0;
    for (let i = 0; i < n; i++) {
      pts[i * 4] = from[i].x; pts[i * 4 + 1] = from[i].y; pts[i * 4 + 2] = to[i].x; pts[i * 4 + 3] = to[i].y;
      const z = hm[6] * from[i].x + hm[7] * from[i].y + hm[8];
      e += Math.hypot((hm[0] * from[i].x + hm[1] * from[i].y + hm[2]) / z - to[i].x, (hm[3] * from[i].x + hm[4] * from[i].y + hm[5]) / z - to[i].y);
    }
    res.n = n; res.H = hm; res.pts = pts; res.err = e / n;
    return res;
  };
}
