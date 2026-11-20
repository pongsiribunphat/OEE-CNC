import { db, ref, set, update, onValue } from "./firebase-config.js";
import { goOnline } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import {
  initQC,
  renderQC,
  getPartScoreS1,
  getPartScoreS2,
  formatBadge,
  resetQCSelection,
  openEvidenceModal
} from "./qc.js";
import { initChartsAndModal, updateDashboardCharts } from "./charts-detail.js";
import { initManagerQC, renderManagerQC } from "./manager-qc.js";

const rootRef = ref(db, "cnc_oee_project");

// =========================================================
// ระบบสลับโหมดมืด / โหมดสว่าง (Dark & Light Mode)
// =========================================================
const btnThemeToggle = document.getElementById("btnThemeToggle");
const themeIcon = document.getElementById("themeIcon");
const themeText = document.getElementById("themeText");

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("oee_cnc_theme", theme);
  if (theme === "light") {
    themeIcon.textContent = "🌙";
    themeText.textContent = "โหมดมืด";
  } else {
    themeIcon.textContent = "☀️";
    themeText.textContent = "โหมดสว่าง";
  }
}

const savedTheme = localStorage.getItem("oee_cnc_theme") || "dark";
applyTheme(savedTheme);

btnThemeToggle.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "light" ? "dark" : "light";
  applyTheme(next);
  calculateAndRender();
});

// =========================================================
// ตัวแปรสถานะหลักของระบบ OEE
// =========================================================
let state = {
  settings: {
    stdS1: 10,
    lslS1: 8,
    uslS1: 12,
    stdS2: 12,
    lslS2: 10,
    uslS2: 14,
    setupThreshold: 15,
    breakdownThreshold: 30,
    managerPin: "1234",
    googleSheetUrl: ""
  },
  machine: {
    status: "PAUSED",
    manualStop: false,
    hasStarted: false,
    runSeconds: 0,
    setupSeconds: 0,
    breakdownSeconds: 0,
    idleSeconds: 0,
    setupCount: 0,
    breakdownCount: 0,
    normalPartsCount: 0
  },
  parts: {}
};

let expectedSensor = 1;
let s1AccumulatedMs = 0;
let s1SegmentStart = null;
let s2AccumulatedMs = 0;
let s2SegmentStart = null;
let recordedT1 = 0;
let currentCycleInterrupted = false;

let cycleRunSec = 0;
let cycleSetupSec = 0;
let cycleBreakdownSec = 0;

let serialPort = null;
let serialWriter = null;

async function sendToArduino(cmd) {
  if (!serialWriter) return;
  try {
    await serialWriter.write(`${cmd}\n`);
  } catch (err) {
    console.warn("Send to Arduino failed:", err);
  }
}

initQC();
initChartsAndModal();
initManagerQC(() => calculateAndRender());

// =========================================================
// ระบบหน้าต่างเลือกบทบาทตอนเข้าเว็บ & แยกสิทธิ์ ผู้เข้าชม vs ผู้จัดการ
// =========================================================
let isManagerAuthenticated = sessionStorage.getItem("oee_session_role") === "manager";
const welcomeGate = document.getElementById("welcomeRoleGate");
const loginModal = document.getElementById("managerLoginModal");
const loginInput = document.getElementById("managerPasswordInput");
const loginError = document.getElementById("managerLoginError");

function openManagerLoginPopup() {
  loginInput.value = "";
  loginError.style.display = "none";
  loginModal.classList.add("open");
  setTimeout(() => loginInput.focus(), 50);
}

function setRoleMode(isManager) {
  isManagerAuthenticated = isManager;
  if (isManager) {
    sessionStorage.setItem("oee_session_role", "manager");
  } else {
    sessionStorage.setItem("oee_session_role", "visitor");
  }

  if (welcomeGate) welcomeGate.classList.remove("open");

  const roleBadge = document.getElementById("roleBadge");
  const operatorNavTabs = document.getElementById("operatorNavTabs");
  const managerNavTabs = document.getElementById("managerNavTabs");

  document.querySelectorAll(".page-section").forEach(sec => sec.classList.remove("active"));

  if (isManager) {
    roleBadge.textContent = "👔 โหมดผู้จัดการ";
    roleBadge.className = "role-badge role-manager";
    operatorNavTabs.style.display = "none";
    managerNavTabs.style.display = "flex";

    managerNavTabs.querySelectorAll(".tab-btn").forEach((b, idx) => {
      b.classList.toggle("active", idx === 0);
    });
    document.getElementById("page-dashboard").classList.add("active");
    calculateAndRender();
  } else {
    roleBadge.textContent = "👀 ผู้เข้าชม / พนักงาน";
    roleBadge.className = "role-badge role-operator";
    operatorNavTabs.style.display = "flex";
    managerNavTabs.style.display = "none";

    document.getElementById("page-qc").classList.add("active");
    calculateAndRender();
  }
}

document.getElementById("btnChooseVisitor").addEventListener("click", () => {
  setRoleMode(false);
});

document.getElementById("btnChooseManager").addEventListener("click", () => {
  openManagerLoginPopup();
});

document.getElementById("btnOpenRoleGate").addEventListener("click", () => {
  if (welcomeGate) welcomeGate.classList.add("open");
});

document.getElementById("btnCloseLoginModal").addEventListener("click", () => {
  loginModal.classList.remove("open");
});

loginModal.addEventListener("click", (e) => {
  if (e.target === loginModal) loginModal.classList.remove("open");
});

