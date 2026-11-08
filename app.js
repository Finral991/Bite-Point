// ============================================================================
// 1. НАЛАШТУВАННЯ ОНЛАЙНУ (FIREBASE)
// Встав сюди свій firebaseConfig, який ти вже підключив
// ============================================================================
const firebaseConfig = {
  apiKey: "AIzaSyBWCeFOaiUBDi1NOcHee2lx0ypXH5fJKNA",
  authDomain: "bite-point-f1.firebaseapp.com",
  databaseURL: "https://bite-point-f1-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "bite-point-f1",
  appId: "1:96026745122:web:1d6d7167a627f676486d7b"
};

// --- 2. Ідентифікація пристрою (1 пристрій = 1 акаунт) ---
let deviceUid = localStorage.getItem("bp_device_uid");
if (!deviceUid) {
  deviceUid = "dev_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  localStorage.setItem("bp_device_uid", deviceUid);
}

let isOnlineConnected = false;
let fbDb = null;
let fbSet = null;
let fbRef = null;

// --- 3. Сесійний (поточний) результат, який живе лише до закриття вкладки ---
function getSessionCurrentRun() {
  try {
    return JSON.parse(sessionStorage.getItem("bp_session_current_run") || "null");
  } catch {
    return null;
  }
}

function setSessionCurrentRun(avgMs, sectors) {
  const data = { avgMs, sectors, timestamp: Date.now() };
  sessionStorage.setItem("bp_session_current_run", JSON.stringify(data));
  return data;
}

// --- 4. Підключення Firebase ---
async function initCloudSync() {
  const dot = document.getElementById("netStatusDot");
  const modePill = document.getElementById("modeIndicatorPill");

  if (!firebaseConfig.apiKey || !firebaseConfig.databaseURL) {
    modePill.textContent = "Локальний режим";
    return;
  }

  try {
    const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
    const { getAuth, signInAnonymously, onAuthStateChanged } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");
    const { getDatabase, ref, set, onValue, onDisconnect } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js");

    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);
    fbDb = getDatabase(app);
    fbSet = set;
    fbRef = ref;

    await signInAnonymously(auth);

    onAuthStateChanged(auth, user => {
      if (!user) return;
      deviceUid = user.uid;
      localStorage.setItem("bp_device_uid", deviceUid);
      isOnlineConnected = true;
      dot.classList.add("online");
      modePill.textContent = "🟢 Live Онлайн";

      // Автоматичне видалення поточного результату після закриття сесії
      const currentAvgRef = ref(fbDb, `leaderboard/${deviceUid}/currentAvg`);
      onDisconnect(currentAvgRef).remove();

      const lbRef = ref(fbDb, "leaderboard");
      onValue(lbRef, snapshot => {
        const val = snapshot.val() || {};
        const list = Object.entries(val).map(([uid, item]) => ({
          uid,
          name: item.name || "ПІЛОТ",
          bestAvg: item.bestAvg,
          bestSectors: item.bestSectors || [],
          currentAvg: item.currentAvg || null
        }));
        localStorage.setItem("bp_drivers_registry_v3", JSON.stringify(list));
        renderClassification();
      });
    });
  } catch (err) {
    console.warn("Firebase fallback to local:", err);
    modePill.textContent = "Локальний режим";
  }
}

// --- 5. Реєстр гравців ---
function getDriversRegistry() {
  try {
    return JSON.parse(localStorage.getItem("bp_drivers_registry_v3") || "[]");
  } catch {
    return [];
  }
}

