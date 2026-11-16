// Датчики положения телефона (гироскоп + акселерометр, уже «склеенные» системой).
// Даёт ориентацию камеры телефона в «мире» (Z мира — вверх, против силы тяжести) и направление «вверх».
// Камера three.js: X — вправо по экрану, Y — вверх по экрану, Z — из экрана к зрителю.
import * as THREE from 'three';

const DEG = Math.PI / 180;

export function createImu() {
  let alpha = 0, beta = 0, gamma = 0, hasAlpha = false, t = -1e9, count = 0, listening = false;
  // короткая история показаний — чтобы можно было взять ориентацию «на N мс раньше»
  // (кадр камеры доходит до программы с небольшой задержкой)
  const HIST = 32, hist = Array.from({ length: HIST }, () => ({ t: -1e9, a: 0, b: 0, g: 0 }));
  let hi = 0;
  const euler = new THREE.Euler(), qScreen = new THREE.Quaternion(), zAxis = new THREE.Vector3(0, 0, 1);

  function onOrient(e) {
    if (e.beta == null || e.gamma == null) return;
    beta = e.beta; gamma = e.gamma;
    hasAlpha = e.alpha != null;
    alpha = hasAlpha ? e.alpha : 0;
    t = performance.now(); count++;
    const h = hist[hi = (hi + 1) % HIST]; h.t = t; h.a = alpha; h.b = beta; h.g = gamma;
  }
  const screenAngle = () => ((screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0) * DEG;

  const api = {
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
    get hasAlpha() { return hasAlpha; },
    fresh() { return performance.now() - t < 300; },

    // Ориентация камеры в мире: кватернион «из координат камеры в координаты мира».
    // Углы по стандарту W3C: R = Rz(alpha)·Rx(beta)·Ry(gamma); плюс поправка на поворот экрана.
    // alpha (поворот вокруг вертикали) у телефона отсчитывается от произвольного направления
    // и медленно «уплывает» — поэтому её используем только в паре с камерой, которая это поправляет.
    worldFromCamera(out, lagMs = 0) {
      let a = alpha, b = beta, g = gamma;
      if (lagMs > 0) {                       // самое свежее показание, которое не новее (сейчас − lagMs)
        const target = performance.now() - lagMs;
        for (let k = 0; k < HIST; k++) {
          const h = hist[(hi - k + HIST) % HIST];
          if (h.t <= target) { if (h.t > 0) { a = h.a; b = h.b; g = h.g; } break; }
        }
      }
      euler.set(b * DEG, g * DEG, a * DEG, 'ZXY');
      out.setFromEuler(euler);
      return out.multiply(qScreen.setFromAxisAngle(zAxis, -screenAngle()));
    },

    // Вектор «вверх» в координатах камеры (единичный), записывается в out (THREE.Vector3)
    upCamera(out) {
      const b = beta * DEG, g = gamma * DEG;
      const x = -Math.cos(b) * Math.sin(g), y = Math.sin(b), z = Math.cos(b) * Math.cos(g);
      const a = screenAngle();
      return out.set(x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), z).normalize();
    },
  };
  return api;
}
