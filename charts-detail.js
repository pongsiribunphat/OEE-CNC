import { getPartScoreS1, getPartScoreS2, formatBadge } from "./qc.js";

let activeModalStation = null;
let latestContext = {
  partsList: [],
  settings: { stdS1: 10, stdS2: 12 },
  metrics: {
    availability: 0,
    perfS1: 0,
    perfS2: 0,
    perfTotal: 0,
    qualityS1: 1,
    qualityS2: 1,
    qualityTotal: 1,
    oeeS1: 0,
    oeeS2: 0,
    oeeTotal: 0
  }
};

function getThemeColors() {
  const styles = getComputedStyle(document.documentElement);
  return {
    grid: styles.getPropertyValue("--chart-grid").trim() || "#334155",
    text: styles.getPropertyValue("--chart-text").trim() || "#94a3b8",
    label: styles.getPropertyValue("--chart-label").trim() || "#f8fafc"
  };
}

function setupCanvas(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const rect = canvas.parentElement.getBoundingClientRect();
  const width = Math.max(rect.width || 320, 240);
  const height = Math.max(rect.height || 220, 180);
  const dpr = window.devicePixelRatio || 1;

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function drawCompareBarChart(metrics) {
  const setup = setupCanvas("oeeCompareChart");
  if (!setup) return;
  const { ctx, width, height } = setup;
  const colors = getThemeColors();

  const pad = { top: 22, right: 14, bottom: 32, left: 38 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;

  ctx.strokeStyle = colors.grid;
  ctx.fillStyle = colors.text;
  ctx.font = "11px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  for (let i = 0; i <= 4; i++) {
    const val = i * 25;
    const y = pad.top + chartH - (val / 100) * chartH;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + chartW, y);
    ctx.stroke();
    ctx.fillText(`${val}%`, pad.left - 6, y);
  }

  const groups = ["Availability", "Performance", "Quality", "OEE รวม"];
  const series = [
    {
      color: "#22c55e",
      values: [
        metrics.availability * 100,
        metrics.perfTotal * 100,
        metrics.qualityTotal * 100,
        metrics.oeeTotal * 100
      ]
    },
    {
      color: "#0ea5e9",
      values: [
        metrics.availability * 100,
        metrics.perfS1 * 100,
        metrics.qualityS1 * 100,
        metrics.oeeS1 * 100
      ]
    },
    {
      color: "#f59e0b",
      values: [
        metrics.availability * 100,
        metrics.perfS2 * 100,
        metrics.qualityS2 * 100,
        metrics.oeeS2 * 100
      ]
    }
  ];

  const groupWidth = chartW / groups.length;
  const barWidth = Math.min(20, (groupWidth - 18) / 3);

  groups.forEach((label, gIdx) => {
    const groupCenter = pad.left + groupWidth * gIdx + groupWidth / 2;

    ctx.fillStyle = colors.label;
    ctx.font = "600 11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(label, groupCenter, pad.top + chartH + 10);

    series.forEach((s, sIdx) => {
      const val = Math.max(0, Math.min(100, s.values[gIdx] || 0));
      const barH = (val / 100) * chartH;
      const x = groupCenter - (barWidth * 1.5 + 3) + sIdx * (barWidth + 3);
      const y = pad.top + chartH - barH;

      ctx.fillStyle = s.color;
      ctx.fillRect(x, y, barWidth, barH);

      if (val > 0) {
        ctx.fillStyle = colors.label;
        ctx.font = "600 10px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(`${val.toFixed(0)}%`, x + barWidth / 2, y - 2);
      }
    });
  });
}