document.getElementById("managerLoginForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const enteredPin = loginInput.value.trim();
  const validPin = String(state.settings.managerPin || "1234");

  if (enteredPin === validPin) {
    loginModal.classList.remove("open");
    loginError.style.display = "none";
    setRoleMode(true);
  } else {
    loginError.style.display = "block";
    loginInput.value = "";
    loginInput.focus();
  }
});

const initialSessionRole = sessionStorage.getItem("oee_session_role");
if (initialSessionRole === "manager") {
  setRoleMode(true);
} else if (initialSessionRole === "visitor") {
  setRoleMode(false);
} else {
  if (welcomeGate) welcomeGate.classList.add("open");
}

// 1. ระบบสลับแท็บเมนูในโหมดผู้จัดการ
document.querySelectorAll("#managerNavTabs .tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    if (!isManagerAuthenticated) return;
    document.querySelectorAll("#managerNavTabs .tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".page-section").forEach(sec => sec.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.target).classList.add("active");
    requestAnimationFrame(() => calculateAndRender());
  });
});

// =========================================================
// 2. ระบบเชื่อมต่อ Firebase + ปลุกการเชื่อมต่ออัตโนมัติเวลารีเฟรช
// =========================================================
const statusEl = document.getElementById("firebaseStatus");
let isFirebaseConnected = false;

try {
  goOnline(db);
} catch (e) {
  console.warn("goOnline notice:", e);
}

onValue(ref(db, ".info/connected"), (snap) => {
  isFirebaseConnected = snap.val() === true;
  if (isFirebaseConnected) {
    statusEl.textContent = "เชื่อมต่อสำเร็จ";
    statusEl.classList.add("online");
  } else {
    statusEl.textContent = "กำลังเชื่อมต่อใหม่...";
    statusEl.classList.remove("online");
  }
});

setInterval(() => {
  if (!isFirebaseConnected && navigator.onLine) {
    try {
      goOnline(db);
    } catch (_) {}
  }
}, 5000);

onValue(
  ref(db, "cnc_oee_project/settings"),
  (snapshot) => {
    isFirebaseConnected = true;
    statusEl.textContent = "เชื่อมต่อสำเร็จ";
    statusEl.classList.add("online");

    const s = snapshot.val();
    if (s) {
      state.settings = {
        stdS1: Number(s.stdS1 || 10),
        lslS1: s.lslS1 !== undefined ? Number(s.lslS1) : 8,
        uslS1: s.uslS1 !== undefined ? Number(s.uslS1) : 12,
        stdS2: Number(s.stdS2 || 12),
        lslS2: s.lslS2 !== undefined ? Number(s.lslS2) : 10,
        uslS2: s.uslS2 !== undefined ? Number(s.uslS2) : 14,
        setupThreshold: Number(s.setupThreshold || 15),
        breakdownThreshold: Number(s.breakdownThreshold || 30),
        managerPin: String(s.managerPin || "1234"),
        googleSheetUrl: String(s.googleSheetUrl || "")
      };
      updateAutoSheetBadge(
        state.settings.googleSheetUrl
          ? "🟢 ซิงค์อัตโนมัติ: พร้อมทำงาน"
          : "☁️ ซิงค์อัตโนมัติ: ยังไม่ใส่ URL ใน Setting"
      );
      calculateAndRender();
    }
  },
  (err) => {
    console.error("Firebase Settings Error:", err);
    statusEl.textContent = `หลุดการเชื่อมต่อ (${err.code || "Error"})`;
    statusEl.classList.remove("online");
  }
);

onValue(
  ref(db, "cnc_oee_project/machine"),
  (snapshot) => {
    const m = snapshot.val();
    if (m) {
      state.machine = {
        status: m.status || "PAUSED",
        manualStop: Boolean(m.manualStop),
        hasStarted: Boolean(m.hasStarted),
        runSeconds: Number(m.runSeconds || 0),
        setupSeconds: Number(m.setupSeconds || 0),
        breakdownSeconds: Number(m.breakdownSeconds || 0),
        idleSeconds: Number(m.idleSeconds || 0),
        setupCount: Number(m.setupCount || 0),
        breakdownCount: Number(m.breakdownCount || 0),
        normalPartsCount: Number(m.normalPartsCount || 0)
      };
      calculateAndRender();
    }
  },
  (err) => {
    console.error("Firebase Machine Error:", err);
  }
);

let lastSyncedPartsSignature = null;

function buildPartsSignature(partsObj) {
  const list = Object.values(partsObj || {});
  return list
    .map(p => `${p.id}:${p.t1}:${p.t2}:${p.qScoreS1}:${p.qScoreS2}:${p.note || ""}:${p.qImage ? p.qImage.length : 0}`)
    .join("|");
}

onValue(
  ref(db, "cnc_oee_project/parts"),
  (snapshot) => {
    state.parts = snapshot.val() || {};
    calculateAndRender();

    const currentSig = buildPartsSignature(state.parts);
    if (lastSyncedPartsSignature === null) {
      lastSyncedPartsSignature = currentSig;
    } else if (currentSig !== lastSyncedPartsSignature) {
      lastSyncedPartsSignature = currentSig;
      scheduleAutoSyncToSheet();
    }
  },
  (err) => {
    console.error("Firebase Parts Error:", err);
  }
);

