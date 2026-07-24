// MSDSData -> 현장경고표지/관리요령 PPTX 생성 (브라우저용, JSZip + DOMParser 사용).
// msds_ppt_generator/ppt_builder.py 의 JS 포팅본.
//
// 그림문자 처리는 Python CLI판과 달리, 템플릿에 원래 있던 그림문자 슬롯 3개의
// 이미지 바이트만 교체하는 방식으로 단순화했다(필요 개수가 3개보다 적으면 남는
// 슬롯의 그림을 지운다). 그래서 관계(rels)/콘텐츠 타입 XML은 건드릴 필요가 없다.
// 대신 한 제품에 그림문자가 4개 이상 필요한 경우, 웹 버전은 우선순위
// (GHS01→GHS09) 상위 3개까지만 표시한다 — Python CLI는 6개까지 동적으로 배치.

const NS = {
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  xml: "http://www.w3.org/XML/1998/namespace",
};

const BULLET = "▪";
const ARROW = "▶";
const MAX_PREVENTION_ITEMS = 8;
const MAX_HANDLING_BULLETS = 4;
const MAX_HAZARD_BULLETS = 8;
const MAX_PICTOGRAMS_WEB = 3;
// 관리요령 템플릿(handling_template.pptx)의 실제 슬라이드 높이(EMU). 표의
// 실제 높이가 이보다 조금 더 커서 맨 아래 행 일부가 인쇄 가능 영역을
// 벗어나 있어, 표를 위로 살짝 올려 보정하는 데 사용한다.
const HANDLING_SLIDE_HEIGHT_EMU = 9906000;

const LABEL_PICTURE_SLOTS = [
  { name: "Picture 9", mediaPath: "ppt/media/image3.png" },
  { name: "Picture 10", mediaPath: "ppt/media/image4.png" },
  { name: "Picture 11", mediaPath: "ppt/media/image5.png" },
];
const HANDLING_PICTURE_SLOTS = [
  { name: "Picture 3074", mediaPath: "ppt/media/image2.png" },
  { name: "Picture 3075", mediaPath: "ppt/media/image3.png" },
  { name: "Picture 3076", mediaPath: "ppt/media/image4.png" },
];

// --------------------------------------------------------------------------
// 공용 유틸
// --------------------------------------------------------------------------

