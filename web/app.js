// 화면 로직: PDF 업로드 -> PDF.js로 텍스트 추출 -> MSDS 파싱 -> PPTX 2종 생성/다운로드.

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

async function extractPagesText(arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();

    const items = [];
    for (const item of content.items) {
      if (!item.str) continue;
      items.push({
        x: item.transform[4],
        y: item.transform[5],
        width: item.width,
        height: item.height || item.transform[3] || 10,
        str: item.str,
      });
    }
    // 일부 MSDS PDF는 표를 열(컬럼) 단위로 그려서, PDF 콘텐츠 스트림에 기록된
    // 항목 순서가 실제 화면상의 읽기 순서(위->아래, 왼쪽->오른쪽)와 크게 어긋난다
    // (예: 성분명 열 전체 -> CAS 열 전체 -> 함유량 열 전체 순으로 그려짐). 스트림
    // 순서 그대로 이어붙이면 표 내용이 완전히 뒤섞이므로, 실제 좌표를 기준으로
    // 먼저 재정렬한다.
    items.sort((a, b) => b.y - a.y);

    // 같은 줄(행)에 속한 항목이라도 y좌표가 아주 미세하게(1pt 이하) 어긋나는
    // 경우가 있어, y값 자체를 정렬 키로 그대로 쓰면 그 미세한 차이 때문에 같은
    // 줄 안에서 좌우 순서가 뒤바뀔 수 있다(예: 함유량 값이 EU 번호보다 먼저
    // 나옴). 그래서 y가 비슷한 항목끼리 먼저 "줄" 단위로 묶은 뒤, 그 줄 안에서만
    // x좌표로 다시 정렬한다.
    const rows = [];
    for (const item of items) {
      const row = rows.length ? rows[rows.length - 1] : null;
      if (row && Math.abs(item.y - row.refY) <= item.height * 0.5) {
        row.items.push(item);
      } else {
        rows.push({ refY: item.y, items: [item] });
      }
    }
    for (const row of rows) row.items.sort((a, b) => a.x - b.x);

    // PDF.js는 단어 단위가 아니라 글자/글리프 단위로 items를 쪼개 반환하는 경우가
    // 많다. 항목 사이에 무조건 공백을 넣으면 "경 상남도"처럼 단어 중간이 깨지므로,
    // 실제 가로 간격이 해당 항목 글자폭 대비 충분히 클 때만 공백으로 취급한다.
    const lines = [];
    for (const row of rows) {
      let lineStr = "";
      let lastItem = null;
      for (const item of row.items) {
        if (lastItem !== null) {
          const expectedX = lastItem.x + lastItem.width;
          const gap = item.x - expectedX;
          const avgCharWidth = lastItem.str.length ? lastItem.width / lastItem.str.length : lastItem.width;
          if (gap > Math.max(avgCharWidth * 0.35, item.height * 0.15)) {
            lineStr += " ";
          }
        }
        lineStr += item.str;
        lastItem = item;
      }
      lines.push(lineStr);
    }
    pages.push(lines.join("\n"));
  }
  return pages;
}

function safeFilenamePart(text) {
  return (text || "").replace(/[\\/:*?"<>|]/g, "").trim();
}

function todayYmd() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

function buildFilenames(productName, seq, revDate) {
  const prefix = seq ? `${seq}.` : "";
  const product = safeFilenamePart(productName) || "제품명";
  return {
    label: `${prefix}현장경고표지_${product}_rev.${revDate}.pptx`,
    handling: `${prefix}관리요령_${product}_rev.${revDate}.pptx`,
  };
}

function setStatus(msg, isError = false) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.className = isError ? "status error" : "status";
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function handleGenerate() {
  const fileInput = document.getElementById("pdfInput");
  const seqInput = document.getElementById("seqInput");
  const resultsEl = document.getElementById("results");
  resultsEl.innerHTML = "";

  const file = fileInput.files[0];
  if (!file) {
    setStatus("MSDS PDF 파일을 먼저 선택하세요.", true);
    return;
  }

  try {
    setStatus("PDF에서 텍스트를 추출하는 중…");
    const arrayBuffer = await file.arrayBuffer();
    const pages = await extractPagesText(arrayBuffer);

    setStatus("MSDS 내용을 분석하는 중…");
    const msds = parseMsds(pages);

    if (!msds.productName) {
      setStatus("경고: 제품명을 추출하지 못했습니다. MSDS 서식이 예상과 다를 수 있습니다. 계속 진행합니다…", true);
    } else {
      setStatus(`"${msds.productName}" 인식됨. PPT를 생성하는 중…`);
    }

    const seq = (seqInput.value || "").trim();
    const revDate = todayYmd();
    const names = buildFilenames(msds.productName, seq, revDate);

    const [labelBlob, handlingBlob] = await Promise.all([
      buildLabelSlide(msds),
      buildHandlingSlide(msds),
    ]);

    addResultRow(resultsEl, names.label, labelBlob);
    addResultRow(resultsEl, names.handling, handlingBlob);

    setStatus("완료되었습니다. 아래에서 각 파일을 다운로드하세요.");
  } catch (err) {
    console.error(err);
    setStatus(`오류: ${err.message}`, true);
  }
}

function addResultRow(container, filename, blob) {
  const row = document.createElement("div");
  row.className = "result-row";

  const label = document.createElement("span");
  label.textContent = filename;

  const btn = document.createElement("button");
  btn.textContent = "다운로드";
  btn.onclick = () => downloadBlob(blob, filename);

  row.appendChild(label);
  row.appendChild(btn);
  container.appendChild(row);
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// 드롭존 안내 문구를, 선택된 파일이 있으면 파일명/크기 + 제거 버튼으로 바꿔
// 보여준다("파일 선택"으로 골랐든 드래그&드롭으로 놓았든 동일하게 반영).
function renderSelectedFile(file) {
  const emptyEl = document.getElementById("dropzoneEmpty");
  const fileEl = document.getElementById("dropzoneFile");
  if (!emptyEl || !fileEl) return;
  if (!file) {
    emptyEl.hidden = false;
    fileEl.hidden = true;
    return;
  }
  document.getElementById("fileNameText").textContent = file.name;
  document.getElementById("fileSizeText").textContent = formatFileSize(file.size);
  emptyEl.hidden = true;
  fileEl.hidden = false;
}

// "파일 선택" 버튼(클릭 -> 탐색창)과 드래그&드롭을 함께 지원한다. 드롭된
// 파일은 input.files에 그대로 반영해 handleGenerate가 두 방식 모두 동일하게
// 동작하도록 하고, 두 경로 모두 드롭존 안에 선택된 파일을 표시한다.
function setupDropzone() {
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("pdfInput");
  const removeBtn = document.getElementById("fileRemoveBtn");
  if (!dropzone || !fileInput) return;

  fileInput.addEventListener("change", () => {
    renderSelectedFile(fileInput.files[0] || null);
  });

  if (removeBtn) {
    removeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      fileInput.value = "";
      renderSelectedFile(null);
      setStatus("");
    });
  }

  ["dragenter", "dragover"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add("dragover");
    });
  });

  ["dragleave", "dragend", "drop"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove("dragover");
    });
  });

  dropzone.addEventListener("drop", (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    const file = files[0];
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setStatus("PDF 파일만 지원합니다.", true);
      return;
    }
    fileInput.files = files;
    renderSelectedFile(file);
    setStatus(`"${file.name}" 파일이 선택되었습니다.`);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("generateBtn").addEventListener("click", handleGenerate);
  setupDropzone();
  renderSelectedFile(null);
});