// 3. นาฬิกาหลักทำงานทุก 0.1 วินาที
let tickCounter = 0;
setInterval(() => {
  const isPaused = state.machine.status === "PAUSED";

  if (!isPaused) {
    if (s1SegmentStart !== null) {
      const totalMs1 = s1AccumulatedMs + (Date.now() - s1SegmentStart);
      document.getElementById("liveTimerS1").textContent = `${(totalMs1 / 1000).toFixed(2)} วินาที`;
    }
    if (s2SegmentStart !== null) {
      const totalMs2 = s2AccumulatedMs + (Date.now() - s2SegmentStart);
      document.getElementById("liveTimerS2").textContent = `${(totalMs2 / 1000).toFixed(2)} วินาที`;
    }
  }

  tickCounter++;
  if (tickCounter >= 10) {
    tickCounter = 0;
    if (!state.machine.hasStarted || isPaused || !isFirebaseConnected) return;

    const isProcessingPart = (s1SegmentStart !== null || s2SegmentStart !== null);
    const prevStatus = state.machine.status;
    let currentStatus = prevStatus;

    if (state.machine.manualStop) {
      currentStatus = "BREAKDOWN";
      state.machine.breakdownSeconds += 1;
      cycleBreakdownSec += 1;
      currentCycleInterrupted = true;
    } else if (isProcessingPart) {
      currentStatus = "RUNNING";
      state.machine.idleSeconds = 0;
      state.machine.runSeconds += 1;
      cycleRunSec += 1;
    } else {
      state.machine.idleSeconds += 1;

      if (state.machine.idleSeconds > state.settings.breakdownThreshold) {
        currentStatus = "BREAKDOWN";
        state.machine.breakdownSeconds += 1;
        cycleBreakdownSec += 1;
        currentCycleInterrupted = true;
        if (prevStatus !== "BREAKDOWN") {
          state.machine.breakdownCount += 1;
        }
      } else if (state.machine.idleSeconds > state.settings.setupThreshold) {
        currentStatus = "SETUP";
        state.machine.setupSeconds += 1;
        cycleSetupSec += 1;
        currentCycleInterrupted = true;
        if (prevStatus !== "SETUP") {
          state.machine.setupCount += 1;
        }
      } else {
        currentStatus = "RUNNING";
      }
    }

    state.machine.status = currentStatus;
    update(ref(db, "cnc_oee_project/machine"), {
      status: state.machine.status,
      runSeconds: state.machine.runSeconds,
      setupSeconds: state.machine.setupSeconds,
      breakdownSeconds: state.machine.breakdownSeconds,
      idleSeconds: state.machine.idleSeconds,
      setupCount: state.machine.setupCount,
      breakdownCount: state.machine.breakdownCount
    });
  }
}, 100);

// 4. ปุ่มควบคุมเครื่องจักร: Start / Stop / Pause
document.getElementById("btnStartMachine").addEventListener("click", () => {
  if (s1AccumulatedMs > 0 && s1SegmentStart === null) s1SegmentStart = Date.now();
  if (s2AccumulatedMs > 0 && s2SegmentStart === null) s2SegmentStart = Date.now();

  const nextNum = Object.keys(state.parts).length + 1;
  sendToArduino(`N,${nextNum}`);

  update(ref(db, "cnc_oee_project/machine"), {
    status: "RUNNING",
    manualStop: false,
    hasStarted: true,
    idleSeconds: 0
  });
});

document.getElementById("btnStopMachine").addEventListener("click", () => {
  if (s1AccumulatedMs > 0 && s1SegmentStart === null) s1SegmentStart = Date.now();
  if (s2AccumulatedMs > 0 && s2SegmentStart === null) s2SegmentStart = Date.now();

  const nextBreakdownCount = state.machine.status !== "BREAKDOWN"
    ? state.machine.breakdownCount + 1
    : state.machine.breakdownCount;

  currentCycleInterrupted = true;

  update(ref(db, "cnc_oee_project/machine"), {
    status: "BREAKDOWN",
    manualStop: true,
    breakdownCount: nextBreakdownCount
  });
});

document.getElementById("btnPauseSystem").addEventListener("click", () => {
  if (s1SegmentStart !== null) {
    s1AccumulatedMs += (Date.now() - s1SegmentStart);
    s1SegmentStart = null;
  }
  if (s2SegmentStart !== null) {
    s2AccumulatedMs += (Date.now() - s2SegmentStart);
    s2SegmentStart = null;
  }

  update(ref(db, "cnc_oee_project/machine"), {
    status: "PAUSED"
  });
});

// =========================================================
// 5. ฟังก์ชันทำงานอัตโนมัติเมื่อรับสัญญาณ Sensor 1 -> 2 -> 3
// =========================================================
function triggerSensor1() {
  if (expectedSensor !== 1) return;

  s1AccumulatedMs = 0;
  s1SegmentStart = Date.now();
  currentCycleInterrupted = false;
  expectedSensor = 2;

  document.getElementById("statusTimerS1").textContent = "กำลังจับเวลา Station 1...";

  update(ref(db, "cnc_oee_project/machine"), {
    status: "RUNNING",
    idleSeconds: 0
  });
}

function triggerSensor2(exactT1 = null) {
  if (expectedSensor !== 2) return;

  const totalMs1 = s1AccumulatedMs + (s1SegmentStart ? (Date.now() - s1SegmentStart) : 0);
  recordedT1 = (exactT1 !== null && !isNaN(exactT1))
    ? Number(exactT1.toFixed(2))
    : Number((totalMs1 / 1000).toFixed(2));
  s1AccumulatedMs = 0;
  s1SegmentStart = null;

  document.getElementById("liveTimerS1").textContent = `${recordedT1.toFixed(2)} วินาที`;
  document.getElementById("statusTimerS1").textContent = `เสร็จสิ้น Station 1 (ใช้เวลา ${recordedT1} วิ)`;

  s2AccumulatedMs = 0;
  s2SegmentStart = Date.now();
  expectedSensor = 3;
  document.getElementById("statusTimerS2").textContent = "กำลังจับเวลา Station 2...";
}