function syncDriverResult(avgMs, sectors) {
  setSessionCurrentRun(avgMs, sectors);

  const cleanSectors = sectors.map(s => ({ ms: s.ms, fault: Boolean(s.fault) }));
  const registry = getDriversRegistry();
  let myEntry = registry.find(d => d.uid === deviceUid);

  if (!myEntry) {
    myEntry = {
      uid: deviceUid,
      name: currentDriver,
      bestAvg: avgMs,
      bestSectors: cleanSectors,
      currentAvg: avgMs
    };
    registry.push(myEntry);
  } else {
    myEntry.name = currentDriver;
    myEntry.currentAvg = avgMs;
    if (avgMs <= myEntry.bestAvg) {
      myEntry.bestAvg = avgMs;
      myEntry.bestSectors = cleanSectors;
    }
  }

  localStorage.setItem("bp_drivers_registry_v3", JSON.stringify(registry));

  if (isOnlineConnected && fbDb && fbSet && fbRef) {
    fbSet(fbRef(fbDb, `leaderboard/${deviceUid}`), {
      name: myEntry.name,
      bestAvg: myEntry.bestAvg,
      bestSectors: myEntry.bestSectors,
      currentAvg: avgMs,
      updatedAt: Date.now()
    });
  }

  renderClassification();
}

// --- 6. Вібрація та Аудіо-стук ---
function detectVibrationSupport() {
  const hasApi = typeof navigator !== "undefined" && "vibrate" in navigator;
  const isTouchDevice = (navigator.maxTouchPoints && navigator.maxTouchPoints > 0) || ("ontouchstart" in window);
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return Boolean(hasApi && isTouchDevice && !isIOS);
}

const canVibrate = detectVibrationSupport();
const validModes = ["sub_kick", "micro_2ms", "acoustic_only"];
let savedMode = localStorage.getItem("bp_haptic_mode");
if (!validModes.includes(savedMode)) savedMode = null;
let hapticMode = canVibrate ? (savedMode || "sub_kick") : "acoustic_only";

let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function playTone(freq = 860, duration = 0.085, type = "sine") {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(0.16, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch (e) {}
}

function playPhysicalSubThump() {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(125, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(42, ctx.currentTime + 0.028);
    gain.gain.setValueAtTime(0.45, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.032);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.034);
  } catch (e) {}
}

const Haptics = {
  lightKnock() {
    if (!canVibrate || hapticMode === "acoustic_only") {
      playPhysicalSubThump();
      return;
    }
    if (hapticMode === "sub_kick") {
      navigator.vibrate(2);
      playPhysicalSubThump();
    } else if (hapticMode === "micro_2ms") {
      navigator.vibrate(2);
    }
  },
  release() {
    if (!canVibrate || hapticMode === "acoustic_only") {
      playPhysicalSubThump();
    } else {
      navigator.vibrate(3);
      playPhysicalSubThump();
    }
  },
  fault() {
    if (canVibrate && hapticMode !== "acoustic_only") {
      navigator.vibrate([12, 55, 16]);
    } else {
      playPhysicalSubThump();
    }
  }
};

// --- 7. Елементи та Стан гри ---
const pills = document.querySelectorAll(".light-pill");
const statusBadge = document.getElementById("statusBadge");
const mainTimer = document.getElementById("mainTimer");
const clutchPad = document.getElementById("clutchPad");
const clutchTitle = document.getElementById("clutchTitle");
const clutchSub = document.getElementById("clutchSub");
const currentDriverLabel = document.getElementById("currentDriverLabel");
const bestRecordDisplay = document.getElementById("bestRecordDisplay");
const podiumStage = document.getElementById("podiumStage");
const fullHistoryList = document.getElementById("fullHistoryList");

let state = "IDLE";
let activePointerId = null;
let currentDriver = localStorage.getItem("bp_current_driver") || "";
let attempts = [];
let timers = [];
let lightsOutTimestamp = 0;

currentDriverLabel.textContent = currentDriver || "НОВИЙ ПІЛОТ";

function clearAllTimers() {
  timers.forEach(t => clearTimeout(t));
  timers = [];
}

function resetLights() {
  pills.forEach(p => p.classList.remove("on", "fault"));
}

// --- 8. Оцінка кольору сектора в реальному часі (S1, S2, S3 окремо) ---
function evaluateSectorColor(ms, fault, sectorIndex) {
  if (fault || ms >= 350) return "red";

  const registry = getDriversRegistry();
  let fastestInThisSector = Infinity;
  let myBestInThisSector = Infinity;

  registry.forEach(entry => {
    const sec = (entry.bestSectors || [])[sectorIndex];
    if (sec && !sec.fault) {
      if (sec.ms < fastestInThisSector) fastestInThisSector = sec.ms;
      if (entry.uid === deviceUid && sec.ms < myBestInThisSector) {
        myBestInThisSector = sec.ms;
      }
    }
  });

  if (ms <= fastestInThisSector) return "purple";
  if (ms <= myBestInThisSector) return "green";
  return "yellow";
}

