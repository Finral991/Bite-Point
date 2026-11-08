// --- 1. Визначення підтримки вібрації ---
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

// --- 2. Синтезатор звуку та Sub-Bass удару ---
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

// --- 3. Елементи та Стан гри ---
const pills = document.querySelectorAll(".light-pill");
const statusBadge = document.getElementById("statusBadge");
const mainTimer = document.getElementById("mainTimer");
const clutchPad = document.getElementById("clutchPad");
const clutchTitle = document.getElementById("clutchTitle");
const clutchSub = document.getElementById("clutchSub");
const currentDriverLabel = document.getElementById("currentDriverLabel");
const bestRecordDisplay = document.getElementById("bestRecordDisplay");
const fullHistoryList = document.getElementById("fullHistoryList");

let state = "IDLE";
let activePointerId = null;
let currentDriver = localStorage.getItem("bp_current_driver") || "ПІЛОТ 1";
let recentDrivers = JSON.parse(localStorage.getItem("bp_recent_drivers") || '["МАКС", "ШАРЛЬ", "ФЕРНАНДО"]');
let attempts = []; // [{ ms, fault, color }]
let timers = [];
let lightsOutTimestamp = 0;

currentDriverLabel.textContent = currentDriver;

function clearAllTimers() {
  timers.forEach(t => clearTimeout(t));
  timers = [];
}

function resetLights() {
  pills.forEach(p => p.classList.remove("on", "fault"));
}

// --- 4. Логіка кольорів секторів Формули-1 ---
function getLeaderboard() {
  try {
    return JSON.parse(localStorage.getItem("bitepoint_md3_lb_v2") || "[]");
  } catch {
    return [];
  }
}

function evaluateSectorColor(ms, fault) {
  if (fault || ms >= 350) return "red";

  const lb = getLeaderboard();
  let overallBestSector = Infinity;
  let personalBestSector = Infinity;

  // Шукаємо найкращі сектори в історії
  lb.forEach(entry => {
    (entry.sectors || []).forEach(sec => {
      if (!sec.fault && sec.ms < overallBestSector) {
        overallBestSector = sec.ms;
      }
      if (entry.driver === currentDriver && !sec.fault && sec.ms < personalBestSector) {
        personalBestSector = sec.ms;
      }
    });
  });

  // Також враховуємо поточні спроби цієї сесії
  attempts.forEach(sec => {
    if (!sec.fault && sec.ms < overallBestSector) overallBestSector = sec.ms;
    if (!sec.fault && sec.ms < personalBestSector) personalBestSector = sec.ms;
  });

  // Якщо це абсолютний рекорд (або перша чиста спроба взагалі) -> Фіолетовий сектор!
  if (ms <= overallBestSector) return "purple";
  // Якщо це особистий рекорд поточного пілота -> Зелений сектор!
  if (ms <= personalBestSector) return "green";
  // Інакше -> Жовтий сектор (повільніше за власний топ)
  return "yellow";
}