function triggerSensor3(exactT1 = null, exactT2 = null) {
  if (expectedSensor !== 3) return;

  if (exactT1 !== null && !isNaN(exactT1)) {
    recordedT1 = Number(exactT1.toFixed(2));
    document.getElementById("liveTimerS1").textContent = `${recordedT1.toFixed(2)} วินาที`;
  }

  const totalMs2 = s2AccumulatedMs + (s2SegmentStart ? (Date.now() - s2SegmentStart) : 0);
  const recordedT2 = (exactT2 !== null && !isNaN(exactT2))
    ? Number(exactT2.toFixed(2))
    : Number((totalMs2 / 1000).toFixed(2));
  s2AccumulatedMs = 0;
  s2SegmentStart = null;
  expectedSensor = 1;

  document.getElementById("liveTimerS2").textContent = `${recordedT2.toFixed(2)} วินาที`;
  document.getElementById("statusTimerS2").textContent = `เสร็จสิ้น Station 2 (ใช้เวลา ${recordedT2} วิ)`;

  const existingKeys = Object.keys(state.parts);
  const nextNum = existingKeys.length + 1;
  const partId = `P${String(nextNum).padStart(3, "0")}`;

  sendToArduino(`N,${nextNum + 1}`);

  const nowStr = new Date().toLocaleString("th-TH", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

  const nextNormalParts = !currentCycleInterrupted
    ? state.machine.normalPartsCount + 1
    : state.machine.normalPartsCount;

  set(ref(db, `cnc_oee_project/parts/${partId}`), {
    id: partId,
    createdAt: nowStr,
    t1: recordedT1,
    t2: recordedT2,
    cycleRunSec: cycleRunSec,
    cycleSetupSec: cycleSetupSec,
    cycleBreakdownSec: cycleBreakdownSec,
    qScoreS1: 100,
    qScoreS2: 100,
    qScore: 100,
    noteS1: "ไม่เสียหาย (0 เส้น)",
    noteS2: "ไม่เสียหาย (0 เส้น)",
    note: "S1: ไม่เสียหาย (0 เส้น) | S2: ไม่เสียหาย (0 เส้น)"
  });

  cycleRunSec = 0;
  cycleSetupSec = 0;
  cycleBreakdownSec = 0;

  update(ref(db, "cnc_oee_project/machine"), {
    idleSeconds: 0,
    normalPartsCount: nextNormalParts
  });
}

function resetCycleState() {
  expectedSensor = 1;
  s1AccumulatedMs = 0;
  s1SegmentStart = null;
  s2AccumulatedMs = 0;
  s2SegmentStart = null;
  document.getElementById("statusTimerS1").textContent = "รอวัตถุออกจาก Sensor 1...";
  document.getElementById("statusTimerS2").textContent = "รอวัตถุออกจาก Sensor 2...";
}

// 6. หน้า Setting (ผู้จัดการ)
document.getElementById("btnSaveSettings").addEventListener("click", () => {
  const std1 = Number(document.getElementById("inputStdS1").value);
  const lsl1 = Number(document.getElementById("inputLslS1").value);
  const usl1 = Number(document.getElementById("inputUslS1").value);
  const std2 = Number(document.getElementById("inputStdS2").value);
  const lsl2 = Number(document.getElementById("inputLslS2").value);
  const usl2 = Number(document.getElementById("inputUslS2").value);
  const setupT = Number(document.getElementById("inputSetupTime").value);
  const breakdownT = Number(document.getElementById("inputBreakdownTime").value);
  const newPin = document.getElementById("inputManagerPin").value.trim();
  const sheetUrl = document.getElementById("inputSheetWebhook").value.trim();

  if (std1 <= 0 || std2 <= 0 || setupT <= 0 || breakdownT <= 0) {
    alert("กรุณากรอกค่าเวลาทั้งหมดมากกว่า 0 วินาทีครับ");
    return;
  }
  if (usl1 <= lsl1 || usl2 <= lsl2) {
    alert("ค่า USL ต้องมากกว่าค่า LSL ในทุก Station ครับ");
    return;
  }
  if (breakdownT <= setupT) {
    alert("เวลา Breakdown ต้องมากกว่าเวลา Setup ครับ (เช่น Setup 15 วิ, Breakdown 30 วิ)");
    return;
  }
  if (!newPin || newPin.length < 4) {
    alert("กรุณากำหนดรหัสผ่านผู้จัดการอย่างน้อย 4 ตัวอักษรครับ");
    return;
  }

  set(ref(db, "cnc_oee_project/settings"), {
    stdS1: std1,
    lslS1: lsl1,
    uslS1: usl1,
    stdS2: std2,
    lslS2: lsl2,
    uslS2: usl2,
    setupThreshold: setupT,
    breakdownThreshold: breakdownT,
    managerPin: newPin,
    googleSheetUrl: sheetUrl
  }).then(() => alert("บันทึกการตั้งค่าทั้งหมดและขอบเขต USL/LSL เรียบร้อยแล้ว!"));
});

document.getElementById("btnResetAllData").addEventListener("click", () => {
  if (!confirm("ยืนยันการล้างข้อมูลเวลาและชิ้นงานทั้งหมดใช่ไหมครับ?")) return;
  resetCycleState();
  currentCycleInterrupted = false;
  cycleRunSec = 0;
  cycleSetupSec = 0;
  cycleBreakdownSec = 0;
  resetQCSelection();
  sendToArduino("N,1");

  document.getElementById("liveTimerS1").textContent = "0.00 วินาที";
  document.getElementById("liveTimerS2").textContent = "0.00 วินาที";

  const logEl = document.getElementById("arduinoSerialLog");
  if (logEl) {
    logEl.textContent = "สถานะเซ็นเซอร์: รอรับสัญญาณ Sensor 1 จากบอร์ด Arduino...";
  }

  update(rootRef, {
    machine: {
      status: "PAUSED",
      manualStop: false,
      hasStarted: false,
      runSeconds: 0,
      setupSeconds: 0,
      breakdownSeconds: 0,
      idleSeconds: 0,
      setupCount: 0,
      breakdownCount: 0,
      normalPartsCount: 0
    },
    parts: null
  });
});

// 7. คำนวณสูตร OEE และอัปเดตหน้าจอทั้งหมด
function calculateAndRender() {
  const stateText = document.getElementById("machineStateText");
  const btnStart = document.getElementById("btnStartMachine");
  const btnStop = document.getElementById("btnStopMachine");
  const btnPause = document.getElementById("btnPauseSystem");

  const lampGreen = document.getElementById("lampGreen");
  const lampYellow = document.getElementById("lampYellow");
  const lampRed = document.getElementById("lampRed");

  lampGreen.classList.remove("active");
  lampYellow.classList.remove("active");
  lampRed.classList.remove("active");

  const st = state.machine.status;

  if (st === "RUNNING") {
    lampGreen.classList.add("active");
    stateText.textContent = "สถานะ: กำลังเดินเครื่อง (RUNNING)";
    btnStart.disabled = true;
    btnStop.disabled = false;
    btnPause.disabled = false;
  } else if (st === "SETUP") {
    lampYellow.classList.add("active");
    stateText.textContent = "สถานะ: กำลังตั้งค่า / รอชิ้นงาน (SETUP)";
    btnStart.disabled = true;
    btnStop.disabled = false;
    btnPause.disabled = false;
  } else if (st === "BREAKDOWN") {
    lampRed.classList.add("active");
    stateText.textContent = state.machine.manualStop
      ? "สถานะ: เครื่องหยุดทำงาน (กดหยุดเอง - BREAKDOWN)"
      : "สถานะ: เครื่องขัดข้อง / รอนานเกินกำหนด (BREAKDOWN)";
    btnStart.disabled = !state.machine.manualStop;
    btnStop.disabled = state.machine.manualStop;
    btnPause.disabled = false;
  } else {
    stateText.textContent = state.machine.hasStarted
      ? "สถานะ: หยุดระบบชั่วคราว (ไม่นับเวลา / ไม่ลด OEE)"
      : "สถานะ: หยุดระบบ (พร้อมเริ่มงาน)";
    btnStart.disabled = false;
    btnStop.disabled = !state.machine.hasStarted;
    btnPause.disabled = true;
  }

  document.getElementById("displayRunTime").textContent = state.machine.runSeconds;
  document.getElementById("displaySetupTime").textContent = state.machine.setupSeconds;
  document.getElementById("displayBreakdownTime").textContent = state.machine.breakdownSeconds;

  document.getElementById("displayNormalParts").textContent = state.machine.normalPartsCount;
  document.getElementById("displaySetupCount").textContent = state.machine.setupCount;
  document.getElementById("displayBreakdownCount").textContent = state.machine.breakdownCount;

  const isProcessingPart = (s1SegmentStart !== null || s2SegmentStart !== null);
  const idleText = isProcessingPart
    ? "กำลังผลิตชิ้นงานอยู่ในสถานี (นับเวลา Run เข้า OEE)..."
    : `รอชิ้นงานออก S1: ${state.machine.idleSeconds} วิ (ยังไม่นับ OEE | Setup > ${state.settings.setupThreshold} วิ / Breakdown > ${state.settings.breakdownThreshold} วิ)`;
  document.getElementById("idleMonitorText").textContent = idleText;

  document.getElementById("stdTimeLabel1").textContent = `มาตรฐาน: ${state.settings.stdS1} วิ`;
  document.getElementById("stdTimeLabel2").textContent = `มาตรฐาน: ${state.settings.stdS2} วิ`;
  if (document.activeElement.id !== "inputStdS1") document.getElementById("inputStdS1").value = state.settings.stdS1;
  if (document.activeElement.id !== "inputLslS1") document.getElementById("inputLslS1").value = state.settings.lslS1;
  if (document.activeElement.id !== "inputUslS1") document.getElementById("inputUslS1").value = state.settings.uslS1;
  if (document.activeElement.id !== "inputStdS2") document.getElementById("inputStdS2").value = state.settings.stdS2;
  if (document.activeElement.id !== "inputLslS2") document.getElementById("inputLslS2").value = state.settings.lslS2;
  if (document.activeElement.id !== "inputUslS2") document.getElementById("inputUslS2").value = state.settings.uslS2;
  if (document.activeElement.id !== "inputSetupTime") document.getElementById("inputSetupTime").value = state.settings.setupThreshold;
  if (document.activeElement.id !== "inputBreakdownTime") document.getElementById("inputBreakdownTime").value = state.settings.breakdownThreshold;
  if (document.activeElement.id !== "inputManagerPin") document.getElementById("inputManagerPin").value = state.settings.managerPin;

  const sheetInput = document.getElementById("inputSheetWebhook");
  if (sheetInput && document.activeElement.id !== "inputSheetWebhook") {
    sheetInput.value = state.settings.googleSheetUrl || "";
  }

  const partsList = Object.values(state.parts);
  const totalParts = partsList.length;

  const counts = { c100: 0, cPartial: 0, c0: 0 };
  let sumQS1 = 0;
  let sumQS2 = 0;
  let sumActualT1 = 0;
  let sumActualT2 = 0;

  partsList.forEach(p => {
    const sc1 = getPartScoreS1(p);
    const sc2 = getPartScoreS2(p);
    sumQS1 += sc1;
    sumQS2 += sc2;

    [sc1, sc2].forEach(sc => {
      if (sc === 100) counts.c100++;
      else if (sc === 0) counts.c0++;
      else counts.cPartial++;
    });

    sumActualT1 += Number(p.t1 || 0);
    sumActualT2 += Number(p.t2 || 0);
  });

  document.getElementById("displayTotalParts").textContent = totalParts;

  const totalPlannedTime = state.machine.runSeconds + state.machine.setupSeconds + state.machine.breakdownSeconds;
  const availability = totalPlannedTime > 0 ? (state.machine.runSeconds / totalPlannedTime) : 0;

  const perfS1 = sumActualT1 > 0 ? Math.min(1, (state.settings.stdS1 * totalParts) / sumActualT1) : 0;
  const perfS2 = sumActualT2 > 0 ? Math.min(1, (state.settings.stdS2 * totalParts) / sumActualT2) : 0;
  const sumStdTotal = (state.settings.stdS1 + state.settings.stdS2) * totalParts;
  const sumActualTotal = sumActualT1 + sumActualT2;
  const perfTotal = sumActualTotal > 0 ? Math.min(1, sumStdTotal / sumActualTotal) : 0;

  const qualityS1 = totalParts > 0 ? (sumQS1 / (totalParts * 100)) : 1;
  const qualityS2 = totalParts > 0 ? (sumQS2 / (totalParts * 100)) : 1;
  const qualityTotal = (qualityS1 + qualityS2) / 2;

  document.getElementById("goodPartsSummary").textContent =
    `Q1: ${(qualityS1 * 100).toFixed(0)}% | Q2: ${(qualityS2 * 100).toFixed(0)}%`;

  const oeeS1 = availability * perfS1 * qualityS1;
  const oeeS2 = availability * perfS2 * qualityS2;
  const oeeTotal = availability * perfTotal * qualityTotal;

  document.getElementById("aS1").textContent = `${(availability * 100).toFixed(1)}%`;
  document.getElementById("pS1").textContent = `${(perfS1 * 100).toFixed(1)}%`;
  document.getElementById("qS1").textContent = `${(qualityS1 * 100).toFixed(1)}%`;
  document.getElementById("oeeS1").textContent = `${(oeeS1 * 100).toFixed(1)}%`;

  document.getElementById("aS2").textContent = `${(availability * 100).toFixed(1)}%`;
  document.getElementById("pS2").textContent = `${(perfS2 * 100).toFixed(1)}%`;
  document.getElementById("qS2").textContent = `${(qualityS2 * 100).toFixed(1)}%`;
  document.getElementById("oeeS2").textContent = `${(oeeS2 * 100).toFixed(1)}%`;

  document.getElementById("aTotal").textContent = `${(availability * 100).toFixed(1)}%`;
  document.getElementById("pTotal").textContent = `${(perfTotal * 100).toFixed(1)}%`;
  document.getElementById("qTotal").textContent = `${(qualityTotal * 100).toFixed(1)}%`;
  document.getElementById("oeeTotal").textContent = `${(oeeTotal * 100).toFixed(1)}%`;

  const tbody = document.getElementById("partsTableBody");
  if (totalParts === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-cell">ยังไม่มีข้อมูลการผลิต</td></tr>`;
  } else {
    tbody.innerHTML = partsList.slice().reverse().map(p => {
      const totalT = (Number(p.t1) + Number(p.t2)).toFixed(2);
      const sc1 = getPartScoreS1(p);
      const sc2 = getPartScoreS2(p);
      const evidenceHtml = p.qImage
        ? `<button type="button" class="btn-evidence-thumb" data-dash-img="${p.id}">
             <img src="${p.qImage}" alt="${p.id}" />
             <span>ดูรูป</span>
           </button>`
        : `<span class="no-evidence-tag">ไม่มีรูป</span>`;

      return `
        <tr>
          <td><strong>${p.id}</strong></td>
          <td>${p.createdAt || "-"}</td>
          <td>${Number(p.t1).toFixed(2)}</td>
          <td>${Number(p.t2).toFixed(2)}</td>
          <td>${totalT}</td>
          <td>${formatBadge(sc1)}</td>
          <td>${formatBadge(sc2)}</td>
          <td>${evidenceHtml}</td>
          <td>${p.note || "-"}</td>
        </tr>
      `;
    }).join("");

    tbody.querySelectorAll("[data-dash-img]").forEach(btn => {
      btn.addEventListener("click", () => openEvidenceModal(btn.dataset.dashImg));
    });
  }

  renderQC(state.parts, partsList, qualityS1, qualityS2, qualityTotal, counts);
  updateDashboardCharts(partsList, state.settings, {
    availability,
    perfS1,
    perfS2,
    perfTotal,
    qualityS1,
    qualityS2,
    qualityTotal,
    oeeS1,
    oeeS2,
    oeeTotal
  });

  renderManagerQC(partsList, state.settings);
}

// วาดกราฟใหม่ทันทีเมื่อหมุนหน้าจอหรือย่อขยายหน้าต่างเบราว์เซอร์
let resizeDebounceTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeDebounceTimer);
  resizeDebounceTimer = setTimeout(() => {
    calculateAndRender();
  }, 150);
});