function base64ToUint8Array(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function loadTemplateZip(base64) {
  return JSZip.loadAsync(base64ToUint8Array(base64));
}

async function getSlideDoc(zip) {
  const xmlText = await zip.file("ppt/slides/slide1.xml").async("string");
  return new DOMParser().parseFromString(xmlText, "application/xml");
}

function serializeDoc(doc) {
  return new XMLSerializer().serializeToString(doc);
}

function firstEl(parent, ns, tag) {
  if (!parent) return null;
  const list = parent.getElementsByTagNameNS(ns, tag);
  return list.length ? list[0] : null;
}

function allEls(parent, ns, tag) {
  if (!parent) return [];
  return Array.from(parent.getElementsByTagNameNS(ns, tag));
}

function findShapeByName(doc, name) {
  for (const sp of allEls(doc, NS.p, "sp")) {
    const cNvPr = firstEl(sp, NS.p, "cNvPr");
    if (cNvPr && cNvPr.getAttribute("name") === name) return sp;
  }
  return null;
}

function findPictureByName(doc, name) {
  for (const pic of allEls(doc, NS.p, "pic")) {
    const cNvPr = firstEl(pic, NS.p, "cNvPr");
    if (cNvPr && cNvPr.getAttribute("name") === name) return pic;
  }
  return null;
}

function findTableShape(doc) {
  for (const gf of allEls(doc, NS.p, "graphicFrame")) {
    if (firstEl(gf, NS.a, "tbl")) return gf;
  }
  return null;
}

// 도형(p:sp)의 텍스트 프레임은 <p:txBody>(presentationml 네임스페이스)이고,
// 표 셀(a:tc)의 텍스트 프레임은 <a:txBody>(drawingml 네임스페이스)로 서로 다르다.
function txBodyOf(shapeEl) {
  return firstEl(shapeEl, NS.p, "txBody");
}

function shapeExt(shapeEl) {
  const spPr = firstEl(shapeEl, NS.p, "spPr");
  const xfrm = firstEl(spPr, NS.a, "xfrm");
  return firstEl(xfrm, NS.a, "ext");
}

function shapeOff(shapeEl) {
  const spPr = firstEl(shapeEl, NS.p, "spPr");
  const xfrm = firstEl(spPr, NS.a, "xfrm");
  return firstEl(xfrm, NS.a, "off");
}

// --------------------------------------------------------------------------
// 단락/텍스트 조작 (msds_ppt_generator/ppt_builder.py 와 동일한 접근)
// --------------------------------------------------------------------------

function setParagraphText(pElem, text) {
  const runs = allEls(pElem, NS.a, "r");
  if (!runs.length) return;
  const t = firstEl(runs[0], NS.a, "t");
  if (!t) return;
  t.textContent = text;
  t.setAttributeNS(NS.xml, "xml:space", "preserve");
  for (let i = runs.length - 1; i >= 1; i--) runs[i].parentNode.removeChild(runs[i]);
}

function replaceParagraphs(txBody, lines, templateIndex = 0) {
  const ps = allEls(txBody, NS.a, "p");
  if (!ps.length) return;
  const template = ps[Math.min(templateIndex, ps.length - 1)].cloneNode(true);
  for (const p of ps) txBody.removeChild(p);
  const finalLines = lines.length ? lines : [""];
  for (const line of finalLines) {
    const newP = template.cloneNode(true);
    setParagraphText(newP, line);
    txBody.appendChild(newP);
  }
}

// --------------------------------------------------------------------------
// 공급자 정보 자동 줄맞춤(최소 10pt, 1줄이 안 되면 2줄) - ppt_builder.py 이식
// --------------------------------------------------------------------------

const EMU_PER_PT = 12700;
const FOOTER_MAX_FONT_PT = 12;
const FOOTER_MIN_FONT_PT = 10;
const TITLE_FIXED_FONT_PT = 36;
const COMPOSITION_MAX_FONT_PT = 12;
const COMPOSITION_MIN_FONT_PT = 8;
const LINE_HEIGHT_FACTOR = 1.2;
// 그림문자(그림)와 상자 사이에 남겨 둘 최소 여백.
const PICTOGRAM_GAP_EMU = 50000;
const WIDE_CHAR_EXTRA = new Set([0x203b, 0x260e, 0x2605, 0x2606, 0x2600]);

function isWideChar(ch) {
  const cp = ch.codePointAt(0);
  return (
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0x3130 && cp <= 0x318f) ||
    (cp >= 0x2e80 && cp <= 0x9fff) ||
    WIDE_CHAR_EXTRA.has(cp)
  );
}

function estimateTextWidthEmu(text, sizePt) {
  let widthEm = 0;
  for (const ch of text) {
    if (ch === " ") widthEm += 0.28;
    else if (isWideChar(ch)) widthEm += 1.0;
    else widthEm += 0.55;
  }
  return widthEm * sizePt * EMU_PER_PT;
}

function fitFooterLines(address, company, phone, availableWidthEmu) {
  const full = `※ 공급자 정보 : ${address}  ${company} ☎ ${phone}`;
  for (let size = FOOTER_MAX_FONT_PT; size >= FOOTER_MIN_FONT_PT; size--) {
    if (estimateTextWidthEmu(full, size) <= availableWidthEmu) return { lines: [full], size };
  }
  const size = FOOTER_MIN_FONT_PT;
  // 전화번호가 혼자 한 줄을 차지하지 않도록, 우선 회사명과 같은 줄에 붙여본다
  // (그래도 안 맞으면 전화번호만 따로 뺀다).
  const candidates = [
    [`※ 공급자 정보 : ${address}`, `${company}  ☎ ${phone}`],
    [`※ 공급자 정보 : ${address}  ${company}`, `☎ ${phone}`],
  ];
  for (const [line1, line2] of candidates) {
    if (estimateTextWidthEmu(line1, size) <= availableWidthEmu && estimateTextWidthEmu(line2, size) <= availableWidthEmu) {
      return { lines: [line1, line2], size };
    }
  }
  return { lines: candidates[0], size };
}

