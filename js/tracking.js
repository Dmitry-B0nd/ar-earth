// Трекинг метки (MindAR) + наше сглаживание, отсев ошибочных поз и синхронизация видео.
// Наружу отдаёт группу `content`: всё, что в неё положено, «стоит» на метке.
// Единицы внутри content: ширина метки = 1, центр метки = (0,0,0), ось Z смотрит от метки вверх.
import * as THREE from 'three';
import { MindARThree } from 'mindar-image-three';

export function createTracker(opts) {
  const { container, markerUrl, CF, BETA, MISS, WARM, SYNC, RAW, JUMP, NOGUARD, onFound, onLost, onStall,
          imu, USE_IMU = true, TOL = 20,
          PMC = 2, PB = 5, DMC = 0.6, DB = 2, RMC, RB, DC = 1, FOV = 66 } = opts;

  const mindar = new MindARThree({
    container, imageTargetSrc: markerUrl, uiScanning: 'no', uiError: 'no',
    filterMinCF: CF, filterBeta: BETA, missTolerance: MISS, warmupTolerance: WARM,
  });
  const { renderer, scene, camera } = mindar;
  const anchor = mindar.addAnchor(0);

  // ---- 0. Настоящий угол обзора камеры ----
  // MindAR считает, что угол обзора у любой камеры 45° по длинной стороне кадра. У камеры
  // айфона он ~65–72°. С неверным углом трекер систематически ошибается в НАКЛОНЕ метки
  // (на 20–30°), путает похожие наклоны и «перескакивает» между ними, а рамка не ложится по краю.
  // Подменяем параметры камеры в момент, когда MindAR создаёт свой контроллер, — до того,
  // как он передаст их в трекер и в фоновый поток распознавания.
  let ctrl = null;
  const intrinsics = { fov: FOV, f: null, fOrig: null };
  Object.defineProperty(mindar, 'controller', {
    configurable: true, enumerable: true,
    get: () => ctrl,
    set: (c) => {
      ctrl = c;
      if (!FOV || !c || !c.projectionTransform) return;
      const W = c.inputWidth, H = c.inputHeight, long = Math.max(W, H);
      const P = c.projectionTransform;
      intrinsics.fOrig = P[0][0];
      const f = (long / 2) / Math.tan(FOV * Math.PI / 360);
      P[0][0] = f; P[1][1] = f;                                  // меняем на месте: трекер держит ссылку на этот массив
      c.projectionMatrix = c._glProjectionMatrix({ projectionTransform: P, width: W, height: H, near: 10, far: 100000 });
      intrinsics.f = f;
      console.log('[камера] угол обзора', FOV + '°: фокус', f.toFixed(0), 'px вместо', intrinsics.fOrig.toFixed(0), 'px, кадр', W + '×' + H);
    },
  });

  const content = new THREE.Group();
  content.matrixAutoUpdate = false;
  content.visible = false;
  scene.add(content);

  anchor.onTargetFound = () => onFound && onFound();
  anchor.onTargetLost = () => onLost && onLost();

  // ---- 1. Поза метки: камера + датчики телефона, отсев ошибочных поз ----
  // Камера хорошо видит, ГДЕ метка и как она повёрнута вокруг своей оси, но плохо — её НАКЛОН
  // (плоская картинка почти одинаково выглядит при чуть разных наклонах). Наклон дрожит,
  // а Земля висит над меткой, и дрожь наклона раскачивает её, как маятник.
  // Если метка лежит на столе, её «верх» совпадает с направлением против силы тяжести —
  // а его гироскоп телефона знает точно, плавно и без задержки. Поэтому:
  //   наклон метки — из датчиков телефона, поворот вокруг оси и положение — из камеры.
  // Если камера и датчики сильно расходятся (метку держат в руке, повесили на стену),
  // объединение само отключается и работает только камера.
  const cPos = new THREE.Vector3(), cQ = new THREE.Quaternion(), cS = new THREE.Vector3();
  const aPos = new THREE.Vector3(), aQ = new THREE.Quaternion();
  const nrm = new THREE.Vector3(), toCam = new THREE.Vector3(), up = new THREE.Vector3();
  const xAx = new THREE.Vector3(), yAx = new THREE.Vector3(), basis = new THREE.Matrix4();
  let aS = 1, accepted = false, suspect = 0, agree = 1, fusedNow = false, badSince = null;
  const stats = { rejected: 0, updates: 0, fused: 0, imuAngSum: 0, imuN: 0, redetect: 0 };

  let frozen = false, frozenWant = false;
  anchor.onTargetUpdate = () => {
    if (frozen) return;                                     // «заморожено»: позу не трогаем
    if (!anchor.group.visible) { accepted = false; suspect = 0; return; }
    const ts = mindar.controller && mindar.controller.trackingStates[0];
    if (ts && !ts.isTracking) return;                       // трекер потерял метку и повторяет старую позу
    stats.updates++;
    anchor.group.matrix.decompose(cPos, cQ, cS);
    const s = Math.cbrt(Math.abs(cS.x * cS.y * cS.z));
    nrm.set(0, 0, 1).applyQuaternion(cQ);

    let fused = false;
    if (USE_IMU && imu && imu.fresh()) {
      imu.upCamera(up);
      const ang = Math.acos(Math.max(-1, Math.min(1, nrm.dot(up)))) * 180 / Math.PI;
      stats.imuAngSum += ang; stats.imuN++;
      // Наклон берём из датчиков ВСЕГДА (метка лежит на столе). Положение метки камера
      // определяет надёжно даже тогда, когда ошиблась с наклоном, так что позу не выбрасываем.
      // Но если камера долго «уверена» в неправильном наклоне, значит, трекер зацепился за
      // ложное решение и сам с него не слезет — заставляем его найти метку заново.
      agree += 0.1 * ((ang < TOL ? 1 : 0) - agree);
      if (ang > TOL) {
        if (badSince === null) badSince = performance.now();
        else if (performance.now() - badSince > 700) {
          const ts0 = mindar.controller && mindar.controller.trackingStates[0];
          if (ts0) ts0.isTracking = false;            // MindAR на следующем кадре распознает метку с нуля
          badSince = null; stats.redetect++;
          console.log('[трекинг] наклон по камере расходится с гироскопом на', ang.toFixed(0) + '° — перезахват метки');
        }
      } else badSince = null;
      xAx.set(1, 0, 0).applyQuaternion(cQ);
      xAx.addScaledVector(up, -xAx.dot(up));
      if (xAx.lengthSq() < 1e-6) xAx.set(0, 1, 0).applyQuaternion(cQ).addScaledVector(up, -xAx.dot(up));
      xAx.normalize();                                      // ось X метки, положенная «горизонтально»
      yAx.crossVectors(up, xAx);
      cQ.setFromRotationMatrix(basis.makeBasis(xAx, yAx, up));
      fused = true; stats.fused++;
    }
    if (!fused && !NOGUARD) {
      toCam.copy(cPos).negate().normalize();
      if (nrm.dot(toCam) < 0.15) { stats.rejected++; return; }   // метка «смотрит» от камеры
      if (accepted) {
        const ang = 2 * Math.acos(Math.min(1, Math.abs(aQ.dot(cQ)))) * 180 / Math.PI;
        const jump = cPos.distanceTo(aPos) / aS;
        if ((ang > JUMP || jump > 0.5) && suspect < 3) { suspect++; stats.rejected++; return; }
      }
    }
    suspect = 0;
    fusedNow = fused;
    aPos.copy(cPos); aQ.copy(cQ); aS = s; accepted = true;
    if (SYNC) smoothPose(performance.now());
  };

  // ---- 2. Сглаживание (One Euro) по отдельности для трёх величин ----
  //  направление на метку — камера определяет его очень точно, сглаживаем слабо;
  //  расстояние до метки — определяется хуже (отсюда «дыхание» размера), сглаживаем сильнее;
  //  поворот — слабо, если наклон из датчиков, и сильнее, если только по камере.
  // В каждом случае сглаживание ослабевает, пока телефон движется, — так нет запаздывания.
  const sDir = new THREE.Vector3(), tDir = new THREE.Vector3(), sQ = new THREE.Quaternion();
  const sPos = new THREE.Vector3(), sScale = new THREE.Vector3();
  let sDist = 1, sS = 1, ready = false, vdF = 0, vzF = 0, wF = 0, last = 0;
  const alpha = (fc, dt) => 1 / (1 + 1 / (2 * Math.PI * fc * dt));
  const angle = (u, v) => Math.acos(Math.max(-1, Math.min(1, u.dot(v))));
  function smoothPose(now) {
    if (frozen) return;
    if (!(anchor.group.visible && accepted)) { ready = false; last = now; return; }
    const dist = aPos.length();
    tDir.copy(aPos).divideScalar(dist);
    if (!ready || RAW) {
      sDir.copy(tDir); sDist = dist; sQ.copy(aQ); sS = aS; vdF = vzF = wF = 0; ready = true;
    } else {
      const dt = Math.min(Math.max((now - last) / 1000, 0.001), 0.1);
      const rmc = RMC ?? (fusedNow ? 1.5 : 1), rb = RB ?? (fusedNow ? 3 : 1);
      vdF += alpha(DC, dt) * (angle(tDir, sDir) / dt - vdF);                    // рад/с
      vzF += alpha(DC, dt) * (Math.abs(dist - sDist) / sDist / dt - vzF);       // доля расстояния в секунду
      wF  += alpha(DC, dt) * (2 * Math.acos(Math.min(1, Math.abs(sQ.dot(aQ)))) / dt - wF);
      sDir.lerp(tDir, alpha(PMC + PB * vdF, dt)).normalize();
      const az = alpha(DMC + DB * vzF, dt);
      sDist += az * (dist - sDist);
      sS += az * (aS - sS);
      sQ.slerp(aQ, alpha(rmc + rb * wF, dt));
    }
    last = now;
    sPos.copy(sDir).multiplyScalar(sDist);
    content.matrix.compose(sPos, sQ, sScale.set(sS, sS, sS));
  }

  // ---- 3. Синхронизация видео с трекером ----
  function setupSync() {
    const v = mindar.video;
    const src = mindar.controller.inputLoader.context.canvas;
    const bg = document.createElement('canvas');
    bg.width = src.width; bg.height = src.height;
    bg.style.position = 'absolute'; bg.style.zIndex = '-1';
    const bgCtx = bg.getContext('2d');
    v.parentNode.insertBefore(bg, v.nextSibling);
    v.style.opacity = '0';
    const syncStyle = () => {
      for (const k of ['top', 'left', 'width', 'height']) if (bg.style[k] !== v.style[k]) bg.style[k] = v.style[k];
    };
    syncStyle(); setInterval(syncStyle, 500);
    const ctrl = mindar.controller;
    const origUpdate = ctrl.onUpdate;
    ctrl.onUpdate = (data) => {
      if (data.type === 'processDone' && src.width === bg.width && !frozen) bgCtx.drawImage(src, 0, 0);
      origUpdate(data);
    };
  }

  // ---- 4. Плавное появление и исчезновение сцены (прозрачностью холста) ----
  const HOLD_MS = 250, FADE_MS = 300;
  let lostAt = null, fading = false;
  const canvas = renderer.domElement;
  canvas.style.transition = `opacity ${FADE_MS}ms ease`;
  function fadeTo(v) {
    canvas.style.opacity = String(v);
    fading = v === 0;
  }

  // ---- 5. Сторож: камера или распознавание могут «зависнуть» (iOS при сворачивании Safari
  // приостанавливает видео; при быстрой разморозке мог запуститься второй цикл обработки).
  // Если кадры перестали обрабатываться — перезапускаем; не помогло — просим перезагрузку.
  let lastProcessed = performance.now(), loopRuns = 0, restarting = false, stallReported = false;
  function countProcessed() {
    const ctrl = mindar.controller, orig = ctrl.onUpdate;
    ctrl.onUpdate = (data) => { if (data.type === 'processDone') { lastProcessed = performance.now(); loopRuns++; } orig(data); };
  }
  function restartProcessing() {
    if (restarting) return;
    restarting = true;
    const ctrl = mindar.controller;
    ctrl.stopProcessVideo();
    // ждём, пока прежний цикл завершит текущий кадр и выйдет (обновления прекратятся)
    const waitStart = performance.now();
    const check = () => {
      if (frozen) { restarting = false; return; }
      if (performance.now() - lastProcessed > 250 || performance.now() - waitStart > 2000) {
        ctrl.processVideo(mindar.video);
        restarting = false;
        lastProcessed = performance.now();
      } else setTimeout(check, 60);
    };
    setTimeout(check, 60);
  }
  function startWatchdog() {
    countProcessed();
    let lastVideoTime = -1, videoStuckSince = null, stalls = 0;
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !frozen) { mindar.video.play().catch(() => {}); lastProcessed = performance.now(); }
    });
    setInterval(() => {
      if (frozen || document.hidden) { videoStuckSince = null; return; }
      const v = mindar.video, now = performance.now();
      // видео стоит на месте?
      if (v.currentTime === lastVideoTime) {
        if (videoStuckSince === null) videoStuckSince = now;
        else if (now - videoStuckSince > 1500) { console.warn('[сторож] видео остановилось — запускаю снова'); v.play().catch(() => {}); }
      } else videoStuckSince = null;
      lastVideoTime = v.currentTime;
      // кадры не обрабатываются?
      if (!restarting && now - lastProcessed > 2500) {
        stalls++;
        console.warn('[сторож] распознавание не отвечает', Math.round(now - lastProcessed), 'мс — перезапуск №' + stalls);
        restartProcessing();
        if (stalls >= 3 && !stallReported) { stallReported = true; onStall && onStall(); }
      } else if (now - lastProcessed < 500) stalls = 0;
    }, 1000);
  }

  return {
    mindar, renderer, scene, camera, content, stats, intrinsics,
    get agree() { return agree; },
    async start() {
      mindar.ui.showLoading();
      let t = performance.now();
      await mindar._startVideo();
      const v = mindar.video;
      console.log('[2] Камера включена за', Math.round(performance.now() - t), 'мс, разрешение', v.videoWidth + '×' + v.videoHeight);
      t = performance.now();
      await mindar._startAR();
      console.log('[3] Трекер готов за', Math.round(performance.now() - t), 'мс');
      if (SYNC) setupSync();
      if (imu) imu.start();
      startWatchdog();
      return v;
    },
    // вызывать каждый кадр перед отрисовкой
    frame(now) {
      if (!SYNC) smoothPose(now);
      const want = frozen ? frozenWant : (anchor.group.visible && accepted);
      // Плавность: при потере метки сцена ещё ~0,25 с стоит на месте (короткие пропуски
      // незаметны), потом за 0,3 с растворяется; при нахождении — быстро проявляется.
      if (want) {
        lostAt = null;
        if (!content.visible || fading) { content.visible = true; fadeTo(1); }   // в т.ч. если нашлась посреди растворения
      } else if (content.visible) {
        if (lostAt === null) lostAt = now;
        if (now - lostAt > HOLD_MS && !fading) fadeTo(0);
        if (now - lostAt > HOLD_MS + FADE_MS) content.visible = false;
      }
    },
    get shown() { return content.visible && !fading; },
    get frozen() { return frozen; },
    // «Заморозить»: останавливаем и картинку с камеры, и позу — можно опустить телефон и спокойно тапать
    setFrozen(on) {
      if (on === frozen) return;
      frozen = on;
      frozenWant = on && content.visible;
      const ctrl = mindar.controller;
      if (on) {
        if (!SYNC) mindar.video.pause();
        ctrl.stopProcessVideo();
      } else {
        if (!SYNC) mindar.video.play();
        restartProcessing();
        accepted = false; ready = false;          // после разморозки ищем метку заново
      }
    },
  };
}