function drawTrendLineChart(partsList, settings, metrics) {
  const setup = setupCanvas("oeeTrendChart");
  if (!setup) return;
  const { ctx, width, height } = setup;
  const colors = getThemeColors();

  const pad = { top: 22, right: 18, bottom: 32, left: 38 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;

  ctx.strokeStyle = colors.grid;
  ctx.fillStyle = colors.text;
  ctx.font = "11px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  for (let i = 0; i <= 4; i++) {
    const val = i * 25;
    const y = pad.top + chartH - (val / 100) * chartH;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + chartW, y);
    ctx.stroke();
    ctx.fillText(`${val}%`, pad.left - 6, y);
  }

  if (partsList.length === 0) {
    ctx.fillStyle = colors.text;
    ctx.font = "13px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("ยังไม่มีข้อมูลชิ้นงาน (กดจำลองเซ็นเซอร์ 1 ➔ 2 ➔ 3)", pad.left + chartW / 2, pad.top + chartH / 2);
    return;
  }

  const labels = [];
  const totalArr = [];
  const s1Arr = [];
  const s2Arr = [];

  let cumT1 = 0;
  let cumT2 = 0;
  let cumQS1 = 0;
  let cumQS2 = 0;

  partsList.forEach((p, idx) => {
    const n = idx + 1;
    cumT1 += Number(p.t1 || 0);
    cumT2 += Number(p.t2 || 0);
    cumQS1 += getPartScoreS1(p);
    cumQS2 += getPartScoreS2(p);

    const p1 = cumT1 > 0 ? Math.min(1, (settings.stdS1 * n) / cumT1) : 0;
    const p2 = cumT2 > 0 ? Math.min(1, (settings.stdS2 * n) / cumT2) : 0;
    const pTot = (cumT1 + cumT2) > 0 ? Math.min(1, ((settings.stdS1 + settings.stdS2) * n) / (cumT1 + cumT2)) : 0;

    const q1Avg = cumQS1 / (n * 100);
    const q2Avg = cumQS2 / (n * 100);
    const qTotAvg = (q1Avg + q2Avg) / 2;

    labels.push(p.id);
    totalArr.push(metrics.availability * pTot * qTotAvg * 100);
    s1Arr.push(metrics.availability * p1 * q1Avg * 100);
    s2Arr.push(metrics.availability * p2 * q2Avg * 100);
  });

  const stepX = labels.length > 1 ? chartW / (labels.length - 1) : 0;
  const getX = (idx) => (labels.length === 1 ? pad.left + chartW / 2 : pad.left + idx * stepX);
  const getY = (val) => pad.top + chartH - (Math.max(0, Math.min(100, val)) / 100) * chartH;

  ctx.fillStyle = colors.label;
  ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  labels.forEach((lbl, idx) => {
    if (labels.length <= 10 || idx % Math.ceil(labels.length / 8) === 0 || idx === labels.length - 1) {
      ctx.fillText(lbl, getX(idx), pad.top + chartH + 10);
    }
  });

  const drawSeries = (arr, color, lineWidth) => {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = lineWidth;

    if (arr.length > 1) {
      ctx.beginPath();
      arr.forEach((v, idx) => {
        const x = getX(idx);
        const y = getY(v);
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    arr.forEach((v, idx) => {
      const x = getX(idx);
      const y = getY(v);
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    });
  };

  drawSeries(s1Arr, "#0ea5e9", 2);
  drawSeries(s2Arr, "#f59e0b", 2);
  drawSeries(totalArr, "#22c55e", 3);
}

function drawStationModalChart(partsList, isS1, stdTime) {
  const setup = setupCanvas("stationDetailChart");
  if (!setup) return;
  const { ctx, width, height } = setup;
  const colors = getThemeColors();

  const pad = { top: 20, right: 18, bottom: 30, left: 40 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;

  const times = partsList.map(p => Number(isS1 ? p.t1 : p.t2));
  const maxVal = Math.max(stdTime * 1.4, ...times, 10);

  ctx.strokeStyle = colors.grid;
  ctx.fillStyle = colors.text;
  ctx.font = "11px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  for (let i = 0; i <= 4; i++) {
    const val = (maxVal / 4) * i;
    const y = pad.top + chartH - (val / maxVal) * chartH;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + chartW, y);
    ctx.stroke();
    ctx.fillText(`${val.toFixed(0)}s`, pad.left - 6, y);
  }

  const stdY = pad.top + chartH - (stdTime / maxVal) * chartH;
  ctx.save();
  ctx.strokeStyle = "#ef4444";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(pad.left, stdY);
  ctx.lineTo(pad.left + chartW, stdY);
  ctx.stroke();
  ctx.restore();

  if (partsList.length === 0) {
    ctx.fillStyle = colors.text;
    ctx.font = "13px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("ยังไม่มีข้อมูลชิ้นงานในสถานีนี้", pad.left + chartW / 2, pad.top + chartH / 2);
    return;
  }

  const slotW = chartW / partsList.length;
  const barW = Math.min(34, slotW * 0.6);

  partsList.forEach((p, idx) => {
    const t = times[idx];
    const barH = (t / maxVal) * chartH;
    const x = pad.left + slotW * idx + (slotW - barW) / 2;
    const y = pad.top + chartH - barH;

    ctx.fillStyle = t <= stdTime ? "#0ea5e9" : "#f59e0b";
    ctx.fillRect(x, y, barW, barH);

    ctx.fillStyle = colors.label;
    ctx.font = "600 10px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(`${t.toFixed(1)}s`, x + barW / 2, y - 2);

    ctx.fillStyle = colors.label;
    ctx.textBaseline = "top";
    ctx.fillText(p.id, x + barW / 2, pad.top + chartH + 8);
  });
}

export function initChartsAndModal() {
  const modal = document.getElementById("stationDetailModal");
  const btnS1 = document.getElementById("btnDetailS1");
  const btnS2 = document.getElementById("btnDetailS2");
  const btnClose = document.getElementById("btnCloseModal");

  if (btnS1) {
    btnS1.addEventListener("click", () => {
      activeModalStation = 1;
      modal.classList.add("open");
      setTimeout(renderStationModal, 20);
    });
  }

  if (btnS2) {
    btnS2.addEventListener("click", () => {
      activeModalStation = 2;
      modal.classList.add("open");
      setTimeout(renderStationModal, 20);
    });
  }

  if (btnClose) {
    btnClose.addEventListener("click", () => {
      modal.classList.remove("open");
      activeModalStation = null;
    });
  }

  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        modal.classList.remove("open");
        activeModalStation = null;
      }
    });
  }

  window.addEventListener("resize", () => {
    drawCompareBarChart(latestContext.metrics);
    drawTrendLineChart(latestContext.partsList, latestContext.settings, latestContext.metrics);
    if (activeModalStation !== null) renderStationModal();
  });
}