function updateQBoxes() {
  for (let i = 0; i < 3; i++) {
    const box = document.getElementById(`qBox${i}`);
    const val = document.getElementById(`qVal${i}`);

    box.className = "q-box";
    if (i === attempts.length && attempts.length < 3) box.classList.add("current");

    if (attempts[i] !== undefined) {
      box.classList.add(`sector-${attempts[i].color}`);
      val.textContent = attempts[i].fault
        ? "+5.000s"
        : `${(attempts[i].ms / 1000).toFixed(3)}s`;
    } else {
      val.textContent = "—";
    }
  }
}

// --- 9. Старт та Фініш ---
function handleHoldStart(e) {
  if (state !== "IDLE") return;
  if (document.querySelector(".modal-backdrop.open")) return;

  if (e.pointerId !== undefined) {
    activePointerId = e.pointerId;
    try { clutchPad.setPointerCapture(e.pointerId); } catch (_) {}
  }

  if (attempts.length >= 3) {
    attempts = [];
    updateQBoxes();
  }

  playPhysicalSubThump();
  state = "STAGING";
  resetLights();

  clutchPad.classList.add("holding");
  clutchPad.classList.remove("go-state");
  clutchTitle.textContent = "Тримай...";
  clutchSub.textContent = "Чекай згасання всіх капсул";
  statusBadge.className = "status-badge";
  statusBadge.textContent = "Відлік старту";
  mainTimer.innerHTML = `0.000<span class="unit">s</span>`;

  for (let i = 0; i < 5; i++) {
    const t = setTimeout(() => {
      pills[i].classList.add("on");
      Haptics.lightKnock();
      playTone(860, 0.085, "sine");

      if (i === 4) {
        state = "HOLD_RANDOM";
        const randomDelay = Math.floor(Math.random() * 2800) + 200;
        const outTimer = setTimeout(() => {
          resetLights();
          state = "LIGHTS_OUT";
          lightsOutTimestamp = performance.now();
          clutchPad.classList.add("go-state");
          clutchTitle.textContent = "ВІДПУСКАЙ!";
          statusBadge.textContent = "СТАРТ!";
        }, randomDelay);
        timers.push(outTimer);
      }
    }, (i + 1) * 900);
    timers.push(t);
  }
}

function handleRelease(e) {
  if (state === "IDLE") return;
  if (e && e.pointerId !== undefined && activePointerId !== null && e.pointerId !== activePointerId) {
    return;
  }

  if (e && e.pointerId !== undefined) {
    try { clutchPad.releasePointerCapture(e.pointerId); } catch (_) {}
  }
  activePointerId = null;

  clutchPad.classList.remove("holding", "go-state");
  const currentSectorIdx = attempts.length;

  if (state === "STAGING" || state === "HOLD_RANDOM") {
    clearAllTimers();
    state = "IDLE";
    Haptics.fault();
    playTone(220, 0.26, "triangle");

    pills.forEach(p => {
      p.classList.remove("on");
      p.classList.add("fault");
    });

    const color = evaluateSectorColor(5000, true, currentSectorIdx);
    statusBadge.className = `status-badge ${color}`;
    statusBadge.textContent = "Фальстарт • Штраф +5с";
    mainTimer.innerHTML = `+5.000<span class="unit">s</span>`;
    recordAttempt(5000, true, color);
  } else if (state === "LIGHTS_OUT") {
    const reactionMs = Math.round(performance.now() - lightsOutTimestamp);
    state = "IDLE";
    Haptics.release();
    playTone(1240, 0.11, "sine");

    const color = evaluateSectorColor(reactionMs, false, currentSectorIdx);
    mainTimer.innerHTML = `${(reactionMs / 1000).toFixed(3)}<span class="unit">s</span>`;
    statusBadge.className = `status-badge ${color}`;
    statusBadge.textContent = getVerdict(reactionMs, color, currentSectorIdx);
    recordAttempt(reactionMs, false, color);
  }

  clutchTitle.textContent = attempts.length >= 3 ? "Нова серія (Затисни)" : "Затисни та тримай";
  clutchSub.textContent = "Відпусти, коли капсули згаснуть";
}

