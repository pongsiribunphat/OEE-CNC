import { db, ref, update } from "./firebase-config.js";

let selectedScoreS1 = 100;
let selectedLabelS1 = "ไม่เสียหาย (0 เส้น)";
let selectedScoreS2 = 100;
let selectedLabelS2 = "ไม่เสียหาย (0 เส้น)";
let currentImageBase64 = "";
let cachedPartsMap = {};

export function getPartScoreS1(part) {
  if (typeof part.qScoreS1 === "number") return part.qScoreS1;
  if (typeof part.qScore === "number") return part.qScore;
  return part.quality === "NG" ? 0 : 100;
}

export function getPartScoreS2(part) {
  if (typeof part.qScoreS2 === "number") return part.qScoreS2;
  if (typeof part.qScore === "number") return part.qScore;
  return part.quality === "NG" ? 0 : 100;
}

export function getPartScore(part) {
  return (getPartScoreS1(part) + getPartScoreS2(part)) / 2;
}

export function formatBadge(score) {
  if (score === 100) return `<span class="badge badge-100">100% (0 เส้น)</span>`;
  if (score === 75)  return `<span class="badge badge-75">75% (1 เส้น)</span>`;
  if (score === 50)  return `<span class="badge badge-50">50% (2 เส้น)</span>`;
  if (score === 25)  return `<span class="badge badge-25">25% (3 เส้น)</span>`;
  return `<span class="badge badge-0">0% (4 เส้น)</span>`;
}

function updateStationBadgeUI(stationNum, score) {
  const badgeEl = document.getElementById(stationNum === 1 ? "badgeSelectedS1" : "badgeSelectedS2");
  if (badgeEl) {
    badgeEl.outerHTML = formatBadge(score).replace(
      `<span class="badge`,
      `<span id="${stationNum === 1 ? "badgeSelectedS1" : "badgeSelectedS2"}" class="badge`
    );
  }
}

function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const maxSide = 800;
        let width = img.width;
        let height = img.height;

        if (width > maxSide || height > maxSide) {
          if (width > height) {
            height = Math.round((height * maxSide) / width);
            width = maxSide;
          } else {
            width = Math.round((width * maxSide) / height);
            height = maxSide;
          }
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);

        const dataUrl = canvas.toDataURL("image/jpeg", 0.68);
        resolve(dataUrl);
      };
      img.onerror = () => reject(new Error("ไม่สามารถอ่านไฟล์รูปภาพได้"));
      img.src = event.target.result;
    };
    reader.onerror = () => reject(new Error("เกิดข้อผิดพลาดในการโหลดไฟล์"));
    reader.readAsDataURL(file);
  });
}

function setPreviewImage(dataUrl, statusText = "✓ แนบรูปหลักฐานเรียบร้อย") {
  const wrap = document.getElementById("qcImagePreviewWrap");
  const img = document.getElementById("qcImagePreview");
  const statusEl = document.getElementById("qcImageStatus");
  const uploadZone = document.getElementById("qcUploadZone");

  if (dataUrl) {
    currentImageBase64 = dataUrl;
    img.src = dataUrl;
    statusEl.textContent = statusText;
    wrap.style.display = "block";
    uploadZone.style.display = "none";
  } else {
    currentImageBase64 = "";
    img.src = "";
    wrap.style.display = "none";
    uploadZone.style.display = "flex";
    const fileInput = document.getElementById("qcImageInput");
    if (fileInput) fileInput.value = "";
  }
}

export function openEvidenceModal(partId) {
  const part = cachedPartsMap[partId];
  if (!part || !part.qImage) {
    alert("ชิ้นงานนี้ยังไม่มีรูปภาพหลักฐานแนบไว้ครับ");
    return;
  }
  const s1 = getPartScoreS1(part);
  const s2 = getPartScoreS2(part);
  const modal = document.getElementById("qcImageModal");
  document.getElementById("qcModalTitle").textContent = `หลักฐานรูปภาพ: ชิ้นงาน ${part.id}`;
  document.getElementById("qcModalCaption").textContent =
    `Station 1: ${s1}% | Station 2: ${s2}% | บันทึกเวลา: ${part.qUpdatedAt || part.createdAt || "-"}`;
  document.getElementById("qcModalImg").src = part.qImage;
  modal.classList.add("open");
}

