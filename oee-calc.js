import { db, ref, set, update, onValue } from "./firebase-config.js";
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

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

async function sendToArduino(cmd) {
  if (!serialWriter) return;
  try {
    await serialWriter.write(`${cmd}\n`);
  } catch (err) {
    console.warn("Send to Arduino failed:", err);
  }
}

try {
  initQC();
} catch (err) {
  console.error("initQC error:", err);
}

try {
  initChartsAndModal();
} catch (err) {
  console.error("initChartsAndModal error:", err);
}

try {
  initManagerQC(() => calculateAndRender());
} catch (err) {
  console.error("initManagerQC error:", err);
}

if (window.OEE_UI) {
  window.OEE_UI.onRender = () => calculateAndRender();
}

// =========================================================
// 1. ระบบเชื่อมต่อ Firebase Realtime Database
// =========================================================
const statusEl = document.getElementById("firebaseStatus");
let isFirebaseConnected = false;

onValue(ref(db, ".info/connected"), (snap) => {
  isFirebaseConnected = snap.val() === true;
  if (!statusEl) return;
  if (isFirebaseConnected) {
    statusEl.textContent = "เชื่อมต่อสำเร็จ";
    statusEl.classList.add("online");
  } else {
    statusEl.textContent = "กำลังเชื่อมต่อใหม่...";
    statusEl.classList.remove("online");
  }
});