// =========================================================
// 8. ระบบเชื่อมต่อบอร์ด Arduino (Baud 115200 | โปรโตคอล EVT,...)
// =========================================================
let isInitialTriggerLoad = true;
let lastFirebaseTriggerTs = null;

function handleArduinoSignal(rawText) {
  const clean = String(rawText || "").trim();
  if (!clean) return;

  const logEl = document.getElementById("arduinoSerialLog");
  const timeStr = new Date().toLocaleTimeString("th-TH");

  if (clean.startsWith("LIVE,")) {
    const liveParts = clean.split(",");
    if (logEl && !logEl.dataset.lockEvt) {
      logEl.textContent = `🟢 รับสัญญาณจากบอร์ดปกติ (${timeStr}) | สถานะบอร์ด: ${liveParts[2] || "-"} (Sec ${liveParts[1] || "0"})`;
    }
    return;
  }

  if (logEl) {
    logEl.dataset.lockEvt = "1";
    logEl.textContent = `📡 เหตุการณ์จากบอร์ด (${timeStr}): "${clean}"`;
    clearTimeout(logEl._unlockTimer);
    logEl._unlockTimer = setTimeout(() => {
      delete logEl.dataset.lockEvt;
    }, 3000);
  }

  if (clean === "READY") {
    const nextNum = Object.keys(state.parts).length + 1;
    sendToArduino(`N,${nextNum}`);
    if (logEl) logEl.textContent += ` ➔ ซิงค์เลขชิ้นงาน P${String(nextNum).padStart(4, "0")} ไปที่จอ LCD แล้ว`;
    return;
  }

  if (state.machine.status === "PAUSED" || state.machine.manualStop) {
    if (logEl) {
      logEl.textContent += " ⚠️ (กรุณากดปุ่ม '▶ เดินเครื่อง (Start)' สีเขียวด้านบนก่อนครับ)";
    }
    return;
  }

  const parts = clean.split(",");
  if (parts[0] === "EVT") {
    const evtName = parts[1];

    if (evtName === "SECTION" && parts[2] === "1") {
      if (logEl) logEl.textContent += " ➔ วัตถุบัง Sensor 1 (รอปล่อยผ่านเพื่อเริ่มจับเวลา)";
    } else if (evtName === "T1_START") {
      expectedSensor = 1;
      triggerSensor1();
      if (logEl) logEl.textContent += " ➔ เริ่มจับเวลา Station 1";
    } else if (evtName === "T1_DONE") {
      const t1Val = parseFloat(parts[2]);
      expectedSensor = 2;
      triggerSensor2(t1Val);
      if (logEl) logEl.textContent += ` ➔ จบ S1 (${t1Val} วิ) เริ่มจับเวลา Station 2`;
    } else if (evtName === "T2_START") {
      if (expectedSensor === 2) triggerSensor2();
    } else if (evtName === "CYCLE_DONE") {
      const t1Val = parseFloat(parts[2]);
      const t2Val = parseFloat(parts[3]);
      expectedSensor = 3;
      triggerSensor3(t1Val, t2Val);
      if (logEl) logEl.textContent += ` ➔ จบชิ้นงาน (T1: ${t1Val}วิ, T2: ${t2Val}วิ) บันทึกแล้ว!`;
    } else if (evtName === "WARN") {
      const reason = parts[2] || "";
      if (reason === "S2_MISSED" || reason === "STUCK_RESET") {
        resetCycleState();
      }
      if (logEl) logEl.textContent += ` ⚠️ แจ้งเตือน: ${reason}`;
    }
    return;
  }

  const upper = clean.toUpperCase();
  if (upper === "1" || upper === "S1") { expectedSensor = 1; triggerSensor1(); }
  else if (upper === "2" || upper === "S2") { expectedSensor = 2; triggerSensor2(); }
  else if (upper === "3" || upper === "S3") { expectedSensor = 3; triggerSensor3(); }
}

