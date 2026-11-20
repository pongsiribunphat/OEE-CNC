// =========================================================
// โมดูล QC Control Chart (I-MR Chart) & Process Capability (Cp, Cpk)
// =========================================================

let activeQcStation = "S1"; // "S1" | "S2" | "TOTAL"

export function initManagerQC(onStationChange) {
  const buttons = document.querySelectorAll("[data-qc-station]");
  buttons.forEach(btn => {
    btn.addEventListener("click", () => {
      buttons.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      activeQcStation = btn.dataset.qcStation;
      if (typeof onStationChange === "function") onStationChange();
    });
  });
}

export function renderManagerQC(partsList, settings) {
  const stationTitleEl = document.getElementById("mgrQcChartTitle");
  const specBadgeEl = document.getElementById("mgrQcSpecBadge");
  if (!stationTitleEl) return;

  // 1. ดึงข้อมูลเวลา (x) และค่า USL / LSL ตาม Station ที่เลือก
  let values = [];
  let labels = [];
  let usl = 12;
  let lsl = 8;
  let stationLabel = "Station 1";

  const lsl1 = Number(settings.lslS1 ?? 8);
  const usl1 = Number(settings.uslS1 ?? 12);
  const lsl2 = Number(settings.lslS2 ?? 10);
  const usl2 = Number(settings.uslS2 ?? 14);

  if (activeQcStation === "S1") {
    stationLabel = "Station 1";
    lsl = lsl1;
    usl = usl1;
    values = partsList.map(p => Number(p.t1 || 0));
  } else if (activeQcStation === "S2") {
    stationLabel = "Station 2";
    lsl = lsl2;
    usl = usl2;
    values = partsList.map(p => Number(p.t2 || 0));
  } else {
    stationLabel = "รวมทั้งสายการผลิต (S1 + S2)";
    lsl = Number((lsl1 + lsl2).toFixed(2));
    usl = Number((usl1 + usl2).toFixed(2));
    values = partsList.map(p => Number(p.t1 || 0) + Number(p.t2 || 0));
  }
  labels = partsList.map(p => p.id);

  stationTitleEl.textContent = `I-Chart (Individual Control Chart): เวลาผลิต ${stationLabel}`;
  specBadgeEl.textContent = `สเปกที่ตั้งไว้: LSL = ${lsl} วิ | USL = ${usl} วิ`;

  // 2. คำนวณค่าทางสถิติ SPC สำหรับ I-MR Chart (d2 = 1.128, D4 = 3.267)
  const n = values.length;
  let cl = 0, mrBar = 0, sigma = 0, ucl = 0, lcl = 0, uclMr = 0;
  let cp = 0, cpk = 0, outOfSpecCount = 0, outOfControlCount = 0;
  const movingRanges = [null]; // ชิ้นแรกไม่มี MR

  if (n > 0) {
    cl = values.reduce((a, b) => a + b, 0) / n;
    for (let i = 1; i < n; i++) {
      movingRanges.push(Math.abs(values[i] - values[i - 1]));
    }
    if (n >= 2) {
      const validMrs = movingRanges.slice(1);
      mrBar = validMrs.reduce((a, b) => a + b, 0) / validMrs.length;
      sigma = mrBar / 1.128; // ค่าคงที่ d2 สำหรับ n=2
      ucl = cl + 3 * sigma;
      lcl = Math.max(0, cl - 3 * sigma);
      uclMr = 3.267 * mrBar; // ค่าคงที่ D4 สำหรับ n=2
    } else {
      ucl = usl;
      lcl = lsl;
    }

    if (sigma > 0) {
      cp = (usl - lsl) / (6 * sigma);
      const cpu = (usl - cl) / (3 * sigma);
      const cpl = (cl - lsl) / (3 * sigma);
      cpk = Math.min(cpu, cpl);
    }

    values.forEach(v => {
      if (v > usl || v < lsl) outOfSpecCount++;
      if (n >= 2 && (v > ucl || v < lcl)) outOfControlCount++;
    });
  }

  // 3. อัปเดตการ์ดตัวเลข KPI ทั้งหมด
  document.getElementById("qcStatCL").textContent = n > 0 ? `${cl.toFixed(2)} วิ` : "-";
  document.getElementById("qcStatUCL").textContent = n >= 2 ? `${ucl.toFixed(2)} วิ` : "-";
  document.getElementById("qcStatLCL").textContent = n >= 2 ? `${lcl.toFixed(2)} วิ` : "-";
  document.getElementById("qcStatUSL").textContent = `${usl.toFixed(2)} วิ`;
  document.getElementById("qcStatLSL").textContent = `${lsl.toFixed(2)} วิ`;

  document.getElementById("qcStatCp").textContent = (n >= 2 && sigma > 0) ? cp.toFixed(2) : "-";
  const cpkEl = document.getElementById("qcStatCpk");
  if (n >= 2 && sigma > 0) {
    cpkEl.textContent = cpk.toFixed(2);
    cpkEl.className = cpk >= 1.33 ? "text-green" : (cpk >= 1.0 ? "text-amber" : "text-red");
  } else {
    cpkEl.textContent = "-";
    cpkEl.className = "";
  }

  document.getElementById("qcStatMrBar").textContent = n >= 2 ? `${mrBar.toFixed(2)} วิ` : "-";
  document.getElementById("qcStatUclMr").textContent = n >= 2 ? `${uclMr.toFixed(2)} วิ` : "-";
  document.getElementById("qcStatOutCount").textContent =
    `หลุดสเปก (USL/LSL): ${outOfSpecCount} ชิ้น | หลุดควบคุม (UCL/LCL): ${outOfControlCount} ชิ้น`;

  // 4. วาดกราฟ I-Chart และ MR-Chart
  drawIChart("mgrIChartCanvas", labels, values, { cl, ucl, lcl, usl, lsl, hasControlLimits: n >= 2 });
  drawMRChart("mgrMRChartCanvas", labels, movingRanges, { mrBar, uclMr, hasData: n >= 2 });

  // 5. อัปเดตตารางสรุปรายชิ้น
  const tbody = document.getElementById("mgrQcTableBody");
  if (n === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-cell">ยังไม่มีข้อมูลชิ้นงานสำหรับสร้าง Control Chart</td></tr>`;
    return;
  }

  tbody.innerHTML = partsList.slice().reverse().map((p, revIdx) => {
    const origIdx = n - 1 - revIdx;
    const val = values[origIdx];
    const mr = movingRanges[origIdx];

    const isOutSpec = val > usl || val < lsl;
    const isOutCtrl = n >= 2 && (val > ucl || val < lcl);

    let statusBadge = `<span class="badge badge-100">ปกติ (In-Control)</span>`;
    if (isOutSpec) {
      statusBadge = `<span class="badge badge-0">⚠️ หลุดสเปก (Out of Spec)</span>`;
    } else if (isOutCtrl) {
      statusBadge = `<span class="badge badge-25">⚡ หลุดขอบเขตควบคุม (UCL/LCL)</span>`;
    }

    return `
      <tr>
        <td><strong>${p.id}</strong></td>
        <td>${p.createdAt || "-"}</td>
        <td><strong>${val.toFixed(2)} วิ</strong></td>
        <td>${mr !== null ? mr.toFixed(2) + " วิ" : "-"}</td>
        <td>${lsl.toFixed(1)} - ${usl.toFixed(1)} วิ</td>
        <td>${n >= 2 ? lcl.toFixed(2) + " - " + ucl.toFixed(2) + " วิ" : "-"}</td>
        <td>${statusBadge}</td>
      </tr>
    `;
  }).join("");
}