onValue(
  ref(db, "cnc_oee_project/settings"),
  (snapshot) => {
    isFirebaseConnected = true;
    if (statusEl) {
      statusEl.textContent = "เชื่อมต่อสำเร็จ";
      statusEl.classList.add("online");
    }

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

      if (window.OEE_UI) {
        window.OEE_UI.managerPin = state.settings.managerPin;
      }

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
    if (statusEl) {
      statusEl.textContent = `หลุดการเชื่อมต่อ (${err.code || "Error"})`;
      statusEl.classList.remove("online");
    }
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

// =========================================================
// 2. นาฬิกาหลักทำงานทุก 0.1 วินาที
// =========================================================
let tickCounter = 0;
setInterval(() => {
  const isPaused = state.machine.status === "PAUSED";

  if (!isPaused) {
    if (s1SegmentStart !== null) {
      const totalMs1 = s1AccumulatedMs + (Date.now() - s1SegmentStart);
      setText("liveTimerS1", `${(totalMs1 / 1000).toFixed(2)} วินาที`);
    }
    if (s2SegmentStart !== null) {
      const totalMs2 = s2AccumulatedMs + (Date.now() - s2SegmentStart);
      setText("liveTimerS2", `${(totalMs2 / 1000).toFixed(2)} วินาที`);
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

// =========================================================
// 3. ปุ่มควบคุมเครื่องจักร: Start / Stop / Pause
// =========================================================
const btnStartMachine = document.getElementById("btnStartMachine");
if (btnStartMachine) {
  btnStartMachine.addEventListener("click", () => {
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
}

const btnStopMachine = document.getElementById("btnStopMachine");
if (btnStopMachine) {
  btnStopMachine.addEventListener("click", () => {
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
}

const btnPauseSystem = document.getElementById("btnPauseSystem");
if (btnPauseSystem) {
  btnPauseSystem.addEventListener("click", () => {
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
}

// =========================================================
// 4. ฟังก์ชันทำงานอัตโนมัติเมื่อรับสัญญาณ Sensor 1 -> 2 -> 3
// =========================================================
function updateSimulatorButtons() {
  const btnS1 = document.getElementById("btnSimSensor1");
  const btnS2 = document.getElementById("btnSimSensor2");
  const btnS3 = document.getElementById("btnSimSensor3");
  const btnResetCyc = document.getElementById("btnSimResetCycle");
  if (!btnS1 || !btnS2 || !btnS3) return;

  const isPausedOrStopped = state.machine.status === "PAUSED" || state.machine.manualStop;

  btnS1.classList.remove("sim-step-ready");
  btnS2.classList.remove("sim-step-ready");
  btnS3.classList.remove("sim-step-ready");

  if (isPausedOrStopped) {
    btnS1.disabled = true;
    btnS2.disabled = true;
    btnS3.disabled = true;
    if (btnResetCyc) btnResetCyc.disabled = (expectedSensor === 1);
    return;
  }

  btnS1.disabled = expectedSensor !== 1;
  btnS2.disabled = expectedSensor !== 2;
  btnS3.disabled = expectedSensor !== 3;
  if (btnResetCyc) btnResetCyc.disabled = (expectedSensor === 1);

  if (expectedSensor === 1) btnS1.classList.add("sim-step-ready");
  else if (expectedSensor === 2) btnS2.classList.add("sim-step-ready");
  else if (expectedSensor === 3) btnS3.classList.add("sim-step-ready");
}

function triggerSensor1() {
  if (expectedSensor !== 1) return;

  s1AccumulatedMs = 0;
  s1SegmentStart = Date.now();
  currentCycleInterrupted = false;
  expectedSensor = 2;
  updateSimulatorButtons();

  setText("statusTimerS1", "กำลังจับเวลา Station 1...");

  if (window.DigitalTwinCNC) {
    window.DigitalTwinCNC.onStation1Start();
  }

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

  setText("liveTimerS1", `${recordedT1.toFixed(2)} วินาที`);
  setText("statusTimerS1", `เสร็จสิ้น Station 1 (ใช้เวลา ${recordedT1} วิ)`);

  s2AccumulatedMs = 0;
  s2SegmentStart = Date.now();
  expectedSensor = 3;
  updateSimulatorButtons();
  setText("statusTimerS2", "กำลังจับเวลา Station 2...");

  if (window.DigitalTwinCNC) {
    window.DigitalTwinCNC.onSensor2Enter();
  }
}

function triggerSensor3(exactT1 = null, exactT2 = null) {
  if (expectedSensor !== 3) return;

  if (exactT1 !== null && !isNaN(exactT1)) {
    recordedT1 = Number(exactT1.toFixed(2));
    setText("liveTimerS1", `${recordedT1.toFixed(2)} วินาที`);
  }

  const totalMs2 = s2AccumulatedMs + (s2SegmentStart ? (Date.now() - s2SegmentStart) : 0);
  const recordedT2 = (exactT2 !== null && !isNaN(exactT2))
    ? Number(exactT2.toFixed(2))
    : Number((totalMs2 / 1000).toFixed(2));
  s2AccumulatedMs = 0;
  s2SegmentStart = null;
  expectedSensor = 1;
  updateSimulatorButtons();

  setText("liveTimerS2", `${recordedT2.toFixed(2)} วินาที`);
  setText("statusTimerS2", `เสร็จสิ้น Station 2 (ใช้เวลา ${recordedT2} วิ)`);

  if (window.DigitalTwinCNC) {
    window.DigitalTwinCNC.onCycleDone();
  }

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
  updateSimulatorButtons();
  setText("liveTimerS1", "0.00 วินาที");
  setText("liveTimerS2", "0.00 วินาที");
  setText("statusTimerS1", "รอวัตถุออกจาก Sensor 1...");
  setText("statusTimerS2", "รอวัตถุออกจาก Sensor 2...");
  if (window.DigitalTwinCNC) {
    window.DigitalTwinCNC.reset();
  }
}

// ผูกเหตุการณ์ปุ่มกดจำลองเซ็นเซอร์ 1 -> 2 -> 3
const btnSimSensor1 = document.getElementById("btnSimSensor1");
const btnSimSensor2 = document.getElementById("btnSimSensor2");
const btnSimSensor3 = document.getElementById("btnSimSensor3");
const btnSimResetCycle = document.getElementById("btnSimResetCycle");

if (btnSimSensor1) {
  btnSimSensor1.addEventListener("click", () => {
    if (state.machine.status === "PAUSED" || state.machine.manualStop) return;
    triggerSensor1();
    setText("arduinoSerialLog", "🧪 [โหมดจำลอง] กด Sensor 1 ➔ เริ่มจับเวลา Station 1... (กด Sensor 2 เมื่อพร้อมส่งต่อ)");
  });
}

if (btnSimSensor2) {
  btnSimSensor2.addEventListener("click", () => {
    if (state.machine.status === "PAUSED" || state.machine.manualStop) return;
    triggerSensor2();
    setText("arduinoSerialLog", `🧪 [โหมดจำลอง] กด Sensor 2 ➔ จบ S1 (${recordedT1.toFixed(2)} วิ) และเริ่มจับเวลา Station 2...`);
  });
}

if (btnSimSensor3) {
  btnSimSensor3.addEventListener("click", () => {
    if (state.machine.status === "PAUSED" || state.machine.manualStop) return;
    triggerSensor3();
    setText("arduinoSerialLog", "🧪 [โหมดจำลอง] กด Sensor 3 ➔ จบงานและบันทึกชิ้นงานลงฐานข้อมูลสำเร็จ!");
  });
}

if (btnSimResetCycle) {
  btnSimResetCycle.addEventListener("click", () => {
    resetCycleState();
    setText("arduinoSerialLog", "↺ รีเซ็ตรอบปัจจุบันเรียบร้อย พร้อมเริ่มกด Sensor 1 ใหม่ครับ");
  });
}

// =========================================================
// 5. หน้า Setting (ผู้จัดการ)
// =========================================================
const btnSaveSettings = document.getElementById("btnSaveSettings");
if (btnSaveSettings) {
  btnSaveSettings.addEventListener("click", () => {
    const std1 = Number(document.getElementById("inputStdS1")?.value);
    const lsl1 = Number(document.getElementById("inputLslS1")?.value);
    const usl1 = Number(document.getElementById("inputUslS1")?.value);
    const std2 = Number(document.getElementById("inputStdS2")?.value);
    const lsl2 = Number(document.getElementById("inputLslS2")?.value);
    const usl2 = Number(document.getElementById("inputUslS2")?.value);
    const setupT = Number(document.getElementById("inputSetupTime")?.value);
    const breakdownT = Number(document.getElementById("inputBreakdownTime")?.value);
    const newPin = (document.getElementById("inputManagerPin")?.value || "").trim();
    const sheetUrl = (document.getElementById("inputSheetWebhook")?.value || "").trim();

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
}

const btnResetAllData = document.getElementById("btnResetAllData");
if (btnResetAllData) {
  btnResetAllData.addEventListener("click", () => {
    if (!confirm("ยืนยันการล้างข้อมูลเวลาและชิ้นงานทั้งหมดใช่ไหมครับ?")) return;
    resetCycleState();
    currentCycleInterrupted = false;
    cycleRunSec = 0;
    cycleSetupSec = 0;
    cycleBreakdownSec = 0;
    resetQCSelection();
    sendToArduino("N,1");

    setText("arduinoSerialLog", "สถานะเซ็นเซอร์: กดปุ่ม '▶ เดินเครื่อง (Start)' ด้านบน แล้วกดปุ่มจำลอง Sensor 1 ➔ 2 ➔ 3 เพื่อทดสอบได้ทันทีครับ");

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
}

// =========================================================
// 6. คำนวณสูตร OEE และอัปเดตหน้าจอทั้งหมด
// =========================================================
function calculateAndRender() {
  const lampGreen = document.getElementById("lampGreen");
  const lampYellow = document.getElementById("lampYellow");
  const lampRed = document.getElementById("lampRed");

  if (lampGreen) lampGreen.classList.remove("active");
  if (lampYellow) lampYellow.classList.remove("active");
  if (lampRed) lampRed.classList.remove("active");

  const st = state.machine.status;

  if (st === "RUNNING") {
    if (lampGreen) lampGreen.classList.add("active");
    setText("machineStateText", "สถานะ: กำลังเดินเครื่อง (RUNNING)");
    if (btnStartMachine) btnStartMachine.disabled = true;
    if (btnStopMachine) btnStopMachine.disabled = false;
    if (btnPauseSystem) btnPauseSystem.disabled = false;
  } else if (st === "SETUP") {
    if (lampYellow) lampYellow.classList.add("active");
    setText("machineStateText", "สถานะ: กำลังตั้งค่า / รอชิ้นงาน (SETUP)");
    if (btnStartMachine) btnStartMachine.disabled = true;
    if (btnStopMachine) btnStopMachine.disabled = false;
    if (btnPauseSystem) btnPauseSystem.disabled = false;
  } else if (st === "BREAKDOWN") {
    if (lampRed) lampRed.classList.add("active");
    setText(
      "machineStateText",
      state.machine.manualStop
        ? "สถานะ: เครื่องหยุดทำงาน (กดหยุดเอง - BREAKDOWN)"
        : "สถานะ: เครื่องขัดข้อง / รอนานเกินกำหนด (BREAKDOWN)"
    );
    if (btnStartMachine) btnStartMachine.disabled = !state.machine.manualStop;
    if (btnStopMachine) btnStopMachine.disabled = state.machine.manualStop;
    if (btnPauseSystem) btnPauseSystem.disabled = false;
  } else {
    setText(
      "machineStateText",
      state.machine.hasStarted
        ? "สถานะ: หยุดระบบชั่วคราว (ไม่นับเวลา / ไม่ลด OEE)"
        : "สถานะ: หยุดระบบ (พร้อมเริ่มงาน)"
    );
    if (btnStartMachine) btnStartMachine.disabled = false;
    if (btnStopMachine) btnStopMachine.disabled = !state.machine.hasStarted;
    if (btnPauseSystem) btnPauseSystem.disabled = true;
  }

  updateSimulatorButtons();

  setText("displayRunTime", state.machine.runSeconds);
  setText("displaySetupTime", state.machine.setupSeconds);
  setText("displayBreakdownTime", state.machine.breakdownSeconds);

  setText("displayNormalParts", state.machine.normalPartsCount);
  setText("displaySetupCount", state.machine.setupCount);
  setText("displayBreakdownCount", state.machine.breakdownCount);

  const isProcessingPart = (s1SegmentStart !== null || s2SegmentStart !== null);
  const idleText = isProcessingPart
    ? "กำลังผลิตชิ้นงานอยู่ในสถานี (นับเวลา Run เข้า OEE)..."
    : `รอชิ้นงานออก S1: ${state.machine.idleSeconds} วิ (ยังไม่นับ OEE | Setup > ${state.settings.setupThreshold} วิ / Breakdown > ${state.settings.breakdownThreshold} วิ)`;
  setText("idleMonitorText", idleText);

  setText("stdTimeLabel1", `มาตรฐาน: ${state.settings.stdS1} วิ`);
  setText("stdTimeLabel2", `มาตรฐาน: ${state.settings.stdS2} วิ`);

  const activeId = document.activeElement?.id || "";
  const syncInputVal = (id, val) => {
    const el = document.getElementById(id);
    if (el && activeId !== id) el.value = val;
  };
  syncInputVal("inputStdS1", state.settings.stdS1);
  syncInputVal("inputLslS1", state.settings.lslS1);
  syncInputVal("inputUslS1", state.settings.uslS1);
  syncInputVal("inputStdS2", state.settings.stdS2);
  syncInputVal("inputLslS2", state.settings.lslS2);
  syncInputVal("inputUslS2", state.settings.uslS2);
  syncInputVal("inputSetupTime", state.settings.setupThreshold);
  syncInputVal("inputBreakdownTime", state.settings.breakdownThreshold);
  syncInputVal("inputManagerPin", state.settings.managerPin);
  syncInputVal("inputSheetWebhook", state.settings.googleSheetUrl || "");

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

  setText("displayTotalParts", totalParts);

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

  setText("goodPartsSummary", `Q1: ${(qualityS1 * 100).toFixed(0)}% | Q2: ${(qualityS2 * 100).toFixed(0)}%`);

  const oeeS1 = availability * perfS1 * qualityS1;
  const oeeS2 = availability * perfS2 * qualityS2;
  const oeeTotal = availability * perfTotal * qualityTotal;

  setText("aS1", `${(availability * 100).toFixed(1)}%`);
  setText("pS1", `${(perfS1 * 100).toFixed(1)}%`);
  setText("qS1", `${(qualityS1 * 100).toFixed(1)}%`);
  setText("oeeS1", `${(oeeS1 * 100).toFixed(1)}%`);

  setText("aS2", `${(availability * 100).toFixed(1)}%`);
  setText("pS2", `${(perfS2 * 100).toFixed(1)}%`);
  setText("qS2", `${(qualityS2 * 100).toFixed(1)}%`);
  setText("oeeS2", `${(oeeS2 * 100).toFixed(1)}%`);

  setText("aTotal", `${(availability * 100).toFixed(1)}%`);
  setText("pTotal", `${(perfTotal * 100).toFixed(1)}%`);
  setText("qTotal", `${(qualityTotal * 100).toFixed(1)}%`);
  setText("oeeTotal", `${(oeeTotal * 100).toFixed(1)}%`);

  const tbody = document.getElementById("partsTableBody");
  if (tbody) {
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
  }

  try {
    renderQC(state.parts, partsList, qualityS1, qualityS2, qualityTotal, counts);
  } catch (err) {
    console.error("renderQC error:", err);
  }

  try {
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
  } catch (err) {
    console.error("updateDashboardCharts error:", err);
  }

  try {
    renderManagerQC(partsList, state.settings);
  } catch (err) {
    console.error("renderManagerQC error:", err);
  }
}

let resizeDebounceTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeDebounceTimer);
  resizeDebounceTimer = setTimeout(() => {
    calculateAndRender();
  }, 150);
});

// =========================================================
// 7. ระบบเชื่อมต่อบอร์ด Arduino (Baud 115200 | โปรโตคอล EVT,...)
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
      if (window.DigitalTwinCNC) window.DigitalTwinCNC.onSensor1Enter();
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
      if (badge) {
        badge.textContent = "🟢 เชื่อมต่อ Arduino (115200)";
        badge.style.color = "var(--green)";
      }
      btnConnectArduino.textContent = "🟢 เชื่อมต่อ USB อยู่";
      btnConnectArduino.disabled = true;

      setText("arduinoSerialLog", "⏳ เปิดพอร์ตสำเร็จ กำลังรอข้อมูลจากบอร์ด...");

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
// 8. ระบบซิงค์ข้อมูล + ลิงก์รูปลง Google Sheets อัตโนมัติ
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