const btnConnectArduino = document.getElementById("btnConnectArduino");
if (btnConnectArduino) {
  btnConnectArduino.addEventListener("click", async () => {
    if (!("serial" in navigator)) {
      alert("กรุณาเปิดหน้าเว็บด้วย Google Chrome หรือ Microsoft Edge ครับ");
      return;
    }

    try {
      serialPort = await navigator.serial.requestPort();
      await serialPort.open({ baudRate: 115200 });

      const encoder = new TextEncoder();
      const rawWriter = serialPort.writable.getWriter();
      serialWriter = {
        write: async (str) => {
          await rawWriter.write(encoder.encode(str));
        }
      };

      const badge = document.getElementById("arduinoStatusBadge");
      badge.textContent = "🟢 เชื่อมต่อ Arduino (115200)";
      badge.style.color = "var(--green)";
      btnConnectArduino.textContent = "🟢 เชื่อมต่อ USB อยู่";
      btnConnectArduino.disabled = true;

      const logEl = document.getElementById("arduinoSerialLog");
      if (logEl) logEl.textContent = "⏳ เปิดพอร์ตสำเร็จ กำลังรอข้อมูลจากบอร์ด...";

      const nextNum = Object.keys(state.parts).length + 1;
      await sendToArduino(`N,${nextNum}`);

      const decoder = new TextDecoder();
      const reader = serialPort.readable.getReader();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop();
          for (const line of lines) {
            handleArduinoSignal(line);
          }
        }
      }
    } catch (err) {
      console.error("Arduino Serial Error:", err);
      alert("เชื่อมต่อพอร์ตไม่ได้ (เช็กว่าปิด Serial Monitor ใน Arduino IDE แล้ว): " + err.message);
    }
  });
}