// =========================================================
// ฟังก์ชันวาดกราฟ I-Chart (แสดง CL, UCL, LCL, USL, LSL ครบในกราฟเดียว)
// =========================================================
function drawIChart(canvasId, labels, values, limits) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const W = rect.width;
  const H = rect.height;
  const isLight = document.documentElement.getAttribute("data-theme") === "light";
  const textColor = isLight ? "#475569" : "#94a3b8";
  const gridColor = isLight ? "rgba(15,23,42,0.08)" : "rgba(148,163,184,0.12)";

  ctx.clearRect(0, 0, W, H);

  if (values.length === 0) {
    ctx.fillStyle = textColor;
    ctx.font = "14px 'Noto Sans Thai', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("รอข้อมูลชิ้นงานอย่างน้อย 1 ชิ้นเพื่อแสดง I-Chart", W / 2, H / 2);
    return;
  }

  const pad = { top: 24, right: 86, bottom: 32, left: 52 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const allCandidates = [...values, limits.usl, limits.lsl, limits.cl];
  if (limits.hasControlLimits) {
    allCandidates.push(limits.ucl, limits.lcl);
  }
  const rawMin = Math.min(...allCandidates);
  const rawMax = Math.max(...allCandidates);
  const margin = Math.max((rawMax - rawMin) * 0.15, 1);
  const yMin = Math.max(0, rawMin - margin);
  const yMax = rawMax + margin;

  const getX = (i) => values.length === 1
    ? pad.left + plotW / 2
    : pad.left + (i / (values.length - 1)) * plotW;
  const getY = (v) => pad.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // เส้นตารางแกน Y
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  ctx.font = "11px 'Plus Jakarta Sans', sans-serif";
  ctx.fillStyle = textColor;
  ctx.textAlign = "right";

  for (let s = 0; s <= 4; s++) {
    const val = yMin + (s / 4) * (yMax - yMin);
    const y = getY(val);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
    ctx.fillText(val.toFixed(1), pad.left - 8, y + 4);
  }

  // ฟังก์ชันวาดเส้นแนวนอน (USL, LSL, UCL, LCL, CL)
  const drawLimitLine = (val, color, label, dashed = []) => {
    const y = getY(val);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.setLineDash(dashed);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = color;
    ctx.font = "bold 11px 'Plus Jakarta Sans', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`${label} (${val.toFixed(1)})`, pad.left + plotW + 6, y + 4);
  };

  // วาดเส้นสเปก USL / LSL (เส้นประสีแดง)
  drawLimitLine(limits.usl, "#ef4444", "USL", [6, 4]);
  drawLimitLine(limits.lsl, "#ef4444", "LSL", [6, 4]);

  // วาดเส้นควบคุม UCL / LCL (เส้นประสีส้ม) เมื่อมีข้อมูล >= 2 ชิ้น
  if (limits.hasControlLimits) {
    drawLimitLine(limits.ucl, "#f59e0b", "UCL", [3, 3]);
    drawLimitLine(limits.lsl === limits.lcl ? limits.lcl : limits.lcl, "#f59e0b", "LCL", [3, 3]);
  }

  // วาดเส้นค่าเฉลี่ย CL (เส้นทึบสีเขียว)
  drawLimitLine(limits.cl, "#22c55e", "CL", []);

  // วาดเส้นกราฟเชื่อมต่อข้อมูลรายชิ้น
  ctx.strokeStyle = "#0ea5e9";
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = getX(i);
    const y = getY(v);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // วาดจุดข้อมูล + ป้ายชื่อแกน X
  values.forEach((v, i) => {
    const x = getX(i);
    const y = getY(v);
    const isOut = (v > limits.usl || v < limits.lsl) ||
                  (limits.hasControlLimits && (v > limits.ucl || v < limits.lcl));

    ctx.beginPath();
    ctx.arc(x, y, isOut ? 5.5 : 4, 0, Math.PI * 2);
    ctx.fillStyle = isOut ? "#ef4444" : "#0ea5e9";
    ctx.fill();
    ctx.strokeStyle = isLight ? "#ffffff" : "#0f172a";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // ป้ายแกน X (แสดงไม่ให้ซ้อนกันเมื่อชิ้นงานเยอะ)
    const step = Math.ceil(values.length / 12);
    if (i % step === 0 || i === values.length - 1) {
      ctx.fillStyle = textColor;
      ctx.font = "11px 'Plus Jakarta Sans', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(labels[i], x, H - 10);
    }
  });
}

