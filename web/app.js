// 화면 로직: PDF 업로드 -> PDF.js로 텍스트 추출 -> MSDS 파싱 -> PPTX 2종 생성/다운로드.

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

async function extractPagesText(arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // PDF.js는 단어 단위가 아니라 글자/글리프 단위로 items를 쪼개 반환하는 경우가
    // 많다. 항목 사이에 무조건 공백을 넣으면 "경 상남도"처럼 단어 중간이 깨지므로,
    // 실제 가로 간격이 해당 항목 글자폭 대비 충분히 클 때만 공백으로 취급한다.
    const lines = [];
    let curLine = [];
    let lastItem = null;
    for (const item of content.items) {
      if (!item.str) continue;
      const x = item.transform[4];
      const y = item.transform[5];
      const height = item.height || item.transform[3] || 10;

      if (lastItem !== null && Math.abs(y - lastItem.y) > height * 0.5) {
        lines.push(curLine.join(""));
        curLine = [];
        lastItem = null;
      }

      if (lastItem !== null) {
        const expectedX = lastItem.x + lastItem.width;
        const gap = x - expectedX;
        const avgCharWidth = lastItem.str.length ? lastItem.width / lastItem.str.length : lastItem.width;
        if (gap > Math.max(avgCharWidth * 0.35, height * 0.15)) {
          curLine.push(" ");
        }
      }

      curLine.push(item.str);
      lastItem = { x, y, width: item.width, str: item.str };
    }
    if (curLine.length) lines.push(curLine.join(""));
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

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("generateBtn").addEventListener("click", handleGenerate);
});