onValue(ref(db, "cnc_oee_project/arduino_trigger"), (snapshot) => {
  const payload = snapshot.val();
  if (isInitialTriggerLoad) {
    isInitialTriggerLoad = false;
    if (payload && typeof payload === "object" && payload.ts) {
      lastFirebaseTriggerTs = payload.ts;
    }
    return;
  }
  if (!payload) return;

  if (typeof payload === "object") {
    if (payload.ts && payload.ts === lastFirebaseTriggerTs) return;
    lastFirebaseTriggerTs = payload.ts || Date.now();
    if (payload.sensor) handleArduinoSignal(payload.sensor);
  } else {
    handleArduinoSignal(String(payload));
  }
});

// =========================================================
// 9. ระบบซิงค์ข้อมูล + ลิงก์รูปลง Google Sheets อัตโนมัติ
// =========================================================
let isSyncingSheet = false;
let pendingSheetSync = false;
let autoSyncTimer = null;

function updateAutoSheetBadge(text, isSuccess = false) {
  const badge = document.getElementById("autoSheetStatus");
  if (!badge) return;
  badge.textContent = text;
  badge.style.color = isSuccess ? "var(--green)" : "";
}

function scheduleAutoSyncToSheet(delayMs = 1500) {
  if (!state.settings.googleSheetUrl) return;
  clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(() => {
    syncToGoogleSheets(true);
  }, delayMs);
}