// =========================================================
// ฟังก์ชันวาดกราฟ MR-Chart (Moving Range)
// =========================================================
function drawMRChart(canvasId, labels, movingRanges, limits) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const W = rect.width;
  const H = rect.height;
  const isLight = document.documentElement.getAttribute("data-theme") === "light";
  const textColor = isLight ? "#475569" : "#94a3b8";
  const gridColor = isLight ? "rgba(15,23,42,0.08)" : "rgba(148,163,184,0.12)";

  ctx.clearRect(0, 0, W, H);

  if (!limits.hasData) {
    ctx.fillStyle = textColor;
    ctx.font = "14px 'Noto Sans Thai', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("ต้องมีชิ้นงานอย่างน้อย 2 ชิ้นขึ้นไปเพื่อคำนวณ Moving Range (MR-Chart)", W / 2, H / 2);
    return;
  }

  const pad = { top: 22, right: 86, bottom: 30, left: 52 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const validMrs = movingRanges.slice(1);
  const yMax = Math.max(...validMrs, limits.uclMr, 0.5) * 1.15;
  const getX = (i) => pad.left + (i / (labels.length - 1)) * plotW;
  const getY = (v) => pad.top + plotH - (v / yMax) * plotH;

  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  ctx.font = "11px 'Plus Jakarta Sans', sans-serif";
  ctx.fillStyle = textColor;
  ctx.textAlign = "right";

  for (let s = 0; s <= 3; s++) {
    const val = (s / 3) * yMax;
    const y = getY(val);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
    ctx.fillText(val.toFixed(1), pad.left - 8, y + 4);
  }

  // เส้น UCL_MR และ CL_MR
  const drawLine = (val, color, label, dashed = []) => {
    const y = getY(val);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(dashed);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = color;
    ctx.font = "bold 11px 'Plus Jakarta Sans', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`${label} (${val.toFixed(1)})`, pad.left + plotW + 6, y + 4);
  };

  drawLine(limits.uclMr, "#f59e0b", "UCL", [4, 4]);
  drawLine(limits.mrBar, "#22c55e", "MR̄", []);

  // เส้นกราฟ MR
  ctx.strokeStyle = "#a855f7";
  ctx.lineWidth = 2;
  ctx.beginPath();
  movingRanges.forEach((mr, i) => {
    if (mr === null) return;
    const x = getX(i);
    const y = getY(mr);
    if (i === 1) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  movingRanges.forEach((mr, i) => {
    if (mr === null) return;
    const x = getX(i);
    const y = getY(mr);
    const isOut = mr > limits.uclMr;

    ctx.beginPath();
    ctx.arc(x, y, isOut ? 5 : 3.8, 0, Math.PI * 2);
    ctx.fillStyle = isOut ? "#ef4444" : "#a855f7";
    ctx.fill();

    const step = Math.ceil(labels.length / 12);
    if (i % step === 0 || i === labels.length - 1) {
      ctx.fillStyle = textColor;
      ctx.font = "11px 'Plus Jakarta Sans', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(labels[i], x, H - 10);
    }
  });
}