function getVerdict(ms, color, idx) {
  if (color === "purple") return `Фіолетовий S${idx + 1}! Абсолютний рекорд 🟣`;
  if (color === "green") return `Особистий рекорд у S${idx + 1} 🟢`;
  if (ms < 250) return "Жовтий сектор • Солідний темп 🟡";
  if (ms < 350) return "Жовтий сектор • Втрата темпу 🟡";
  return "Червоний сектор • Проспав старт 🔴";
}

function recordAttempt(ms, fault, color) {
  attempts.push({ ms, fault, color });
  updateQBoxes();

  if (attempts.length === 3) {
    const avgMs = Math.round(attempts.reduce((acc, a) => acc + a.ms, 0) / 3);
    syncDriverResult(avgMs, attempts);
    setTimeout(() => {
      statusBadge.textContent = `Серія завершена • Сер: ${(avgMs / 1000).toFixed(3)}s`;
    }, 700);
  }
}

// --- 10. F1 QUALIFYING CLASSIFICATION (Порівняння секторів хто де швидший) ---
function renderClassification() {
  const registry = getDriversRegistry().sort((a, b) => a.bestAvg - b.bestAvg);
  const mySessionRun = getSessionCurrentRun();
  const myRecord = registry.find(d => d.uid === deviceUid);

  if (registry.length === 0) {
    bestRecordDisplay.innerHTML = `<span class="no-record">Поки немає результатів</span>`;
    podiumStage.innerHTML = `<div style="grid-column: 1 / -1; text-align:center; color: var(--md-text-dim); font-size:0.84rem; padding: 30px 0;">Проїдь 3 сектори, щоб відкрити подіум кваліфікації</div>`;
    fullHistoryList.innerHTML = "";
    return;
  }

  const pole = registry[0];
  const myBestHtml = myRecord
    ? `<span class="you-split">Ти: ${(myRecord.bestAvg / 1000).toFixed(3)}s</span>`
    : "";

  bestRecordDisplay.innerHTML = `
    <span class="trophy">P1 ${pole.name}</span>
    <span class="best-time">${(pole.bestAvg / 1000).toFixed(3)}s</span>
    ${myBestHtml}
  `;

  // Знаходимо абсолютний рекорд кожного сектора (S1, S2, S3) серед усіх гравців
  const bestSectorTimes = [Infinity, Infinity, Infinity];
  registry.forEach(driver => {
    (driver.bestSectors || []).forEach((sec, idx) => {
      if (sec && !sec.fault && sec.ms < bestSectorTimes[idx]) {
        bestSectorTimes[idx] = sec.ms;
      }
    });
  });

  // 1. Подіум ТОП-3 (P2 - P1 - P3)
  const p1 = registry[0] || null;
  const p2 = registry[1] || null;
  const p3 = registry[2] || null;

  const buildPodiumCol = (driver, posClass, label) => {
    if (!driver) {
      return `
        <div class="podium-col ${posClass}" style="opacity:0.35">
          <div class="podium-driver">—</div>
          <div class="podium-time">—</div>
          <div class="podium-pillar"><span class="podium-pos">${label}</span></div>
        </div>
      `;
    }
    const isMe = driver.uid === deviceUid;
    const gapMs = driver.bestAvg - pole.bestAvg;
    const gapText = gapMs === 0 ? "POLE" : `+${(gapMs / 1000).toFixed(3)}s`;

    return `
      <div class="podium-col ${posClass} ${isMe ? 'is-me' : ''}">
        <div class="podium-driver">
          <span>${driver.name}</span>
          ${isMe ? '<span class="you-badge">ТИ</span>' : ''}
        </div>
        <div class="podium-time">${(driver.bestAvg / 1000).toFixed(3)}s</div>
        <div class="podium-pillar">
          <span class="podium-pos">${label}</span>
          <span class="podium-gap">${gapText}</span>
        </div>
      </div>
    `;
  };

  podiumStage.innerHTML = `
    ${buildPodiumCol(p2, "p2", "P2")}
    ${buildPodiumCol(p1, "p1", "P1")}
    ${buildPodiumCol(p3, "p3", "P3")}
  `;

  // 2. Список гравців із позначками секторів S1 / S2 / S3 (хто де найшвидший)
  fullHistoryList.innerHTML = registry.map((item, idx) => {
    const isMe = item.uid === deviceUid;
    const gapMs = item.bestAvg - pole.bestAvg;
    const gapStr = gapMs === 0 ? "лідер" : `+${(gapMs / 1000).toFixed(3)}s`;

    // Поточний сесійний час (показується лише якщо гравець вже проїхав у цій сесії)
    const activeCurrentMs = isMe
      ? (mySessionRun ? mySessionRun.avgMs : null)
      : (item.currentAvg || null);

    const sessionBadgeHtml = activeCurrentMs
      ? `<span class="current-run-pill">⚡ ${(activeCurrentMs / 1000).toFixed(3)}s</span>`
      : "";

    // Генеруємо 3 кольорові капсули секторів S1, S2, S3
    const sectors = item.bestSectors || [];
    const sectorBadgesHtml = [0, 1, 2].map(sIdx => {
      const sec = sectors[sIdx];
      if (!sec) return `<span class="sec-pill yellow">S${sIdx + 1} —</span>`;

      let sColor = "yellow";
      if (sec.fault || sec.ms >= 350) {
        sColor = "red";
      } else if (sec.ms <= bestSectorTimes[sIdx]) {
        sColor = "purple"; // Найшвидший серед усіх гравців у цьому секторі!
      } else if (sec.ms - bestSectorTimes[sIdx] <= 35) {
        sColor = "green";  // Дуже близько до лідера сектора (до 35 мс)
      }

      const labelTime = sec.fault ? "+5s" : `${(sec.ms / 1000).toFixed(3)}`;
      return `<span class="sec-pill ${sColor}">S${sIdx + 1} ${labelTime}</span>`;
    }).join("");

    return `
      <div class="driver-row ${isMe ? 'is-me' : ''}">
        <div class="driver-row-top">
          <div class="driver-ident">
            <span class="pos-num">P${idx + 1}</span>
            <span>${item.name}</span>
            ${isMe ? '<span class="you-badge">ТИ</span>' : ''}
          </div>
          <div class="driver-times">
            <span class="best-avg-val">${(item.bestAvg / 1000).toFixed(3)}s</span>
            <span class="gap-to-pole">${gapStr}</span>
          </div>
        </div>
        <div class="driver-dual-stats">
          <div class="driver-meta-left">
            <span>🏆 ${(item.bestAvg / 1000).toFixed(3)}s</span>
            ${sessionBadgeHtml}
          </div>
          <div class="sector-badges-row">
            ${sectorBadgesHtml}
          </div>
        </div>
      </div>
    `;
  }).join("");
}