async function syncToGoogleSheets(isAuto = true) {
  const webhookUrl = (state.settings.googleSheetUrl || "").trim();
  if (!webhookUrl) {
    if (!isAuto) {
      alert("⚠️ กรุณานำ URL ของ Google Apps Script (/exec) ไปวางและกดบันทึกในหน้า '2. ตั้งค่ามาตรฐาน (Setting)' ก่อนครับ");
    }
    return;
  }

  if (isSyncingSheet) {
    pendingSheetSync = true;
    return;
  }

  isSyncingSheet = true;
  const btnManual = document.getElementById("btnExportGoogleSheet");
  if (btnManual) btnManual.disabled = true;
  updateAutoSheetBadge("⏳ กำลังซิงค์ลง Google Sheets...");

  const partsList = Object.values(state.parts);
  const totalParts = partsList.length;

  let sumQS1 = 0, sumQS2 = 0, sumActualT1 = 0, sumActualT2 = 0;
  partsList.forEach(p => {
    sumQS1 += getPartScoreS1(p);
    sumQS2 += getPartScoreS2(p);
    sumActualT1 += Number(p.t1 || 0);
    sumActualT2 += Number(p.t2 || 0);
  });

  const totalPlannedTime = state.machine.runSeconds + state.machine.setupSeconds + state.machine.breakdownSeconds;
  const availability = totalPlannedTime > 0 ? (state.machine.runSeconds / totalPlannedTime) : 0;
  const perfS1 = sumActualT1 > 0 ? Math.min(1, (state.settings.stdS1 * totalParts) / sumActualT1) : 0;
  const perfS2 = sumActualT2 > 0 ? Math.min(1, (state.settings.stdS2 * totalParts) / sumActualT2) : 0;
  const perfTotal = (sumActualT1 + sumActualT2) > 0
    ? Math.min(1, ((state.settings.stdS1 + state.settings.stdS2) * totalParts) / (sumActualT1 + sumActualT2))
    : 0;
  const qualityS1 = totalParts > 0 ? (sumQS1 / (totalParts * 100)) : 1;
  const qualityS2 = totalParts > 0 ? (sumQS2 / (totalParts * 100)) : 1;
  const qualityTotal = (qualityS1 + qualityS2) / 2;

  const payload = {
    settings: state.settings,
    machine: state.machine,
    metrics: {
      availability,
      perfS1,
      perfS2,
      perfTotal,
      qualityS1,
      qualityS2,
      qualityTotal,
      oeeS1: availability * perfS1 * qualityS1,
      oeeS2: availability * perfS2 * qualityS2,
      oeeTotal: availability * perfTotal * qualityTotal
    },
    parts: partsList
  };

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    if (result.status === "success") {
      if (result.imageLinks) {
        Object.entries(result.imageLinks).forEach(([partId, url]) => {
          if (url && state.parts[partId] && state.parts[partId].qImageUrl !== url) {
            update(ref(db, `cnc_oee_project/parts/${partId}`), { qImageUrl: url });
          }
        });
      }
      const nowTime = new Date().toLocaleTimeString("th-TH");
      updateAutoSheetBadge(`🟢 ซิงค์อัตโนมัติล่าสุด: ${nowTime}`, true);
      if (!isAuto) {
        alert("✅ ซิงค์ข้อมูลลง Google Sheets สำเร็จเรียบร้อยแล้ว!");
      }
    } else {
      updateAutoSheetBadge("⚠️ ซิงค์ไม่สำเร็จ (เช็ก Apps Script)");
      if (!isAuto) alert("❌ เกิดข้อผิดพลาด: " + (result.message || "ไม่ทราบสาเหตุ"));
    }
  } catch (err) {
    console.error("Auto Sync Google Sheets Error:", err);
    updateAutoSheetBadge("⚠️ เชื่อมต่อ Sheets ไม่ได้");
    if (!isAuto) alert("❌ ไม่สามารถเชื่อมต่อ Google Sheets ได้: " + err.message);
  } finally {
    isSyncingSheet = false;
    if (btnManual) btnManual.disabled = false;

    if (pendingSheetSync) {
      pendingSheetSync = false;
      scheduleAutoSyncToSheet(800);
    }
  }
}

const btnExportGoogleSheet = document.getElementById("btnExportGoogleSheet");
if (btnExportGoogleSheet) {
  btnExportGoogleSheet.addEventListener("click", () => syncToGoogleSheets(false));
}