function setFooterText(shapeEl, lines, sizePt, maxBottom = null) {
  const txBody = txBodyOf(shapeEl);
  const bodyPr = firstEl(txBody, NS.a, "bodyPr");
  for (const tag of ["normAutofit", "spAutoFit"]) {
    const el = firstEl(bodyPr, NS.a, tag);
    if (el) bodyPr.removeChild(el);
  }
  if (!firstEl(bodyPr, NS.a, "noAutofit")) {
    bodyPr.appendChild(bodyPr.ownerDocument.createElementNS(NS.a, "a:noAutofit"));
  }

  const tIns = parseInt(bodyPr.getAttribute("tIns") || "45720", 10);
  const bIns = parseInt(bodyPr.getAttribute("bIns") || "45720", 10);

  replaceParagraphs(txBody, lines);
  for (const p of allEls(txBody, NS.a, "p")) {
    for (const r of allEls(p, NS.a, "r")) {
      const rPr = firstEl(r, NS.a, "rPr");
      if (rPr) rPr.setAttribute("sz", String(Math.round(sizePt * 100)));
    }
  }

  const neededHeight = Math.round(lines.length * sizePt * 1.2 * EMU_PER_PT) + tIns + bIns;
  const ext = shapeExt(shapeEl);
  const off = shapeOff(shapeEl);
  const curHeight = parseInt(ext.getAttribute("cy"), 10);
  if (neededHeight > curHeight) {
    // 글상자 높이를 늘려야 할 때, 아래쪽 경계(maxBottom, 보통 라벨 바깥 굵은
    // 테두리 선의 y좌표)를 넘지 않도록 위쪽으로만 확장한다.
    const curTop = parseInt(off.getAttribute("y"), 10);
    let bottom = curTop + curHeight;
    if (maxBottom !== null) bottom = Math.min(bottom, maxBottom);
    ext.setAttribute("cy", String(neededHeight));
    off.setAttribute("y", String(Math.round(bottom - neededHeight)));
  }
}

// --------------------------------------------------------------------------
// 제품명 + 성분 목록 글상자 자동 축소
// --------------------------------------------------------------------------

// 제목(36pt 고정) + 성분 목록이 상자 높이 안에 들어가도록 성분 목록 글자
// 크기와 상자에 필요한 높이를 정한다. 상자는 세로 가운데 정렬(anchor=ctr)
// 이라 내용이 길어지면 위/아래로 넘쳐 인쇄 서식 경계(제목 위쪽 테두리, 그림문자
// 영역)를 넘어갈 수 있어, 성분 목록 글자 크기부터 줄이고 그래도 안 맞으면
// 상자 높이를(그림문자와 겹치지 않는 한도까지) 늘린다.
// 제품명이 길면(특히 영문 제품명) 36pt 고정 폭에 한 줄로 안 들어가 줄바꿈될
// 수 있다. 1줄로 가정하고 높이를 계산하면 실제로 2줄 이상이 될 때 다시
// 테두리를 침범하므로, titleLines로 줄바꿈 예상 줄 수를 반영해야 한다.
function fitLabelCompositionSize(nRows, tIns, bIns, topGapEmu, maxHeightEmu, titleLines = 1) {
  const titleHeightFactor = TITLE_FIXED_FONT_PT * titleLines;
  for (let contentPt = COMPOSITION_MAX_FONT_PT; contentPt >= COMPOSITION_MIN_FONT_PT; contentPt--) {
    const needed = LINE_HEIGHT_FACTOR * (titleHeightFactor + contentPt * nRows) * EMU_PER_PT
      + tIns + bIns + 2 * topGapEmu;
    if (needed <= maxHeightEmu) return { contentPt, requiredHeight: needed };
  }
  const contentPt = COMPOSITION_MIN_FONT_PT;
  const needed = LINE_HEIGHT_FACTOR * (titleHeightFactor + contentPt * nRows) * EMU_PER_PT
    + tIns + bIns + 2 * topGapEmu;
  return { contentPt, requiredHeight: Math.min(needed, maxHeightEmu) };
}

// --------------------------------------------------------------------------
// 그림문자 배치 (고정 3슬롯 방식)
// --------------------------------------------------------------------------