export function updateDashboardCharts(partsList, settings, metrics) {
  latestContext = { partsList, settings, metrics };

  drawCompareBarChart(metrics);
  drawTrendLineChart(partsList, settings, metrics);

  if (activeModalStation !== null) {
    renderStationModal();
  }
}

function renderStationModal() {
  if (!activeModalStation) return;

  const isS1 = activeModalStation === 1;
  const { partsList, settings, metrics } = latestContext;
  const stdTime = isS1 ? settings.stdS1 : settings.stdS2;
  const oeeVal = isS1 ? metrics.oeeS1 : metrics.oeeS2;
  const perfVal = isS1 ? metrics.perfS1 : metrics.perfS2;

  document.getElementById("modalStationTitle").textContent = `รายละเอียดเจาะลึก: Station ${activeModalStation}`;
  document.getElementById("modalStationSubtitle").textContent = `เวลามาตรฐานที่ตั้งไว้: ${stdTime} วินาที / ชิ้น`;
  document.getElementById("modalChartTitle").textContent = `กราฟเวลาทำงานจริงของ Station ${activeModalStation} เทียบกับเวลามาตรฐาน (${stdTime} วิ)`;

  const times = partsList.map(p => Number(isS1 ? p.t1 : p.t2));
  const avgTime = times.length > 0 ? (times.reduce((a, b) => a + b, 0) / times.length) : 0;
  const minTime = times.length > 0 ? Math.min(...times) : 0;
  const maxTime = times.length > 0 ? Math.max(...times) : 0;

  document.getElementById("modalOeeVal").textContent = `${(oeeVal * 100).toFixed(1)}%`;
  document.getElementById("modalPerfVal").textContent = `${(perfVal * 100).toFixed(1)}%`;
  document.getElementById("modalAvgTime").textContent = `${avgTime.toFixed(2)} วิ`;
  document.getElementById("modalMinMaxTime").textContent = `${minTime.toFixed(1)} / ${maxTime.toFixed(1)} วิ`;

  drawStationModalChart(partsList, isS1, stdTime);

  const tbody = document.getElementById("modalPartsTableBody");
  if (partsList.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-cell">ยังไม่มีข้อมูลชิ้นงาน</td></tr>`;
  } else {
    tbody.innerHTML = partsList.slice().reverse().map(p => {
      const actual = Number(isS1 ? p.t1 : p.t2);

      let pieceA = metrics.availability;
      if (typeof p.cycleRunSec === "number") {
        const cTotal = p.cycleRunSec + Number(p.cycleSetupSec || 0) + Number(p.cycleBreakdownSec || 0);
        pieceA = cTotal > 0 ? (p.cycleRunSec / cTotal) : 1;
      }

      const pieceP = actual > 0 ? Math.min(1, stdTime / actual) : 0;
      const qScore = isS1 ? getPartScoreS1(p) : getPartScoreS2(p);
      const pieceQ = qScore / 100;
      const pieceOEE = pieceA * pieceP * pieceQ;

      const recordedTime = p.createdAt || "-";
      const qNote = (isS1 ? p.noteS1 : p.noteS2) || "ไม่เสียหาย (0 เส้น)";

      return `
        <tr>
          <td><strong>${p.id}</strong></td>
          <td>${recordedTime}</td>
          <td><strong>${actual.toFixed(2)} วิ</strong> <small style="color:var(--text-muted);">(เป้า ${stdTime}วิ)</small></td>
          <td>${(pieceA * 100).toFixed(1)}%</td>
          <td>${(pieceP * 100).toFixed(1)}%</td>
          <td>${formatBadge(qScore)}</td>
          <td><strong class="text-green">${(pieceOEE * 100).toFixed(1)}%</strong></td>
          <td>${qNote}</td>
        </tr>
      `;
    }).join("");
  }
}