function updateQBoxes() {
  for (let i = 0; i < 3; i++) {
    const box = document.getElementById(`qBox${i}`);
    const val = document.getElementById(`qVal${i}`);

    box.className = "q-box";
    if (i === attempts.length && attempts.length < 3) {
      box.classList.add("current");
    }

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

// --- 5. Затискання та Відпускання (Виправлено рух пальцем по кнопці) ---
function handleHoldStart(e) {
  if (state !== "IDLE") return;
  if (document.querySelector(".modal-backdrop.open")) return;

  // Якщо це pointer-подія — захоплюємо палець, щоб рух по кнопці не скидав утримання
  if (e.pointerId !== undefined) {
    activePointerId = e.pointerId;
    try {
      clutchPad.setPointerCapture(e.pointerId);
    } catch (_) {}
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

  // Ігноруємо відпускання чужого пальця
  if (e && e.pointerId !== undefined && activePointerId !== null && e.pointerId !== activePointerId) {
    return;
  }

  if (e && e.pointerId !== undefined) {
    try {
      clutchPad.releasePointerCapture(e.pointerId);
    } catch (_) {}
  }
  activePointerId = null;

  clutchPad.classList.remove("holding", "go-state");

  if (state === "STAGING" || state === "HOLD_RANDOM") {
    clearAllTimers();
    state = "IDLE";
    Haptics.fault();
    playTone(220, 0.26, "triangle");

    pills.forEach(p => {
      p.classList.remove("on");
      p.classList.add("fault");
    });

    const color = evaluateSectorColor(5000, true);
    statusBadge.className = `status-badge ${color}`;
    statusBadge.textContent = "Фальстарт • Штраф +5с";
    mainTimer.innerHTML = `+5.000<span class="unit">s</span>`;
    recordAttempt(5000, true, color);
  } else if (state === "LIGHTS_OUT") {
    const reactionMs = Math.round(performance.now() - lightsOutTimestamp);
    state = "IDLE";
    Haptics.release();
    playTone(1240, 0.11, "sine");

    const color = evaluateSectorColor(reactionMs, false);
    mainTimer.innerHTML = `${(reactionMs / 1000).toFixed(3)}<span class="unit">s</span>`;
    statusBadge.className = `status-badge ${color}`;
    statusBadge.textContent = getVerdict(reactionMs, color);
    recordAttempt(reactionMs, false, color);
  }

  clutchTitle.textContent = attempts.length >= 3 ? "Нова серія (Затисни)" : "Затисни та тримай";
  clutchSub.textContent = "Відпусти, коли капсули згаснуть";
}

function getVerdict(ms, color) {
  if (color === "purple") return "Фіолетовий сектор! Абсолютний рекорд 🟣";
  if (color === "green") return "Особистий рекорд пілота 🟢";
  if (ms < 250) return "Жовтий сектор • Солідний темп 🟡";
  if (ms < 350) return "Жовтий сектор • Втрата темпу 🟡";
  return "Червоний сектор • Проспав старт 🔴";
}

function recordAttempt(ms, fault, color) {
  attempts.push({ ms, fault, color });
  updateQBoxes();

  if (attempts.length === 3) {
    const avgMs = Math.round(attempts.reduce((acc, a) => acc + a.ms, 0) / 3);
    saveToLeaderboard(currentDriver, avgMs, attempts);
    setTimeout(() => {
      statusBadge.textContent = `Серія завершена • Сер: ${(avgMs / 1000).toFixed(3)}s`;
    }, 700);
  }
}

// --- 6. Збереження найкращого результату та Історії ---
function saveToLeaderboard(driver, avgMs, sectors) {
  const lb = getLeaderboard();
  lb.push({
    driver,
    avgMs,
    sectors: sectors.map(s => ({ ms: s.ms, fault: s.fault, color: s.color })),
    date: Date.now()
  });
  lb.sort((a, b) => a.avgMs - b.avgMs);
  localStorage.setItem("bitepoint_md3_lb_v2", JSON.stringify(lb.slice(0, 30)));
  renderBestAndHistory();
}

function renderBestAndHistory() {
  const lb = getLeaderboard();

  // 1. Оновлюємо компактну плашку найкращого результату на головному екрані
  if (lb.length === 0) {
    bestRecordDisplay.innerHTML = `<span class="no-record">Поки немає результатів</span>`;
    fullHistoryList.innerHTML = `<div style="color: var(--md-text-dim); font-size: 0.84rem; text-align:center; padding: 16px;">Історія порожня — проїдь першу серію з 3 стартів!</div>`;
    return;
  }

  const best = lb[0];
  bestRecordDisplay.innerHTML = `
    <span class="trophy">🏆 ${best.driver}</span>
    <span class="best-time">${(best.avgMs / 1000).toFixed(3)}s</span>
  `;

  // 2. Оновлюємо повний список в модалці Історії
  fullHistoryList.innerHTML = lb.map((item, idx) => {
    const sectorsHtml = (item.sectors || []).map((s, i) => `
      <div class="mini-sector ${s.color || 'yellow'}">
        S${i + 1}: ${s.fault ? '+5.0s' : (s.ms / 1000).toFixed(3) + 's'}
      </div>
    `).join("");

    return `
      <div class="history-item">
        <div class="history-top">
          <div><span class="rank">#${idx + 1}</span><span>${item.driver}</span></div>
          <div class="avg-score">${(item.avgMs / 1000).toFixed(3)}s</div>
        </div>
        <div class="history-sectors">${sectorsHtml}</div>
      </div>
    `;
  }).join("");
}

// --- 7. Модальні вікна (Ім'я, Вібро, Історія) ---
const nameModal = document.getElementById("nameModal");
const driverNameInput = document.getElementById("driverNameInput");
const recentDriversContainer = document.getElementById("recentDriversContainer");
const historyModal = document.getElementById("historyModal");

function renderRecentChips() {
  recentDriversContainer.innerHTML = recentDrivers.map(name => `
    <button class="recent-chip" data-name="${name}">${name}</button>
  `).join("");
}

function setDriverName(newName) {
  const clean = newName.trim().toUpperCase();
  if (!clean) return;
  currentDriver = clean;
  currentDriverLabel.textContent = currentDriver;
  localStorage.setItem("bp_current_driver", currentDriver);

  if (!recentDrivers.includes(clean)) {
    recentDrivers.unshift(clean);
    recentDrivers = recentDrivers.slice(0, 6);
    localStorage.setItem("bp_recent_drivers", JSON.stringify(recentDrivers));
  }

  attempts = [];
  updateQBoxes();
  resetLights();
  mainTimer.innerHTML = `0.000<span class="unit">s</span>`;
  statusBadge.className = "status-badge";
  statusBadge.textContent = "Готовий до старту";
}

document.getElementById("openNameModalBtn").addEventListener("click", () => {
  playPhysicalSubThump();
  renderRecentChips();
  driverNameInput.value = currentDriver;
  nameModal.classList.add("open");
  setTimeout(() => driverNameInput.select(), 80);
});

document.getElementById("cancelNameBtn").addEventListener("click", () => nameModal.classList.remove("open"));

document.getElementById("saveNameBtn").addEventListener("click", () => {
  playPhysicalSubThump();
  setDriverName(driverNameInput.value || currentDriver);
  nameModal.classList.remove("open");
});

driverNameInput.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    playPhysicalSubThump();
    setDriverName(driverNameInput.value || currentDriver);
    nameModal.classList.remove("open");
  }
});

recentDriversContainer.addEventListener("click", e => {
  const chip = e.target.closest(".recent-chip");
  if (!chip) return;
  playPhysicalSubThump();
  setDriverName(chip.dataset.name);
  nameModal.classList.remove("open");
});

// Модалка Історії
document.getElementById("openHistoryModalBtn").addEventListener("click", () => {
  playPhysicalSubThump();
  renderBestAndHistory();
  historyModal.classList.add("open");
});

document.getElementById("closeHistoryBtn").addEventListener("click", () => {
  historyModal.classList.remove("open");
});

document.getElementById("clearLbBtn").addEventListener("click", () => {
  playPhysicalSubThump();
  localStorage.removeItem("bitepoint_md3_lb_v2");
  renderBestAndHistory();
});

// Модалка Налаштування стуку
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

// --- 8. Глобальні обробники подій ---
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

renderBestAndHistory();