function applyPictogramSlots(doc, zip, slots, codes) {
  const capped = codes.slice(0, MAX_PICTOGRAMS_WEB);
  for (let i = 0; i < slots.length; i++) {
    if (i < capped.length) {
      const bytes = base64ToUint8Array(MSDS_ASSETS.pictograms[capped[i]]);
      zip.file(slots[i].mediaPath, bytes);
    } else {
      const pic = findPictureByName(doc, slots[i].name);
      if (pic && pic.parentNode) pic.parentNode.removeChild(pic);
    }
  }
}

function repositionPictureShape(pic, x, y, size) {
  const spPr = firstEl(pic, NS.p, "spPr");
  const xfrm = firstEl(spPr, NS.a, "xfrm");
  const off = firstEl(xfrm, NS.a, "off");
  const ext = firstEl(xfrm, NS.a, "ext");
  off.setAttribute("x", String(Math.round(x)));
  off.setAttribute("y", String(Math.round(y)));
  ext.setAttribute("cx", String(Math.round(size)));
  ext.setAttribute("cy", String(Math.round(size)));
}

// 표 칸(cell) 안에 그림문자를 가로 중앙 정렬로 배치하고, 칸 높이를 기준으로
// 테두리를 넘지 않는 한도 내에서 최대한 크게 키운다(msds_ppt_generator/ppt_builder.py
// 의 _place_pictogram_row_in_cell 과 동일한 로직).
function applyPictogramSlotsCentered(doc, zip, slots, codes, cellLeft, cellTop, cellWidth, cellHeight, gap = 150000, padRatio = 0.08) {
  const capped = codes.slice(0, MAX_PICTOGRAMS_WEB);
  const n = capped.length;
  const maxByHeight = cellHeight * (1 - padRatio);
  const maxByWidth = n > 0 ? (cellWidth - (n - 1) * gap) / n : 0;
  const size = n > 0 ? Math.max(1, Math.min(maxByHeight, maxByWidth)) : 0;
  const total = n * size + (n - 1) * gap;
  const startX = cellLeft + (cellWidth - total) / 2;
  const y = cellTop + (cellHeight - size) / 2;
  for (let i = 0; i < slots.length; i++) {
    if (i < n) {
      const bytes = base64ToUint8Array(MSDS_ASSETS.pictograms[capped[i]]);
      zip.file(slots[i].mediaPath, bytes);
      const pic = findPictureByName(doc, slots[i].name);
      if (pic) repositionPictureShape(pic, startX + i * (size + gap), y, size);
    } else {
      const pic = findPictureByName(doc, slots[i].name);
      if (pic && pic.parentNode) pic.parentNode.removeChild(pic);
    }
  }
}

// --------------------------------------------------------------------------
// 유해・예방조치 문구 선택
// --------------------------------------------------------------------------

function selectPrecautionLines(precaution) {
  const lines = [];
  for (const [, desc] of (precaution.prevention || []).slice(0, MAX_PREVENTION_ITEMS)) {
    lines.push(`${BULLET} ${desc}`);
  }
  for (const group of ["response", "storage", "disposal"]) {
    const items = precaution[group] || [];
    if (items.length) lines.push(`${BULLET} ${items[0][1]}`);
  }
  return lines;
}

function normalizeWs(text) {
  return (text || "").replace(/\s+/g, "");
}

function classificationLookup(classification) {
  const map = {};
  for (const [family, category] of classification) map[normalizeWs(family)] = category;
  return map;
}

function hazardBulletsForHandling(hazardStatements, classification) {
  const lookup = classificationLookup(classification);
  const lines = [];
  for (const [code, desc] of hazardStatements.slice(0, MAX_HAZARD_BULLETS)) {
    const family = familyForHcode(code.split("+")[0]);
    const category = family ? lookup[normalizeWs(family)] : null;
    lines.push(category ? `- ${desc}(${category})` : `- ${desc}`);
  }
  return lines;
}

// --------------------------------------------------------------------------
// 템플릿 A: 현장경고표지
// --------------------------------------------------------------------------