function loadPartIntoForm(partId) {
  const part = cachedPartsMap[partId];
  const infoEl = document.getElementById("qcPieceInfo");
  const noteInput = document.getElementById("qcCustomNote");

  if (!part) {
    infoEl.textContent = "เลือกชิ้นงานด้านบนเพื่อดูข้อมูลเวลาผลิต";
    setPreviewImage("");
    return;
  }

  const totalT = (Number(part.t1 || 0) + Number(part.t2 || 0)).toFixed(2);
  infoEl.innerHTML = `
    <strong>ชิ้นงาน ${part.id}</strong> | Station 1: <strong>${Number(part.t1).toFixed(2)} วิ</strong> |
    Station 2: <strong>${Number(part.t2).toFixed(2)} วิ</strong> (รวม ${totalT} วิ)
  `;

  const score1 = getPartScoreS1(part);
  document.querySelectorAll("#criteriaListS1 .criteria-pill").forEach(opt => {
    opt.classList.remove("selected");
    if (Number(opt.dataset.score) === score1) {
      opt.classList.add("selected");
      selectedScoreS1 = score1;
      selectedLabelS1 = opt.dataset.label;
    }
  });
  updateStationBadgeUI(1, score1);

  const score2 = getPartScoreS2(part);
  document.querySelectorAll("#criteriaListS2 .criteria-pill").forEach(opt => {
    opt.classList.remove("selected");
    if (Number(opt.dataset.score) === score2) {
      opt.classList.add("selected");
      selectedScoreS2 = score2;
      selectedLabelS2 = opt.dataset.label;
    }
  });
  updateStationBadgeUI(2, score2);

  noteInput.value = part.customNote !== undefined ? part.customNote : "";

  if (part.qImage) {
    setPreviewImage(part.qImage, "✓ มีรูปหลักฐานที่บันทึกไว้แล้ว (กดลบรูปหากต้องการเปลี่ยนใหม่)");
  } else {
    setPreviewImage("");
  }
}

export function initQC() {
  document.querySelectorAll("#criteriaListS1 .criteria-pill").forEach(option => {
    option.addEventListener("click", () => {
      document.querySelectorAll("#criteriaListS1 .criteria-pill").forEach(o => o.classList.remove("selected"));
      option.classList.add("selected");
      selectedScoreS1 = Number(option.dataset.score);
      selectedLabelS1 = option.dataset.label;
      updateStationBadgeUI(1, selectedScoreS1);
    });
  });

  document.querySelectorAll("#criteriaListS2 .criteria-pill").forEach(option => {
    option.addEventListener("click", () => {
      document.querySelectorAll("#criteriaListS2 .criteria-pill").forEach(o => o.classList.remove("selected"));
      option.classList.add("selected");
      selectedScoreS2 = Number(option.dataset.score);
      selectedLabelS2 = option.dataset.label;
      updateStationBadgeUI(2, selectedScoreS2);
    });
  });

  const pieceSelect = document.getElementById("qcPieceSelect");
  pieceSelect.addEventListener("change", (e) => {
    loadPartIntoForm(e.target.value);
  });

  const imageInput = document.getElementById("qcImageInput");
  imageInput.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      alert("กรุณาเลือกไฟล์รูปภาพเท่านั้นครับ");
      imageInput.value = "";
      return;
    }

    try {
      const compressedDataUrl = await compressImageFile(file);
      setPreviewImage(compressedDataUrl, `✓ แนบรูปภาพแล้ว (${file.name})`);
    } catch (err) {
      alert("ไม่สามารถประมวลผลรูปภาพได้ กรุณาลองเลือกรูปใหม่อีกครั้งครับ");
    }
  });

  document.getElementById("btnClearQcImage").addEventListener("click", () => {
    setPreviewImage("");
  });

  const qcModal = document.getElementById("qcImageModal");
  document.getElementById("btnCloseQcModal").addEventListener("click", () => {
    qcModal.classList.remove("open");
  });
  qcModal.addEventListener("click", (e) => {
    if (e.target === qcModal) qcModal.classList.remove("open");
  });

  document.getElementById("btnSaveQC").addEventListener("click", () => {
    const partId = pieceSelect.value;
    if (!partId || !cachedPartsMap[partId]) {
      alert("กรุณาเลือกหมายเลขชิ้นงานก่อนบันทึกครับ");
      return;
    }

    if (!currentImageBase64) {
      alert("⚠️ กรุณาแนบรูปภาพหลักฐานชิ้นงานก่อนบันทึกค่า Q ครับ");
      document.getElementById("qcUploadZone").scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    const customNote = document.getElementById("qcCustomNote").value.trim();
    const avgScore = (selectedScoreS1 + selectedScoreS2) / 2;
    const summaryNote = customNote
      ? `S1: ${selectedScoreS1}% | S2: ${selectedScoreS2}% (${customNote})`
      : `S1: ${selectedLabelS1} | S2: ${selectedLabelS2}`;

    const nowStr = new Date().toLocaleString("th-TH", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });

    const btnSave = document.getElementById("btnSaveQC");
    btnSave.disabled = true;
    btnSave.textContent = "กำลังบันทึกข้อมูลและรูปหลักฐาน...";

    update(ref(db, `cnc_oee_project/parts/${partId}`), {
      qScoreS1: selectedScoreS1,
      qScoreS2: selectedScoreS2,
      qScore: avgScore,
      noteS1: selectedLabelS1,
      noteS2: selectedLabelS2,
      note: summaryNote,
      customNote: customNote,
      qImage: currentImageBase64,
      qImageUrl: "",
      qUpdatedAt: nowStr
    })
      .then(() => {
        alert(`✅ บันทึกค่า Q ชิ้นงาน ${partId} (Station 1: ${selectedScoreS1}% | Station 2: ${selectedScoreS2}%) พร้อมรูปหลักฐานเรียบร้อยแล้ว!`);
      })
      .catch((err) => {
        alert("เกิดข้อผิดพลาดในการบันทึก: " + err.message);
      })
      .finally(() => {
        btnSave.disabled = false;
        btnSave.textContent = "💾 บันทึกค่า Q (S1 & S2) + รูปหลักฐาน";
      });
  });
}