// --- 11. Модальні вікна + Автоматичний запит юзернейму при першому вході ---
const nameModal = document.getElementById("nameModal");
const driverNameInput = document.getElementById("driverNameInput");
const cancelNameBtn = document.getElementById("cancelNameBtn");
const historyModal = document.getElementById("historyModal");

function setDriverName(newName) {
  const clean = newName.trim().toUpperCase();
  if (!clean) return false;

  currentDriver = clean;
  currentDriverLabel.textContent = currentDriver;
  localStorage.setItem("bp_current_driver", currentDriver);
  localStorage.setItem("bp_has_onboarded", "true");
  cancelNameBtn.style.display = "inline-block";

  const registry = getDriversRegistry();
  const myEntry = registry.find(d => d.uid === deviceUid);
  if (myEntry) {
    myEntry.name = currentDriver;
    localStorage.setItem("bp_drivers_registry_v3", JSON.stringify(registry));
    if (isOnlineConnected && fbDb && fbSet && fbRef) {
      fbSet(fbRef(fbDb, `leaderboard/${deviceUid}/name`), currentDriver);
    }
    renderClassification();
  }
  return true;
}

// Якщо гравець зайшов на сайт вперше — автоматично показуємо вікно вибору нікнейму
function checkFirstTimeOnboarding() {
  const hasOnboarded = localStorage.getItem("bp_has_onboarded");
  if (!hasOnboarded || !currentDriver) {
    cancelNameBtn.style.display = "none"; // Ховаємо "Скасувати", щоб точно ввів ім'я
    driverNameInput.value = "";
    nameModal.classList.add("open");
    setTimeout(() => driverNameInput.focus(), 150);
  }
}

