// Распознавание листа с квадратными метками (AprilTag 16h5) — замена поиска MindAR (?marker=aruco).
//
// Чем это лучше картинки-метки: каждая квадратная метка находится на кадре с нуля, по её чёрной рамке, —
// не нужно искать «рядом с прошлым местом». Поэтому сцену невозможно «утащить»: на смазанном кадре
// метка просто не найдётся, а на следующем встанет точно на место. И это дёшево даже для слабых телефонов.
// На листе 9 меток (3×3): позу считаем по всем видимым углам сразу — точнее, и работает, даже если
// часть листа закрыта пальцем или не влезла в кадр.
//
// Координаты листа — в долях его ширины (0…1, y вниз); метка i занимает квадрат BOARD.s × BOARD.s
// (только чёрная часть, включая чёрную рамку), белые промежутки — BOARD.g.
import { AR, CV } from './vendor/aruco.mjs';
import jsfeat from './vendor/jsfeat.mjs';

// 3×3 — метки 5 см (по умолчанию): вблизи в кадре остаётся несколько меток;
// 2×2 — метки 8 см (?board=2): на тестах лучше переносили смаз, но на телефоне вблизи терялись. Листы разные.
// combo — комбинированный лист: в центре картинка MindAR (150 мм), сверху и снизу по 3 метки (45 мм, в 8 мм от картинки).
// Координаты combo — в долях ширины картинки от её левого верхнего угла (abs: true).
const CMB = (() => {
  const W = 150, m = 45, gap = 8, xs = [-15, 52.5, 120], rows = [-(gap + m), W + gap];
  const list = [];
  rows.forEach((y, r) => xs.forEach((x, c) => list.push({ id: r * 3 + c, x: x / W, y: y / W, s: m / W })));
  return list;
})();
export const BOARDS = {
  2: { cols: 2, rows: 2, s: 0.45, g: 0.10, firstId: 0 },
  3: { cols: 3, rows: 3, s: 0.28, g: 0.08, firstId: 0 },
  combo: { abs: true, list: CMB, cols: 6, rows: 1 },
};
export let BOARD = BOARDS[3];
export function setBoard(n) { BOARD = BOARDS[n] || BOARDS[3]; return BOARD; }