async function buildLabelSlide(msds) {
  const zip = await loadTemplateZip(MSDS_ASSETS.labelTemplate);
  const doc = await getSlideDoc(zip);

  // 제품명 + 성분 목록
  const rect14 = findShapeByName(doc, "Rectangle 14");
  const txBody14 = txBodyOf(rect14);
  const ps = allEls(txBody14, NS.a, "p");
  const titleP = ps[0];
  setParagraphText(titleP, msds.productName);
  const compTemplateIdx = ps.length > 1 ? 1 : 0;
  const compTemplate = ps[compTemplateIdx].cloneNode(true);
  for (let i = ps.length - 1; i >= 1; i--) txBody14.removeChild(ps[i]);
  for (const [name, cas, content] of msds.composition) {
    const newP = compTemplate.cloneNode(true);
    const contentDisp = content.endsWith("%") ? content : `${content}%`;
    setParagraphText(newP, `( CAS No. : ${cas} ,  함유량 : ${contentDisp}) - ${name}`);
    txBody14.appendChild(newP);
  }

  // 상자가 세로 가운데 정렬이라, 성분이 많아 전체 내용이 길어지면 제목이
  // 위쪽 테두리를 넘어가거나 아래쪽 그림문자와 겹칠 수 있다. 제목은 항상
  // 36pt 굵게 고정하고, 성분 목록 글자 크기와 상자 높이를 성분 개수에 맞춰
  // 다시 계산해 위쪽 테두리와 그림문자 사이 안에 들어오도록 한다.
  const rect14Ext = shapeExt(rect14);
  const rect14Off = shapeOff(rect14);
  const rect14Height = parseInt(rect14Ext.getAttribute("cy"), 10);
  const rect14Width = parseInt(rect14Ext.getAttribute("cx"), 10);
  const rect14Top = parseInt(rect14Off.getAttribute("y"), 10);
  const bodyPr14 = firstEl(txBody14, NS.a, "bodyPr");
  const tIns14 = parseInt(bodyPr14.getAttribute("tIns") || "45720", 10);
  const bIns14 = parseInt(bodyPr14.getAttribute("bIns") || "45720", 10);
  const lIns14 = parseInt(bodyPr14.getAttribute("lIns") || "90000", 10);
  const rIns14 = parseInt(bodyPr14.getAttribute("rIns") || "90000", 10);
  const outlineForTitle = findShapeByName(doc, "Rectangle 2");
  let topGapEmu = 0;
  if (outlineForTitle) {
    const outlineOffForTitle = shapeOff(outlineForTitle);
    const outlineTop = parseInt(outlineOffForTitle.getAttribute("y"), 10);
    topGapEmu = Math.max(0, outlineTop - rect14Top - tIns14);
  }
  const picTops = LABEL_PICTURE_SLOTS
    .map((slot) => findPictureByName(doc, slot.name))
    .filter(Boolean)
    .map((pic) => parseInt(shapeOff(pic).getAttribute("y"), 10));
  let maxHeight = rect14Height;
  if (picTops.length) {
    const maxBottomForTitle = Math.min(...picTops) - PICTOGRAM_GAP_EMU;
    maxHeight = Math.max(rect14Height, maxBottomForTitle - rect14Top);
  }
  const titleUsableWidth = rect14Width - lIns14 - rIns14;
  const titleWidth = estimateTextWidthEmu(msds.productName, TITLE_FIXED_FONT_PT);
  const titleLines = titleUsableWidth > 0 ? Math.max(1, Math.ceil(titleWidth / titleUsableWidth)) : 1;
  const { contentPt, requiredHeight } = fitLabelCompositionSize(
    msds.composition.length, tIns14, bIns14, topGapEmu, maxHeight, titleLines
  );
  if (requiredHeight > rect14Height) {
    rect14Ext.setAttribute("cy", String(Math.round(requiredHeight)));
  }
  for (const r of allEls(titleP, NS.a, "r")) {
    const rPr = firstEl(r, NS.a, "rPr");
    if (rPr) {
      rPr.setAttribute("sz", String(Math.round(TITLE_FIXED_FONT_PT * 100)));
      rPr.setAttribute("b", "1");
    }
  }
  const compPs = allEls(txBody14, NS.a, "p").slice(1);
  for (const p of compPs) {
    for (const r of allEls(p, NS.a, "r")) {
      const rPr = firstEl(r, NS.a, "rPr");
      if (rPr) rPr.setAttribute("sz", String(Math.round(contentPt * 100)));
    }
  }

  // 신호어 (원본이 "신호어 : 해당없음"으로 명시한 문서는 실제로 GHS
  // 미분류 제품이라 신호어가 없는 것이 맞으므로, "경고"로 임의 대체하지
  // 않고 원본 값을 그대로(없으면 빈 칸으로) 반영한다.
  const rect15 = findShapeByName(doc, "Rectangle 15");
  setParagraphText(firstEl(txBodyOf(rect15), NS.a, "p"), msds.signalWord || "");

  // 공급자 정보
  const rect16 = findShapeByName(doc, "Rectangle 16");
  const phone = (msds.supplierPhone || "").split(",")[0].trim();
  const bodyPr16 = firstEl(txBodyOf(rect16), NS.a, "bodyPr");
  const lIns = parseInt(bodyPr16.getAttribute("lIns") || "91440", 10);
  const rIns = parseInt(bodyPr16.getAttribute("rIns") || "91440", 10);
  const rect16Width = parseInt(shapeExt(rect16).getAttribute("cx"), 10);
  const availableWidth = rect16Width - lIns - rIns;
  const { lines: footerLines, size: footerSize } = fitFooterLines(
    msds.supplierAddress, msds.supplierName, phone, availableWidth
  );
  const outline = findShapeByName(doc, "Rectangle 2");
  let maxBottom = null;
  if (outline) {
    const outlineOff = shapeOff(outline);
    const outlineExt = shapeExt(outline);
    maxBottom = parseInt(outlineOff.getAttribute("y"), 10) + parseInt(outlineExt.getAttribute("cy"), 10);
  }
  setFooterText(rect16, footerLines, footerSize, maxBottom);

  // 표: 유해ㆍ위험 문구 / 예방조치 문구
  const tableShape = findTableShape(doc);
  const tbl = firstEl(tableShape, NS.a, "tbl");
  const rows = allEls(tbl, NS.a, "tr");
  const row0Cells = allEls(rows[0], NS.a, "tc");
  const row1Cells = allEls(rows[1], NS.a, "tc");

  const hazardLines = msds.hazardStatements.slice(0, MAX_HAZARD_BULLETS).map(([, desc]) => `${BULLET} ${desc}`);
  replaceParagraphs(firstEl(row0Cells[1], NS.a, "txBody"), hazardLines);
  const precautionLines = selectPrecautionLines(msds.precaution);
  replaceParagraphs(firstEl(row1Cells[1], NS.a, "txBody"), precautionLines);

  // 그림문자
  const codes = pictogramsForHcodes(msds.hazardStatements.map(([c]) => c));
  applyPictogramSlots(doc, zip, LABEL_PICTURE_SLOTS, codes);

  zip.file("ppt/slides/slide1.xml", serializeDoc(doc));
  return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
}