document.getElementById("openNameModalBtn").addEventListener("click", () => {
  playPhysicalSubThump();
  cancelNameBtn.style.display = "inline-block";
  driverNameInput.value = currentDriver;
  nameModal.classList.add("open");
  setTimeout(() => driverNameInput.select(), 80);
});

cancelNameBtn.addEventListener("click", () => {
  if (!localStorage.getItem("bp_has_onboarded")) return;
  nameModal.classList.remove("open");
});

document.getElementById("saveNameBtn").addEventListener("click", () => {
  playPhysicalSubThump();
  const fallback = currentDriver || "ПІЛОТ 1";
  setDriverName(driverNameInput.value || fallback);
  nameModal.classList.remove("open");
});

driverNameInput.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    playPhysicalSubThump();
    const fallback = currentDriver || "ПІЛОТ 1";
    setDriverName(driverNameInput.value || fallback);
    nameModal.classList.remove("open");
  }
});

document.getElementById("openHistoryModalBtn").addEventListener("click", () => {
  playPhysicalSubThump();
  renderClassification();
  historyModal.classList.add("open");
});

document.getElementById("closeHistoryBtn").addEventListener("click", () => {
  historyModal.classList.remove("open");
});

// Налаштування стуку
const hapticModal = document.getElementById("hapticModal");
const hapticModeList = document.getElementById("hapticModeList");
const hapticStatusBadge = document.getElementById("hapticStatusBadge");

function updateModeUI() {
  hapticStatusBadge.textContent = canVibrate
    ? "✓ Вібромотор підтримується (активний вибір 1–3)"
    : "ℹ Вібромотор недоступний — авто-режим №3";

  hapticModeList.querySelectorAll(".mode-option").forEach(btn => {
    const mode = btn.dataset.mode;
    const isDisabled = !canVibrate && mode !== "acoustic_only";
    btn.classList.toggle("disabled", isDisabled);
    btn.classList.toggle("active", mode === hapticMode);
  });
}
updateModeUI();

document.getElementById("openHapticModalBtn").addEventListener("click", () => {
  playPhysicalSubThump();
  updateModeUI();
  hapticModal.classList.add("open");
});

hapticModeList.addEventListener("click", e => {
  const btn = e.target.closest(".mode-option");
  if (!btn || btn.classList.contains("disabled")) return;

  hapticMode = btn.dataset.mode;
  localStorage.setItem("bp_haptic_mode", hapticMode);
  updateModeUI();
  Haptics.lightKnock();
  playTone(860, 0.085, "sine");
});

document.getElementById("testHapticBtn").addEventListener("click", () => {
  Haptics.lightKnock();
  playTone(860, 0.085, "sine");
});

document.getElementById("closeHapticBtn").addEventListener("click", () => {
  hapticModal.classList.remove("open");
});

// --- 12. Слухачі подій ---
clutchPad.addEventListener("pointerdown", handleHoldStart);
clutchPad.addEventListener("pointerup", handleRelease);
clutchPad.addEventListener("pointercancel", handleRelease);
window.addEventListener("contextmenu", e => e.preventDefault());

window.addEventListener("keydown", e => {
  if (e.code === "Space" && !e.repeat && !document.querySelector(".modal-backdrop.open")) {
    handleHoldStart(e);
  }
});
window.addEventListener("keyup", e => {
  if (e.code === "Space") handleRelease(e);
});

renderClassification();
initCloudSync();
checkFirstTimeOnboarding();