// Движок 2: фоновый поток распознавания. Главный поток (где рисуется сцена) им не занят.
// Принимает кадр (уменьшенный участок видео) — как RGBA-буфер или как ImageBitmap — и отвечает найденными углами меток.
// версия сборки — из адреса потока (?v=…), чтобы телефон не взял старый detect.js из кэша
const ready = import('./detect.js' + self.location.search).then((m) => m.createDetector());
let detect = null, cv = null, ctx = null;

self.onmessage = async (ev) => {
  const m = ev.data;
  if (!detect) detect = await ready;
  if (m.type !== 'frame') return;
  const t0 = performance.now();
  let data = m.data, w = m.w, h = m.h, readMs = 0;
  try {
    if (m.bitmap) {
      // кадр пришёл картинкой — читаем пиксели здесь, в фоне
      if (!cv) { cv = new OffscreenCanvas(w, h); ctx = cv.getContext('2d', { willReadFrequently: true }); }
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      ctx.drawImage(m.bitmap, 0, 0, w, h);
      m.bitmap.close();
      data = ctx.getImageData(0, 0, w, h).data;
      readMs = performance.now() - t0;
    }
    const r = detect(data, w, h, m.map, m.gray);
    const out = { type: 'res', id: m.id, tFrame: m.tFrame, ms: performance.now() - t0, readMs, w, h, ...r, buf: m.data ? m.data.buffer : null };
    const tr = [];
    if (out.pts) tr.push(out.pts.buffer);
    if (out.buf) tr.push(out.buf);
    self.postMessage(out, tr);
  } catch (e) {
    self.postMessage({ type: 'err', id: m.id, msg: String(e && e.message || e), buf: m.data ? m.data.buffer : null });
  }
};
ready.then(() => self.postMessage({ type: 'ready' }), (e) => self.postMessage({ type: 'fail', msg: String(e && e.message || e) }));
