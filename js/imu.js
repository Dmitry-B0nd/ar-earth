// Датчики положения телефона (гироскоп + акселерометр, уже «склеенные» системой).
// Даёт направление «вверх» (против силы тяжести) в системе координат камеры.
// Камера three.js: X — вправо по экрану, Y — вверх по экрану, Z — из экрана к зрителю.
const DEG = Math.PI / 180;

export function createImu() {
  let beta = 0, gamma = 0, t = -1e9, count = 0, listening = false;

  function onOrient(e) {
    if (e.beta == null || e.gamma == null) return;
    beta = e.beta; gamma = e.gamma; t = performance.now(); count++;
  }

  return {
    // Вызывать прямо в обработчике нажатия кнопки, до любых await:
    // iOS разрешает спросить доступ к датчикам только в ответ на действие пользователя.
    request() {
      const D = window.DeviceOrientationEvent;
      if (D && typeof D.requestPermission === 'function') {
        return D.requestPermission().then((r) => r === 'granted').catch((e) => { console.warn('IMU: нет доступа', e); return false; });
      }
      return Promise.resolve(!!D);
    },
    start() {
      if (listening) return;
      listening = true;
      window.addEventListener('deviceorientation', onOrient);
    },
    get count() { return count; },
    fresh() { return performance.now() - t < 300; },

    // Вектор «вверх» в координатах камеры (единичный), записывается в out (THREE.Vector3)
    upCamera(out) {
      const b = beta * DEG, g = gamma * DEG;
      // «вверх» в координатах телефона (портрет): углы beta/gamma по стандарту W3C (порядок Z-X-Y)
      const x = -Math.cos(b) * Math.sin(g), y = Math.sin(b), z = Math.cos(b) * Math.cos(g);
      // поправка на поворот экрана (альбомная ориентация)
      const a = ((screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0) * DEG;
      return out.set(x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), z).normalize();
    },
  };
}