// углы метки id на листе (TL, TR, BR, BL) в долях ширины листа, или null, если такой метки на листе нет
export function boardCorners(id) {
  if (BOARD.abs) {
    const m = BOARD.list.find((q) => q.id === id);
    return m ? [[m.x, m.y], [m.x + m.s, m.y], [m.x + m.s, m.y + m.s], [m.x, m.y + m.s]] : null;
  }
  const k = id - BOARD.firstId;
  if (k < 0 || k >= BOARD.cols * BOARD.rows) return null;
  const c = k % BOARD.cols, r = Math.floor(k / BOARD.cols), x = c * (BOARD.s + BOARD.g), y = r * (BOARD.s + BOARD.g), s = BOARD.s;
  return [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
}

export function createFiducial() {
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const det = new AR.Detector({ dictionaryName: 'APRILTAG_16h5', maxHammingDistance: 2 });
  let W = 0, H = 0, gray = null, half = null, halfImg = null, useFull = false;
  const Hm = new jsfeat.matrix_t(3, 3, jsfeat.F32_t | jsfeat.C1_t);
  const homo = new jsfeat.motion_model.homography2d();
  const rp = new jsfeat.ransac_params_t(4, 3, 0.3, 0.995);
  const MAXP = 64;
  const from = Array.from({ length: MAXP }, () => ({ x: 0, y: 0 })), to = Array.from({ length: MAXP }, () => ({ x: 0, y: 0 }));
  const mask = new jsfeat.matrix_t(MAXP, 1, jsfeat.U8_t | jsfeat.C1_t);
  const stats = { ms: 0, markers: 0, total: BOARD.cols * BOARD.rows, err: 0, full: false };

  function alloc(w, h) {
    W = w; H = h; cv.width = w; cv.height = h;
    gray = new Uint8ClampedArray(w * h);
    half = new Uint8ClampedArray((w >> 1) * (h >> 1));
    halfImg = new CV.Image(w >> 1, h >> 1, half);
  }

  // уточнение угла до долей пикселя (как cornerSubPix в OpenCV): точка, где градиенты вокруг сходятся
  function subpix(px, py) {
    let x = px, y = py;
    const R = 4;
    for (let it = 0; it < 8; it++) {
      const cx = Math.round(x), cy = Math.round(y);
      if (cx < R + 2 || cy < R + 2 || cx > W - R - 3 || cy > H - R - 3) return [x, y];
      let a = 0, b = 0, c = 0, bx = 0, by = 0;
      for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) {
        const qx = cx + i, qy = cy + j, o = qy * W + qx;
        const gx = (gray[o + 1] - gray[o - 1]) * 0.5, gy = (gray[o + W] - gray[o - W]) * 0.5;
        const wgt = Math.exp(-(i * i + j * j) / (2 * 2.5 * 2.5));
        const gxx = gx * gx * wgt, gxy = gx * gy * wgt, gyy = gy * gy * wgt;
        a += gxx; b += gxy; c += gyy;
        bx += gxx * qx + gxy * qy; by += gxy * qx + gyy * qy;
      }
      const det2 = a * c - b * b;
      if (Math.abs(det2) < 1e-6) return [x, y];
      const nx = (c * bx - b * by) / det2, ny = (a * by - b * bx) / det2;
      if (Math.hypot(nx - px, ny - py) > 3) return [px, py];          // убежал далеко — не доверяем
      const done = Math.hypot(nx - x, ny - y) < 0.02;
      x = nx; y = ny;
      if (done) break;
    }
    return [x, y];
  }

  return {
    stats,
    // кадр → оттенки серого (полный размер) + уменьшенная вдвое копия для поиска
    grab(src) {
      const w = src.videoWidth || src.width, h = src.videoHeight || src.height;
      if (!w || !h) return false;
      if (w !== W || h !== H) alloc(w, h);
      ctx.drawImage(src, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (d[j] * 77 + d[j + 1] * 151 + d[j + 2] * 28) >> 8;
      const hw = w >> 1, hh = h >> 1;
      for (let y = 0; y < hh; y++) {
        const o0 = (y * 2) * w, o1 = o0 + w;
        for (let x = 0; x < hw; x++) { const x2 = x * 2; half[y * hw + x] = (gray[o0 + x2] + gray[o0 + x2 + 1] + gray[o1 + x2] + gray[o1 + x2 + 1]) >> 2; }
      }
      return true;
    },

    // Найти лист. markerW/markerH — размер метки MindAR (единицы её координат): лист шириной markerW,
    // по центру метки. Возвращает гомографию «координаты метки → кадр» (по строкам) или null.
    detect(markerW, markerH) {
      const t0 = performance.now();
      // поиск — на уменьшенном кадре; если на прошлых кадрах находилось мало меток (далеко) — на полном
      let img = useFull ? new CV.Image(W, H, gray) : halfImg, k = useFull ? 1 : 2;
      det.grey = img;
      CV.adaptiveThreshold(img, det.thres, 2, 7);
      det.contours = CV.findContours(det.thres, det.binary);
      let cand = det.findCandidates(det.contours, img.width * 0.01, 0.05, 6);
      cand = det.clockwiseCorners(cand);
      cand = det.notTooNear(cand, 6);
      const markers = det.findMarkers(img, cand, 36);
      // соответствия: углы меток на листе → углы в кадре (уточнённые)
      let n = 0;
      const seen = new Set();
      for (const m of markers) {
        const bc = boardCorners(m.id);
        if (!bc || seen.has(m.id) || n + 4 > MAXP) continue;
        seen.add(m.id);
        for (let i = 0; i < 4; i++) {
          // угол контура — центр крайнего чёрного пикселя; край чёрного квадрата — на полпикселя наружу
          const [sx, sy] = subpix(m.corners[i].x * k + (k - 1) * 0.5, m.corners[i].y * k + (k - 1) * 0.5);
          if (BOARD.abs) { from[n].x = bc[i][0] * markerW; from[n].y = bc[i][1] * markerW; }   // от угла картинки
          else { from[n].x = markerW / 2 + (bc[i][0] - 0.5) * markerW; from[n].y = markerH / 2 + (bc[i][1] - 0.5) * markerW; }
          to[n].x = sx; to[n].y = sy; n++;
        }
      }
      stats.markers = seen.size; stats.full = useFull;
      useFull = seen.size < 2 ? !useFull : false;                    // мало меток — пробуем другой масштаб
      if (n < 4) { stats.ms = performance.now() - t0; return null; }
      let ok;
      if (n >= 12) {
        ok = jsfeat.motion_estimator.ransac(rp, homo, from, to, n, Hm, mask, 100);
        if (ok) {                                                    // уточняем по всем «своим» точкам
          let m = 0;
          for (let i = 0; i < n; i++) if (mask.data[i]) { from[m].x = from[i].x; from[m].y = from[i].y; to[m].x = to[i].x; to[m].y = to[i].y; m++; }
          n = m;
          if (n >= 4) homo.run(from, to, Hm, n);
        }
      } else ok = homo.run(from, to, Hm, n);
      if (!ok || n < 4) { stats.ms = performance.now() - t0; return null; }
      const h = Array.from(Hm.data.subarray(0, 9));
      // средняя ошибка повторной проекции — для отладки
      let e = 0;
      for (let i = 0; i < n; i++) {
        const z = h[6] * from[i].x + h[7] * from[i].y + h[8];
        e += Math.hypot((h[0] * from[i].x + h[1] * from[i].y + h[2]) / z - to[i].x, (h[3] * from[i].x + h[4] * from[i].y + h[5]) / z - to[i].y);
      }
      stats.err = e / n;
      // центр видимых углов на метке (в координатах метки MindAR) — вокруг него поза определена надёжнее всего
      let cx = 0, cy = 0;
      for (let i = 0; i < n; i++) { cx += from[i].x; cy += from[i].y; }
      stats.cx = cx / n; stats.cy = cy / n;
      stats.ms = performance.now() - t0;
      return h;
    },
  };
}