export function resetQCSelection() {
  selectedScoreS1 = 100;
  selectedLabelS1 = "ไม่เสียหาย (0 เส้น)";
  selectedScoreS2 = 100;
  selectedLabelS2 = "ไม่เสียหาย (0 เส้น)";
  setPreviewImage("");
  document.getElementById("qcCustomNote").value = "";

  document.querySelectorAll("#criteriaListS1 .criteria-pill").forEach((o, idx) => {
    o.classList.toggle("selected", idx === 0);
  });
  document.querySelectorAll("#criteriaListS2 .criteria-pill").forEach((o, idx) => {
    o.classList.toggle("selected", idx === 0);
  });
  updateStationBadgeUI(1, 100);
  updateStationBadgeUI(2, 100);
}

export function renderQC(partsObj, partsList, qualityS1, qualityS2, qualityTotal, counts) {
  cachedPartsMap = partsObj || {};

  document.getElementById("qcBigPercent").textContent = `${(qualityTotal * 100).toFixed(1)}%`;
  document.getElementById("qcTotalCount").textContent = partsList.length;
  document.getElementById("qcAvgS1").textContent = `${(qualityS1 * 100).toFixed(1)}%`;
  document.getElementById("qcAvgS2").textContent = `${(qualityS2 * 100).toFixed(1)}%`;
  document.getElementById("countQ100").textContent = counts.c100;
  document.getElementById("countQPartial").textContent = counts.cPartial;
  document.getElementById("countQ0").textContent = counts.c0;

  const selectEl = document.getElementById("qcPieceSelect");
  const prevVal = selectEl.value;

  if (partsList.length === 0) {
    selectEl.innerHTML = `<option value="">-- ยังไม่มีชิ้นงานที่ผลิตเสร็จ --</option>`;
    document.getElementById("qcPieceInfo").textContent = "เลือกชิ้นงานด้านบนเพื่อดูข้อมูลเวลาผลิต";
    setPreviewImage("");
  } else {
    selectEl.innerHTML = partsList
      .slice()
      .reverse()
      .map(p => {
        const s1 = getPartScoreS1(p);
        const s2 = getPartScoreS2(p);
        const hasImg = p.qImage ? "📷 มีรูปแล้ว" : "⚠️ ยังไม่มีรูป";
        return `<option value="${p.id}">${p.id} (S1: ${s1}% | S2: ${s2}% | ${hasImg})</option>`;
      })
      .join("");

    if (prevVal && cachedPartsMap[prevVal]) {
      selectEl.value = prevVal;
    } else {
      selectEl.value = partsList[partsList.length - 1].id;
      loadPartIntoForm(selectEl.value);
    }
  }

  const tbody = document.getElementById("qcPartsTableBody");
  if (partsList.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-cell">ยังไม่มีชิ้นงานที่ผลิตเสร็จ</td></tr>`;
    return;
  }

  tbody.innerHTML = partsList
    .slice()
    .reverse()
    .map(p => {
      const s1 = getPartScoreS1(p);
      const s2 = getPartScoreS2(p);
      const evidenceCell = p.qImage
        ? `<button type="button" class="btn-evidence-thumb" data-view-img="${p.id}">
             <img src="${p.qImage}" alt="${p.id}" />
             <span>ดูรูป</span>
           </button>`
        : `<span class="no-evidence-tag">ยังไม่แนบรูป</span>`;

      return `
        <tr class="clickable-row" data-select-part="${p.id}">
          <td><strong>${p.id}</strong></td>
          <td>${Number(p.t1).toFixed(1)}s / ${Number(p.t2).toFixed(1)}s</td>
          <td>${formatBadge(s1)}</td>
          <td>${formatBadge(s2)}</td>
          <td>${evidenceCell}</td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll("tr[data-select-part]").forEach(row => {
    row.addEventListener("click", (e) => {
      if (e.target.closest("[data-view-img]")) return;
      const id = row.dataset.selectPart;
      selectEl.value = id;
      loadPartIntoForm(id);
    });
  });

  tbody.querySelectorAll("[data-view-img]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openEvidenceModal(btn.dataset.viewImg);
    });
  });
}