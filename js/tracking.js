// Трекинг метки (MindAR) + наше сглаживание, отсев ошибочных поз и синхронизация видео.
// Наружу отдаёт группу `content`: всё, что в неё положено, «стоит» на метке.
// Единицы внутри content: ширина метки = 1, центр метки = (0,0,0), ось Z смотрит от метки вверх.
import * as THREE from 'three';
import { MindARThree } from 'mindar-image-three';

export function createTracker(opts) {
  const { container, markerUrl, CF, BETA, MISS, WARM, SYNC, RAW, JUMP, NOGUARD, onFound, onLost, onStall, onFatal,
          imu, USE_IMU = true, TOL = 20, IMULAG = 0, KMW = 0.03, COAST = 1000,
          PMC = 2, PB = 5, DMC = 0.6, DB = 2, RMC, RB, DC = 1, FOV = 66 } = opts;

  const mindar = new MindARThree({
    container, imageTargetSrc: markerUrl, uiScanning: 'no', uiError: 'no',
    filterMinCF: CF, filterBeta: BETA, missTolerance: MISS, warmupTolerance: WARM,
  });
  const { renderer, scene, camera } = mindar;
  // MindAR рисует с плотностью пикселей экрана (у айфона ×3) и сглаживанием — это много видеопамяти.
  // При повороте экрана буферы пересоздаются, и iOS может отобрать у страницы графический контекст
  // распознавания. Ограничиваем ×2: на глаз почти не отличить, памяти в 2,25 раза меньше.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
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
  // Камера хорошо видит, ГДЕ метка, но её поворот (особенно наклон) определяет с дрожью:
  // плоская картинка почти одинаково выглядит при чуть разных наклонах, а Земля висит над меткой,
  // и любая дрожь поворота раскачивает её, как маятник. Поворот берём из гироскопа (см. ниже),
  // положение — из камеры. Без гироскопа работает только камера с отсевом явно ошибочных поз.
  const cPos = new THREE.Vector3(), cQ = new THREE.Quaternion(), cS = new THREE.Vector3();
  const aPos = new THREE.Vector3(), aQ = new THREE.Quaternion();
  const nrm = new THREE.Vector3(), toCam = new THREE.Vector3();
  let aS = 1, accepted = false, suspect = 0, agree = 1, fusedNow = false, badSince = null;
  // ---- Ориентация метки в «мире» (комнате) ----
  // Метка неподвижна (стол, монитор, стена), значит, её ориентация в комнате постоянна.
  // Гироскоп точно и без задержки знает, как повёрнут телефон; камера знает, как метка повёрнута
  // относительно телефона, но с шумом (особенно наклон и разворот). Поэтому:
  //   qMW — ориентация метки в мире, усредняем её по камере и гироскопу (медленно);
  //   поворот сцены в кадре = (поворот телефона по гироскопу)⁻¹ · qMW — без шума камеры.
  // Камера при этом медленно подправляет qMW (у гироскопа поворот вокруг вертикали «уплывает»).
  // Показания гироскопа берём в момент, когда распознаванию отдали кадр, — так нет отставания при движении.
  const WORLD_UP = new THREE.Vector3(0, 0, 1), Z = new THREE.Vector3(0, 0, 1);
  const qMW = new THREE.Quaternion(), qInst = new THREE.Quaternion(), qRecent = new THREE.Quaternion();
  const qWC = new THREE.Quaternion(), qWCframe = new THREE.Quaternion(), qTmp = new THREE.Quaternion();
  const nW = new THREE.Vector3();
  let haveMW = false, haveFrameQ = false, recentN = 0, markerTilt = 0, snapped = true;
  let bigSince = null, hardSince = null, softSince = null, lastRedetect = 0, devAvg = null;
  const redetects = [];
  const K = KMW;                          // скорость подстройки qMW по камере (0,03 ≈ 1 с при 30 кадрах/с)
  const SNAP = 6, SOFT = 5, HARD = 15, BIG = 40;
  const qAngle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * 180 / Math.PI;
  // Метка почти горизонтальна → считаем строго горизонтальной (стол). Убирает остаточный наклон.
  function snapHorizontal() {
    nW.copy(Z).applyQuaternion(qMW);
    markerTilt = nW.angleTo(WORLD_UP) * 180 / Math.PI;
    snapped = markerTilt < SNAP;
    if (snapped) qMW.premultiply(qTmp.setFromUnitVectors(nW, WORLD_UP));
  }
  function reanchor(why) {
    qMW.copy(recentN ? qRecent : qInst);
    snapHorizontal();
    redetects.length = 0; bigSince = hardSince = softSince = devAvg = null;
    console.log('[трекинг] ориентация метки:', snapped ? 'горизонтально' : 'наклон ' + markerTilt.toFixed(0) + '°', '—', why);
  }
  function redetect(now, dev, kind) {
    const ts0 = mindar.controller && mindar.controller.trackingStates[0];
    if (ts0) ts0.isTracking = false;                // MindAR на следующем кадре распознает метку с нуля
    lastRedetect = now; stats.redetect++; devAvg = null; recentN = 0;
    while (redetects.length && now - redetects[0].t > 12000) redetects.shift();
    redetects.push({ t: now, dev });
    console.log(`[трекинг] ${kind} перезахват: камера расходится с гироскопом на ${dev.toFixed(1)}°`);
  }
  // после перезахвата: если камера снова показывает то же самое — значит, метку правда переложили
  function afterRedetectCheck(dev) {
    const n = redetects.length;
    if (n >= 2 && Math.abs(redetects[n - 1].dev - dev) < 3 && recentN > 20) reanchor('перезахваты показывают одно и то же — метку переложили');
  }
  // фиксируем показания гироскопа в момент, когда распознаванию отдают кадр
  function hookFrameImu() {
    const ctrl = mindar.controller, loader = ctrl && ctrl.inputLoader;
    if (!loader || loader.__imuHooked) return;
    const orig = loader.loadInput.bind(loader);
    loader.loadInput = (input) => {
      if (imu && imu.fresh() && imu.hasAlpha) { imu.worldFromCamera(qWCframe, IMULAG); haveFrameQ = true; } else haveFrameQ = false;
      frameUpdated = false;
      return orig(input);
    };
    loader.__imuHooked = true;
  }
  const stats = { rejected: 0, updates: 0, fused: 0, imuAngSum: 0, imuN: 0, redetect: 0, coast: 0 };

  // ---- Положение метки «в комнате» и удержание сцены по гироскопу ----
  // Когда поворот берётся из гироскопа, положение метки тоже храним в координатах комнаты
  // (с началом в телефоне): при повороте телефона оно не меняется, поэтому сглаживание
  // не отстаёт. А если на резком движении камера на мгновение потеряла метку (смаз),
  // сцену держит на месте гироскоп — до COAST_MS, пока метка по расчёту остаётся в кадре.
  const COAST_MS = COAST;
  const wPos = new THREE.Vector3(), qWCuse = new THREE.Quaternion(), qCW = new THREE.Quaternion();
  const outPos = new THREE.Vector3(), outQ = new THREE.Quaternion(), proj = new THREE.Vector3();
  let worldMode = false, lastGood = -1e9, frameUpdated = false, posSuspect = 0;

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
    if (USE_IMU && imu && haveFrameQ) {
      qWC.copy(qWCframe);
      qInst.copy(qWC).multiply(cQ);                                       // ориентация метки в мире по этому кадру
      if (!recentN) qRecent.copy(qInst); else qRecent.slerp(qInst, 0.1);
      recentN++;
      if (!haveMW) { qMW.copy(qInst); snapHorizontal(); haveMW = true;
        console.log('[трекинг] ориентация метки:', snapped ? 'горизонтально' : 'наклон ' + markerTilt.toFixed(0) + '°'); }
      const dev = qAngle(qInst, qMW);                                     // насколько камера не согласна с гироскопом
      stats.imuAngSum += dev; stats.imuN++;
      const now = performance.now();
      devAvg = devAvg === null ? dev : devAvg + 0.08 * (dev - devAvg);

      // согласны — подправляем ориентацию метки по камере (медленно)
      if (dev < HARD) { qMW.slerp(qInst, K); snapHorizontal(); }
      // > 40° больше секунды — метку явно переложили: берём новую ориентацию
      if (dev > BIG) {
        if (bigSince === null) bigSince = now;
        else if (now - bigSince > 1000) reanchor('метка расположена иначе, чем раньше');
      } else bigSince = null;
      // 15–40° держится 0,7 с — трекер, скорее всего, ошибся: заставляем найти метку заново
      if (dev > HARD && dev <= BIG) {
        if (hardSince === null) hardSince = now;
        else if (now - hardSince > 700 && now - lastRedetect > 700) { hardSince = null; redetect(now, dev, 'резкий'); }
      } else hardSince = null;
      // 5–15° держится 1,5 с — трекер «застрял» на небольшой ошибке: мягкий перезахват
      if (devAvg !== null && devAvg > SOFT && devAvg <= HARD && now - lastRedetect > 3000) {
        if (softSince === null) softSince = now;
        else if (now - softSince > 1500) { softSince = null; redetect(now, devAvg, 'мягкий'); }
      } else softSince = null;
      if (now - lastRedetect > 600 && now - lastRedetect < 2000 && redetects.length) afterRedetectCheck(dev);

      // поворот сцены — из гироскопа и усреднённой ориентации метки; положение остаётся от камеры
      if (dev <= BIG) {
        cQ.copy(qWC).invert().multiply(qMW);
        fused = true; stats.fused++;
      }
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
    const now = performance.now();
    if (fused) {
      // положение метки в комнате; резкий скачок относительно сглаженного — скорее всего, смаз:
      // несколько кадров не верим камере (сцену держит гироскоп), потом принимаем
      wPos.copy(cPos).applyQuaternion(qWC);
      if (worldMode && ready && now - lastGood < 300) {
        const d = wPos.distanceTo(sPos) / sDist;
        if (d > 0.25 && posSuspect < 4) { posSuspect++; stats.rejected++; return; }
      }
      posSuspect = 0;
      if (!worldMode || now - lastGood > 300) { worldMode = true; ready = false; }
      qWCuse.copy(qWC);
      aPos.copy(wPos); aQ.copy(qMW);
    } else {
      if (worldMode) { worldMode = false; ready = false; }
      aPos.copy(cPos); aQ.copy(cQ);
    }
    suspect = 0;
    fusedNow = fused;
    aS = s; accepted = true; lastGood = now; frameUpdated = true;
    if (SYNC) smoothPose(now);
  };

  // ---- 2. Сглаживание (One Euro) по отдельности для трёх величин ----
  //  направление на метку — камера определяет его очень точно, сглаживаем слабо;
  //  расстояние до метки — определяется хуже (отсюда «дыхание» размера), сглаживаем сильнее;
  //  поворот — слабо, если наклон из датчиков, и сильнее, если только по камере.
  // В каждом случае сглаживание ослабевает, пока телефон движется, — так нет запаздывания.
  const sDir = new THREE.Vector3(), tDir = new THREE.Vector3(), sQ = new THREE.Quaternion(), qInv = new THREE.Quaternion();
  const sPos = new THREE.Vector3(), sScale = new THREE.Vector3();
  let sDist = 1, sS = 1, ready = false, vdF = 0, vzF = 0, wF = 0, last = 0;
  const alpha = (fc, dt) => 1 / (1 + 1 / (2 * Math.PI * fc * dt));
  const angle = (u, v) => Math.acos(Math.max(-1, Math.min(1, u.dot(v))));
  function smoothPose(now) {
    if (frozen) return;
    if (!(anchor.group.visible && accepted)) { if (!canCoast(now)) ready = false; last = now; return; }
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
    composeContent();
  }
  // в «мировом» режиме переводим сглаженную позу из комнаты в камеру по ориентации телефона qWCuse
  function composeContent() {
    if (worldMode) {
      qCW.copy(qWCuse).invert();
      outPos.copy(sPos).applyQuaternion(qCW);
      outQ.copy(qCW).multiply(sQ);
      content.matrix.compose(outPos, outQ, sScale.set(sS, sS, sS));
    } else content.matrix.compose(sPos, sQ, sScale.set(sS, sS, sS));
  }
  // можно ли сейчас держать сцену по одному гироскопу (метка недавно была и по расчёту в кадре)
  function canCoast(now) {
    if (!(worldMode && ready && imu && imu.fresh()) || now - lastGood > COAST_MS) return false;
    proj.copy(sPos).applyQuaternion(qCW.copy(qWCuse).invert()).project(camera);
    return proj.z < 1 && Math.abs(proj.x) < 1.1 && Math.abs(proj.y) < 1.1;
  }

  // ---- 3. Синхронизация видео с трекером ----
  let syncBg = null, syncTimer = null, syncCtx = null;
  function teardownSync() {
    clearInterval(syncTimer); syncTimer = null;
    if (syncBg) { syncBg.remove(); syncBg = null; }
  }
  function setupSync() {
    teardownSync();
    const v = mindar.video;
    const src = mindar.controller.inputLoader.context.canvas;
    const bg = syncBg = document.createElement('canvas');
    bg.width = src.width; bg.height = src.height;
    bg.style.position = 'absolute'; bg.style.zIndex = '-1';
    const bgCtx = syncCtx = bg.getContext('2d');
    v.parentNode.insertBefore(bg, v.nextSibling);
    v.style.opacity = '0';
    const syncStyle = () => {
      for (const k of ['top', 'left', 'width', 'height']) if (bg.style[k] !== v.style[k]) bg.style[k] = v.style[k];
    };
    syncStyle(); syncTimer = setInterval(syncStyle, 500);
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
  let lastProcessed = performance.now(), realProcessed = performance.now(), loopRuns = 0, restarting = false, stallReported = false;
  function countProcessed() {
    hookFrameImu();
    const ctrl = mindar.controller, orig = ctrl.onUpdate;
    ctrl.onUpdate = (data) => {
      if (data.type === 'processDone') {
        lastProcessed = realProcessed = performance.now(); loopRuns++;
        // кадр обработан, а позы нет (смаз, перезахват) — поворачиваем сцену по гироскопу этого кадра
        if (SYNC && !frozen && !frameUpdated && haveFrameQ && canCoast(realProcessed)) {
          qWCuse.copy(qWCframe); composeContent(); stats.coast++;
        }
      }
      orig(data);
    };
  }
  function restartProcessing() {
    if (restarting) return;
    restarting = true;
    const ctrl = mindar.controller;
    ctrl.stopProcessVideo();
    // ждём, пока прежний цикл завершит текущий кадр и выйдет (обновления прекратятся)
    const waitStart = performance.now();
    const check = () => {
      if (frozen || paused) { restarting = false; return; }
      if (performance.now() - lastProcessed > 250 || performance.now() - waitStart > 2000) {
        ctrl.processVideo(mindar.video);
        restarting = false;
        lastProcessed = performance.now();
      } else setTimeout(check, 60);
    };
    setTimeout(check, 60);
  }
  // ---- 6. Поворот телефона ----
  // iOS при повороте меняет ориентацию видео с камеры (480×640 ↔ 640×480), а MindAR настраивает
  // распознавание на размер кадра один раз при запуске — дальше кадры читаются с перекосом.
  // Если размер кадра изменился и держится, перезапускаем камеру и распознавание под новый размер.
  let arRestarting = false, dimsSince = null, paused = false, resumeTimer = null;
  // диагностика состояния камеры и графики — пишется в консоль
  function diag(when) {
    const v = mindar.video, tr = v && v.srcObject && v.srcObject.getVideoTracks()[0];
    console.log(`[диагностика: ${when}] видео ${v ? v.videoWidth + '×' + v.videoHeight : '—'}, ` +
      `пауза ${v ? v.paused : '—'}, готовность ${v ? v.readyState : '—'}, ` +
      `камера ${tr ? tr.readyState + (tr.muted ? ', muted' : '') + (tr.enabled ? '' : ', disabled') : '—'}, ` +
      `распознавание ${mindar.controller ? mindar.controller.inputWidth + '×' + mindar.controller.inputHeight : '—'}, ` +
      `потерь WebGL: ${window.__glLost || 0}`);
  }
  // потеря графического контекста — распознавание после неё само не оживёт
  window.addEventListener('gl-lost', () => {
    if (!mindar.controller) return;
    diag('потерян WebGL');
    onFatal && onFatal('потерян графический контекст');
  });
  function checkVideoSize() {
    const v = mindar.video, c = mindar.controller;
    if (arRestarting || frozen || paused || !v || !c || !v.videoWidth) { dimsSince = null; return; }
    if (v.videoWidth !== c.inputWidth || v.videoHeight !== c.inputHeight) {
      if (dimsSince === null) dimsSince = performance.now();
      else if (performance.now() - dimsSince > 600) {
        dimsSince = null;
        restartAR(`кадр ${c.inputWidth}×${c.inputHeight} → ${v.videoWidth}×${v.videoHeight}`);
      }
    } else dimsSince = null;
  }
  async function restartAR(reason) {
    if (arRestarting) return;
    arRestarting = true;
    console.log('[камера] перезапуск:', reason);
    accepted = false; ready = false; badSince = bigSince = null;
    const old = mindar.controller;
    try { mindar.stop(); } catch (e) { console.warn('stop:', e); }
    try { old && old.worker && old.worker.terminate(); } catch (e) {}
    teardownSync();
    try {
      await mindar._startVideo();
      await mindar._startAR();
      if (SYNC) setupSync();
      countProcessed();
      lastProcessed = performance.now();
      console.log('[камера] готово, кадр', mindar.video.videoWidth + '×' + mindar.video.videoHeight);
      if (paused) mindar.controller.stopProcessVideo();     // пока перезапускались, телефон снова повернули
    } catch (e) {
      console.error('[камера] перезапуск не удался:', e);
      onStall && onStall();
    }
    arRestarting = false;
  }

  function startWatchdog() {
    countProcessed();
    let lastVideoTime = -1, videoStuckSince = null, stalls = 0;
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !frozen && !paused && !arRestarting) { mindar.video.play().catch(() => {}); lastProcessed = performance.now(); }
    });
    setInterval(checkVideoSize, 300);
    setInterval(() => {
      if (frozen || paused || document.hidden || arRestarting) { videoStuckSince = null; lastProcessed = performance.now(); return; }
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
      } else if (now - realProcessed < 500) stalls = 0;      // сбрасываем, только если кадры правда идут
    }, 1000);
  }

  return {
    mindar, renderer, scene, camera, content, stats, intrinsics,
    get agree() { return agree; },
    get debug() { return { worldMode, ready, sinceGood: Math.round(performance.now() - lastGood), frameUpdated, haveFrameQ, imuFresh: !!(imu && imu.fresh()), coast: canCoast(performance.now()), proj: proj.toArray().map((v) => +v.toFixed(2)) }; },
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
      const live = !SYNC || now - realProcessed > 150;          // на экране живое видео, а не обработанный кадр
      if (live && worldMode && !frozen && imu && imu.fresh()) imu.worldFromCamera(qWCuse, 0);
      if (!SYNC) smoothPose(now);
      else if (live && !frozen && canCoast(now)) composeContent();
      // Если распознавание не выдаёт кадров (пауза, запуск после поворота, перезапуск),
      // показываем живое видео, чтобы картинка с камеры не замирала. При заморозке — не трогаем.
      if (SYNC && syncBg && syncCtx && !frozen && now - realProcessed > 150) {
        const v = mindar.video;
        if (v && v.readyState >= 2 && v.videoWidth) {
          if (syncBg.width !== v.videoWidth || syncBg.height !== v.videoHeight) { syncBg.width = v.videoWidth; syncBg.height = v.videoHeight; }
          syncCtx.drawImage(v, 0, 0, syncBg.width, syncBg.height);
        }
      }
      const want = frozen ? frozenWant : ((anchor.group.visible && accepted) || canCoast(now));
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
    get restarting() { return arRestarting; },
    // Пауза распознавания (телефон повёрнут горизонтально). Камера продолжает работать,
    // поэтому после возврата в вертикальное положение всё продолжается сразу, без перезапуска.
    setPaused(on) {
      if (on === paused) return;
      // заморозку при повороте снимаем: после поворота меняется кадр камеры, и «замороженный»
      // снимок всё равно не совпал бы с экраном (раньше камера после этого не оживала)
      if (on && frozen) { paused = true; this.setFrozen(false); console.log('[экран] поворот — заморозка снята'); }
      paused = on;
      clearTimeout(resumeTimer);
      if (on) {
        if (!arRestarting && mindar.controller) mindar.controller.stopProcessVideo();
        accepted = false; ready = false;
        return;
      }
      // Возврат в вертикальное положение. Ждём, пока iOS закончит поворот, поправляем раскладку
      // и продолжаем. Дальше проверяем, ожило ли распознавание: если нет — перезапускаем камеру,
      // а если и это не помогло — сообщаем наружу (страницу придётся перезагрузить).
      lastProcessed = performance.now();
      resumeTimer = setTimeout(async () => {
        if (paused || frozen) return;
        try { mindar.resize(); } catch (e) {}
        diag('после поворота');
        const t0 = performance.now();
        if (!arRestarting) {
          const v = mindar.video, c = mindar.controller;
          if (v && c && v.videoWidth === c.inputWidth && v.videoHeight === c.inputHeight) restartProcessing();
        }
        resumeTimer = setTimeout(async () => {
          if (paused || frozen || realProcessed > t0) return;          // кадры пошли — всё хорошо
          console.warn('[камера] после поворота распознавание не ожило — перезапуск камеры');
          await restartAR('после поворота');
          const t1 = performance.now();
          resumeTimer = setTimeout(() => {
            if (paused || frozen || realProcessed > t1) return;
            diag('не помог перезапуск');
            onFatal && onFatal('после поворота распознавание не восстановилось');
          }, 3500);
        }, 2500);
      }, 250);
    },
    get markerState() {
      if (!haveMW) return '—';
      if (bigSince !== null) return 'перенастройка';
      return snapped ? 'горизонтально' : 'наклон ' + markerTilt.toFixed(0) + '°';
    },
    // направление «вверх» (против силы тяжести) в координатах сцены метки; false — датчиков нет
    gravityInContent(out) {
      if (!(USE_IMU && imu && imu.fresh())) return false;
      // ориентация метки в комнате уже усреднена — «вверх» в сцене постоянен и не дрожит
      if (haveMW && fusedNow) return out.copy(WORLD_UP).applyQuaternion(qInv.copy(qMW).invert()).normalize();
      imu.upCamera(out);
      return out.applyQuaternion(qInv.copy(sQ).invert()).normalize();
    },
    get frozen() { return frozen; },
    // «Заморозить»: останавливаем и картинку с камеры, и позу — можно опустить телефон и спокойно тапать
    setFrozen(on) {
      if (on === frozen || arRestarting) return;
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