// --------------------------------------------------------------------------
// 템플릿 B: 관리요령
// --------------------------------------------------------------------------

// 서로 다른 레이블에서 뽑아낸 문장 조각들을 하나로 이어붙일 때, 앞 조각이
// 마침표 등으로 끝나지 않으면 그냥 공백만 넣어 이어붙이지 않고 마침표를
// 넣어 두 문장이 붙어 읽히지 않게 한다.
function joinFragments(parts) {
  let out = "";
  for (const p of parts.filter(Boolean)) {
    if (out && !/[.!?]$/.test(out)) out += ". ";
    else if (out) out += " ";
    out += p;
  }
  return out;
}

function accidentResponseBullets(msds) {
  const lines = [];
  const fire = joinFragments([msds.firefighting.extinguishing, msds.firefighting.protective]);
  if (fire) lines.push(`- 화재 시 ${fire}`);
  const leak = joinFragments([msds.accidentalRelease.personal, msds.accidentalRelease.environmental]);
  if (leak) lines.push(`- 누출 시 ${leak}`);
  return lines;
}

function ppeBullets(msds) {
  return ["respiratory", "eye", "hand", "body"]
    .filter((k) => msds.exposureControls[k])
    .map((k) => `- ${msds.exposureControls[k]}`);
}

function firstAidBullets(msds) {
  const lines = [];
  for (const k of ["eye", "skin", "inhalation", "ingestion", "other"]) {
    const item = msds.firstAid[k];
    if (!item) continue;
    lines.push(`${ARROW} ${item.label}`);
    if (item.text) lines.push(`- ${item.text}`);
  }
  return lines;
}

function handlingBullets(msds) {
  const lines = (msds.handlingStorage.handling || []).slice(0, MAX_HANDLING_BULLETS).map((s) => `- ${s}`);
  const storage = msds.handlingStorage.storage || [];
  if (storage.length) lines.push(`- ${storage[0]}`);
  return lines;
}

async function buildHandlingSlide(msds) {
  const zip = await loadTemplateZip(MSDS_ASSETS.handlingTemplate);
  const doc = await getSlideDoc(zip);

  const tableShape = findTableShape(doc);
  const tbl = firstEl(tableShape, NS.a, "tbl");
  const rows = allEls(tbl, NS.a, "tr");
  const cellsOf = (rowIdx) => allEls(rows[rowIdx], NS.a, "tc");

  // 템플릿 표의 실제 높이가 슬라이드 높이보다 조금 더 커서, 맨 아래 행
  // ("※ 기타 자세한 내용은...") 일부가 인쇄 가능 영역을 벗어나 있다. 표는
  // 이미 위쪽 테두리를 가리려고 top을 음수로 잡아둔 상태라, 그만큼 더 위로
  // 올려도 보이는 내용에는 영향이 없어 이 방식으로 넘치는 만큼 보정한다.
  const tblOff0 = firstEl(tableShape, NS.p, "xfrm");
  const off0 = firstEl(tblOff0, NS.a, "off");
  const ext0 = firstEl(tblOff0, NS.a, "ext");
  const tableTop0 = parseInt(off0.getAttribute("y"), 10);
  const tableHeight0 = parseInt(ext0.getAttribute("cy"), 10);
  const overflow0 = tableTop0 + tableHeight0 - HANDLING_SLIDE_HEIGHT_EMU;
  if (overflow0 > 0) {
    off0.setAttribute("y", String(tableTop0 - overflow0));
  }

  setParagraphText(firstEl(firstEl(cellsOf(0)[0], NS.a, "txBody"), NS.a, "p"), msds.productName);

  replaceParagraphs(firstEl(cellsOf(2)[1], NS.a, "txBody"), hazardBulletsForHandling(msds.hazardStatements, msds.classification));
  replaceParagraphs(firstEl(cellsOf(3)[1], NS.a, "txBody"), handlingBullets(msds));
  replaceParagraphs(firstEl(cellsOf(4)[1], NS.a, "txBody"), ppeBullets(msds));
  replaceParagraphs(firstEl(cellsOf(5)[1], NS.a, "txBody"), firstAidBullets(msds));
  replaceParagraphs(firstEl(cellsOf(6)[1], NS.a, "txBody"), accidentResponseBullets(msds));

  // 그림문자 칸은 표 2번째 행(가로 두 칸 병합)이다. 그 칸의 실제 좌표를 계산해
  // 그 안에서 가로 중앙 정렬 + 칸 높이에 맞춘 최대 크기로 배치한다.
  const tblXfrm = firstEl(tableShape, NS.p, "xfrm");
  const tblOff = firstEl(tblXfrm, NS.a, "off");
  const tblExt = firstEl(tblXfrm, NS.a, "ext");
  const tableLeft = parseInt(tblOff.getAttribute("x"), 10);
  const tableTop = parseInt(tblOff.getAttribute("y"), 10);
  const tableWidth = parseInt(tblExt.getAttribute("cx"), 10);
  const row0Height = parseInt(rows[0].getAttribute("h"), 10);
  const row1Height = parseInt(rows[1].getAttribute("h"), 10);
  const picCellTop = tableTop + row0Height;

  const codes = pictogramsForHcodes(msds.hazardStatements.map(([c]) => c));
  applyPictogramSlotsCentered(doc, zip, HANDLING_PICTURE_SLOTS, codes, tableLeft, picCellTop, tableWidth, row1Height);

  zip.file("ppt/slides/slide1.xml", serializeDoc(doc));
  return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
}
