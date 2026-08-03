// MSDSData -> 현장경고표지/관리요령 PPTX 생성 (브라우저용, JSZip + DOMParser 사용).
// msds_ppt_generator/ppt_builder.py 의 JS 포팅본.
//
// 그림문자 처리: 템플릿에 원래 있던 그림문자 슬롯(3개)은 이미지 바이트만
// 교체해 재사용하고, 그보다 많은 그림문자가 필요하면 슬롯 하나를 복제해
// 새 관계(rels)와 미디어 파트를 추가한 뒤 슬라이드에 삽입한다(Python CLI판과
// 동일하게 최대 6개, 우선순위 GHS01→GHS09 상위 순).

const NS = {
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  xml: "http://www.w3.org/XML/1998/namespace",
};

const BULLET = "▪";
const ARROW = "▶";
const MAX_PREVENTION_ITEMS = 8;
const MAX_RESPONSE_ITEMS = 6;
const MAX_STORAGE_ITEMS = 3;
const MAX_DISPOSAL_ITEMS = 3;
const MAX_HANDLING_BULLETS = 4;
const MAX_HAZARD_BULLETS = 8;
const MAX_PICTOGRAMS_WEB = 6;
const PRECAUTION_MAX_FONT_PT = 13;
const PRECAUTION_MIN_FONT_PT = 9;
const PRECAUTION_LINE_HEIGHT_FACTOR = 1.2;
// 관리요령 템플릿(handling_template.pptx)의 실제 슬라이드 높이(EMU). 표의
// 실제 높이가 이보다 조금 더 커서 맨 아래 행 일부가 인쇄 가능 영역을
// 벗어나 있어, 표를 위로 살짝 올려 보정하는 데 사용한다.
const HANDLING_SLIDE_HEIGHT_EMU = 9906000;

const SLIDE_XML_PATH = "ppt/slides/slide1.xml";
const SLIDE_RELS_PATH = "ppt/slides/_rels/slide1.xml.rels";

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
  const xmlText = await zip.file(SLIDE_XML_PATH).async("string");
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
const TITLE_MAX_FONT_PT = 36;
const TITLE_MIN_FONT_PT = 20;
// 현장경고표지(독립 도형, bodyPr lIns/rIns)와 관리요령(표 셀, tcPr marL/marR)의
// 제목 상자는 여백 방식이 달라 실제 사용 가능 폭이 서로 다르다. 두 슬라이드의
// 제목 크기를 항상 일치시키기 위해, 더 좁은 쪽(현장경고표지) 기준으로 통일한다.
const TITLE_CANONICAL_USABLE_WIDTH_EMU = 6271560;
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

// --------------------------------------------------------------------------
// 제목 글상자 자동 축소
// --------------------------------------------------------------------------

// 제목은 항상 한 줄로 표시한다. 36pt로 상자 폭에 안 들어가는(제품명이 길거나
// 영문+한글이 병기된) 경우, 20pt까지 줄여 한 줄을 유지한다.
function fitTitleFont(text, usableWidthEmu) {
  usableWidthEmu = Math.min(usableWidthEmu, TITLE_CANONICAL_USABLE_WIDTH_EMU);
  for (let fontPt = TITLE_MAX_FONT_PT; fontPt >= TITLE_MIN_FONT_PT; fontPt--) {
    if (estimateTextWidthEmu(text, fontPt) <= usableWidthEmu) return fontPt;
  }
  return TITLE_MIN_FONT_PT;
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

// 표 셀(a:tc)의 tcPr에 지정된 실제 여백(marL/marR/marT/marB)을 읽는다. 지정이
// 없으면 OOXML 표 셀 기본 여백(좌우 91440 / 상하 45720 EMU)을 쓴다. 그림문자
// 크기를 셀 "높이" 기준으로만 계산하고 이 여백을 무시하면, 셀 테두리 안쪽
// 여백만큼 그림문자가 테두리 밖으로 살짝 넘치는 경우가 생긴다(관리요령 표의
// 그림문자 행이 실제로 이 문제가 있었음: 여백 비율 9.3% > 기존 padRatio 8%).
function cellInsets(tcEl) {
  const tcPr = tcEl ? firstEl(tcEl, NS.a, "tcPr") : null;
  return {
    marL: parseInt((tcPr && tcPr.getAttribute("marL")) || "91440", 10),
    marR: parseInt((tcPr && tcPr.getAttribute("marR")) || "91440", 10),
    marT: parseInt((tcPr && tcPr.getAttribute("marT")) || "45720", 10),
    marB: parseInt((tcPr && tcPr.getAttribute("marB")) || "45720", 10),
  };
}

// 슬라이드에 새 이미지 관계(rels)와 미디어 파트를 추가하고 새 rId를 반환한다.
// 그림문자 슬롯이 템플릿에 있는 개수(3개)보다 많이 필요할 때 사용한다.
async function addPictureRelationship(zip, bytes) {
  const usedImageNums = Object.keys(zip.files)
    .map((name) => name.match(/^ppt\/media\/image(\d+)\.png$/))
    .filter(Boolean)
    .map((m) => parseInt(m[1], 10));
  const nextImageNum = (usedImageNums.length ? Math.max(...usedImageNums) : 0) + 1;
  const mediaPath = `ppt/media/image${nextImageNum}.png`;

  let relsText = await zip.file(SLIDE_RELS_PATH).async("string");
  const usedRelIds = Array.from(relsText.matchAll(/Id="rId(\d+)"/g)).map((m) => parseInt(m[1], 10));
  const rId = `rId${(usedRelIds.length ? Math.max(...usedRelIds) : 0) + 1}`;

  zip.file(mediaPath, bytes);
  const newRel = `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${nextImageNum}.png"/>`;
  relsText = relsText.replace("</Relationships>", `${newRel}</Relationships>`);
  zip.file(SLIDE_RELS_PATH, relsText);

  return rId;
}

// 표 칸(cell) 안에 그림문자를 가로 중앙 정렬로 배치하고, 칸의 실제 여백을 뺀
// 안쪽 영역을 기준으로 테두리를 넘지 않는 한도 내에서 최대한 크게 키운다
// (msds_ppt_generator/ppt_builder.py 의 _place_pictogram_row_in_cell 과 동일한
// 로직 + 셀 여백 반영). 템플릿에 준비된 그림문자 슬롯(slots)보다 많은 개수가
// 필요하면, 첫 슬롯의 도형을 복제해 새 관계/미디어와 함께 슬라이드에 추가한다.
async function applyPictogramSlotsCentered(doc, zip, slots, codes, cellLeft, cellTop, cellWidth, cellHeight, options = {}) {
  const { gap = 150000, padRatio = 0.02, cellEl = null } = options;
  const capped = codes.slice(0, MAX_PICTOGRAMS_WEB);
  const n = capped.length;

  const { marL, marR, marT, marB } = cellInsets(cellEl);
  const innerLeft = cellLeft + marL;
  const innerTop = cellTop + marT;
  const innerWidth = cellWidth - marL - marR;
  const innerHeight = cellHeight - marT - marB;

  const maxByHeight = innerHeight * (1 - padRatio);
  const maxByWidth = n > 0 ? (innerWidth - (n - 1) * gap) / n : 0;
  const size = n > 0 ? Math.max(1, Math.min(maxByHeight, maxByWidth)) : 0;
  const total = n * size + (n - 1) * gap;
  const startX = innerLeft + (innerWidth - total) / 2;
  const y = innerTop + (innerHeight - size) / 2;

  const firstSlotPic = findPictureByName(doc, slots[0].name);
  const templatePic = firstSlotPic ? firstSlotPic.cloneNode(true) : null;
  const spTree = firstSlotPic ? firstSlotPic.parentNode : null;
  let nextShapeId = Math.max(0, ...allEls(doc, NS.p, "cNvPr").map((el) => parseInt(el.getAttribute("id") || "0", 10)));

  for (let i = 0; i < slots.length; i++) {
    const pic = findPictureByName(doc, slots[i].name);
    if (i < n) {
      const bytes = base64ToUint8Array(MSDS_ASSETS.pictograms[capped[i]]);
      zip.file(slots[i].mediaPath, bytes);
      if (pic) repositionPictureShape(pic, startX + i * (size + gap), y, size);
    } else if (pic && pic.parentNode) {
      pic.parentNode.removeChild(pic);
    }
  }

  for (let i = slots.length; i < n; i++) {
    if (!templatePic || !spTree) break; // 템플릿에 그림 슬롯이 하나도 없으면 추가 불가
    const bytes = base64ToUint8Array(MSDS_ASSETS.pictograms[capped[i]]);
    const rId = await addPictureRelationship(zip, bytes);
    const newPic = templatePic.cloneNode(true);
    nextShapeId += 1;
    const cNvPr = firstEl(newPic, NS.p, "cNvPr");
    cNvPr.setAttribute("id", String(nextShapeId));
    cNvPr.setAttribute("name", `GHS Pictogram ${i + 1}`);
    const blip = firstEl(newPic, NS.a, "blip");
    blip.setAttributeNS(NS.r, "r:embed", rId);
    repositionPictureShape(newPic, startX + i * (size + gap), y, size);
    spTree.appendChild(newPic);
  }
}

// --------------------------------------------------------------------------
// 유해・예방조치 문구 선택
// --------------------------------------------------------------------------

// 예방/대응/저장/폐기 네 그룹 모두에서 주요 내용을 발췌한다. 그룹별로 한
// 건만 취하면(과거 방식) 대응 그룹처럼 항목이 많은 경우 눈·피부·흡입 등
// 서로 다른 노출 경로에 대한 대응 문구가 대부분 빠지므로, 그룹별로 여러
// 건을 담되(칸 크기에 맞춰 아래에서 글자 크기를 조정) 상한을 둔다.
function selectPrecautionLines(precaution) {
  const lines = [];
  for (const [, desc] of (precaution.prevention || []).slice(0, MAX_PREVENTION_ITEMS)) {
    lines.push(`${BULLET} ${desc}`);
  }
  const groupCaps = [["response", MAX_RESPONSE_ITEMS], ["storage", MAX_STORAGE_ITEMS], ["disposal", MAX_DISPOSAL_ITEMS]];
  for (const [group, cap] of groupCaps) {
    for (const [, desc] of (precaution[group] || []).slice(0, cap)) {
      lines.push(`${BULLET} ${desc}`);
    }
  }
  return lines;
}

// 예방조치 문구 칸은 높이가 고정(noAutofit)이라, 그룹별로 여러 건을 담으면
// 13pt 그대로는 넘칠 수 있다. 관리요령 표와 같은 방식으로, 넘치지 않는
// 한도 안에서 가장 큰 글자 크기를 고른다.
function fitPrecautionFont(lines, usableWidthEmu, usableHeightEmu) {
  if (!lines.length) return PRECAUTION_MAX_FONT_PT;
  for (let fontPt = PRECAUTION_MAX_FONT_PT; fontPt >= PRECAUTION_MIN_FONT_PT; fontPt--) {
    const totalLines = lines.reduce((sum, line) => sum + wrappedLineCount(line, fontPt, usableWidthEmu), 0);
    const needed = totalLines * fontPt * PRECAUTION_LINE_HEIGHT_FACTOR * EMU_PER_PT;
    if (needed <= usableHeightEmu) return fontPt;
  }
  return PRECAUTION_MIN_FONT_PT;
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
// 미리보기(편집 화면)용 데이터 추출 - "DATA 추출" 단계에서 사용
// --------------------------------------------------------------------------

// buildLabelSlide가 표에 그대로 채워 넣을 최종 줄 단위 텍스트를 미리 계산해
// 돌려준다. 사용자가 편집 화면에서 이 문자열들을 직접 수정한 뒤 "PPT 생성"을
// 누르면, 그 편집된 텍스트가 (재계산 없이) 그대로 PPT에 들어간다.
function computeLabelPreview(msds) {
  const phone = (msds.supplierPhone || "").split(",")[0].trim();
  return {
    productName: msds.productName || "",
    signalWord: msds.signalWord || "",
    hazardLines: msds.hazardStatements.slice(0, MAX_HAZARD_BULLETS).map(([, desc]) => `${BULLET} ${desc}`),
    precautionLines: selectPrecautionLines(msds.precaution),
    supplierName: msds.supplierName || "",
    supplierAddress: msds.supplierAddress || "",
    supplierPhone: phone,
    pictogramCodes: pictogramsForHcodes(msds.hazardStatements.map(([c]) => c)),
  };
}

function computeHandlingPreview(msds) {
  return {
    productName: msds.productName || "",
    hazardLines: hazardBulletsForHandling(msds.hazardStatements, msds.classification),
    handlingLines: handlingBullets(msds),
    ppeLines: ppeBullets(msds),
    firstAidLines: firstAidBullets(msds),
    accidentLines: accidentResponseBullets(msds),
    pictogramCodes: pictogramsForHcodes(msds.hazardStatements.map(([c]) => c)),
  };
}

// --------------------------------------------------------------------------
// 템플릿 A: 현장경고표지
// --------------------------------------------------------------------------

// overrides가 주어지면(편집 화면에서 "PPT 생성"을 눌렀을 때) msds 원본 데이터
// 대신 사용자가 수정한 값을 그대로 사용한다. overrides가 없으면(추출 없이
// 바로 생성하는 기존 경로) msds에서 직접 계산한다.
async function buildLabelSlide(msds, overrides = null) {
  const zip = await loadTemplateZip(MSDS_ASSETS.labelTemplate);
  const doc = await getSlideDoc(zip);

  const productName = (overrides && overrides.productName) || msds.productName;

  // 제목: 제품명만 표시한다(구성성분 목록은 별도 요청에 따라 삭제됨).
  // 항상 한 줄로 유지하되, 제품명이 길면 최소 20pt까지 줄인다.
  const rect14 = findShapeByName(doc, "Rectangle 14");
  const txBody14 = txBodyOf(rect14);
  const titleP = allEls(txBody14, NS.a, "p")[0];
  setParagraphText(titleP, productName);
  const rect14Ext = shapeExt(rect14);
  const rect14Width = parseInt(rect14Ext.getAttribute("cx"), 10);
  const bodyPr14 = firstEl(txBody14, NS.a, "bodyPr");
  const lIns14 = parseInt(bodyPr14.getAttribute("lIns") || "90000", 10);
  const rIns14 = parseInt(bodyPr14.getAttribute("rIns") || "90000", 10);
  const titleUsableWidth = rect14Width - lIns14 - rIns14;
  const titleFontPt = fitTitleFont(productName, titleUsableWidth);
  for (const r of allEls(titleP, NS.a, "r")) {
    const rPr = firstEl(r, NS.a, "rPr");
    if (rPr) {
      rPr.setAttribute("sz", String(Math.round(titleFontPt * 100)));
      rPr.setAttribute("b", "1");
    }
  }

  // 표: [신호어 + 그림문자] / [유해ㆍ위험 문구] / [예방조치 문구] / [공급자 정보]
  const tableShape = findTableShape(doc);
  const tbl = firstEl(tableShape, NS.a, "tbl");
  const rows = allEls(tbl, NS.a, "tr");
  const cellsOf = (rowIdx) => allEls(rows[rowIdx], NS.a, "tc");

  // 신호어 (원본이 "신호어 : 해당없음"으로 명시한 문서는 실제로 GHS 미분류
  // 제품이라 신호어가 없는 것이 맞으므로, "경고"로 임의 대체하지 않고 원본
  // 값을 그대로(없으면 빈 칸으로) 반영한다.
  const signalWord = overrides ? (overrides.signalWord || "") : (msds.signalWord || "");
  setParagraphText(firstEl(firstEl(cellsOf(0)[0], NS.a, "txBody"), NS.a, "p"), signalWord);

  const hazardLines = (overrides && overrides.hazardLines) ||
    msds.hazardStatements.slice(0, MAX_HAZARD_BULLETS).map(([, desc]) => `${BULLET} ${desc}`);
  const precautionLines = (overrides && overrides.precautionLines) || selectPrecautionLines(msds.precaution);
  const supplierName = overrides ? overrides.supplierName : msds.supplierName;
  const supplierAddress = overrides ? overrides.supplierAddress : msds.supplierAddress;
  const phone = overrides ? (overrides.supplierPhone || "") : (msds.supplierPhone || "").split(",")[0].trim();
  const supplierLines = [
    `${BULLET} 회사명 : ${supplierName}`,
    `${BULLET} 주소 : ${supplierAddress}`,
    `${BULLET} 연락처 : ${phone}`,
  ];
  const rowLinesMap = { 1: hazardLines, 2: precautionLines, 3: supplierLines };
  for (const idx of [1, 2, 3]) {
    replaceParagraphs(firstEl(cellsOf(idx)[1], NS.a, "txBody"), rowLinesMap[idx]);
  }

  // 세 칸 모두 높이가 고정(noAutofit)이라, 내용이 많으면 13pt 그대로는
  // 넘칠 수 있다. 관리요령 표와 같은 방식으로 칸별로 넘치지 않는 선에서
  // 글자 크기를 줄인다.
  const gridCols = allEls(firstEl(tbl, NS.a, "tblGrid"), NS.a, "gridCol");
  const col1Width = parseInt(gridCols[1].getAttribute("w"), 10);
  for (const idx of [1, 2, 3]) {
    const cellTxBody = firstEl(cellsOf(idx)[1], NS.a, "txBody");
    const bodyPr = firstEl(cellTxBody, NS.a, "bodyPr");
    const tIns = parseInt((bodyPr && bodyPr.getAttribute("tIns")) || "45720", 10);
    const bIns = parseInt((bodyPr && bodyPr.getAttribute("bIns")) || "45720", 10);
    const lIns = parseInt((bodyPr && bodyPr.getAttribute("lIns")) || "91440", 10);
    const rIns = parseInt((bodyPr && bodyPr.getAttribute("rIns")) || "91440", 10);
    const usableWidth = col1Width - lIns - rIns;
    const rowHeight = parseInt(rows[idx].getAttribute("h"), 10);
    const usableHeight = rowHeight - tIns - bIns;
    const fontPt = fitPrecautionFont(rowLinesMap[idx], usableWidth, usableHeight);
    for (const p of allEls(cellsOf(idx)[1], NS.a, "p")) {
      for (const r of allEls(p, NS.a, "r")) {
        const rPr = firstEl(r, NS.a, "rPr");
        if (rPr) rPr.setAttribute("sz", String(Math.round(fontPt * 100)));
      }
    }
  }

  // 그림문자: 표 1번째 행(신호어와 같은 행)의 오른쪽 칸 안에 배치한다.
  const tblXfrm = firstEl(tableShape, NS.p, "xfrm");
  const tblOff = firstEl(tblXfrm, NS.a, "off");
  const tableLeft = parseInt(tblOff.getAttribute("x"), 10);
  const tableTop = parseInt(tblOff.getAttribute("y"), 10);
  const col0Width = parseInt(gridCols[0].getAttribute("w"), 10);
  const row0Height = parseInt(rows[0].getAttribute("h"), 10);
  const picCellLeft = tableLeft + col0Width;
  const codes = (overrides && overrides.pictogramCodes) || pictogramsForHcodes(msds.hazardStatements.map(([c]) => c));
  await applyPictogramSlotsCentered(doc, zip, LABEL_PICTURE_SLOTS, codes, picCellLeft, tableTop, col1Width, row0Height, {
    cellEl: cellsOf(0)[1],
  });

  zip.file(SLIDE_XML_PATH, serializeDoc(doc));
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

// --------------------------------------------------------------------------
// 관리요령 표 본문 글자 크기/행 높이 자동 조정
// --------------------------------------------------------------------------

const HANDLING_BODY_MAX_FONT_PT = 11;
const HANDLING_BODY_MIN_FONT_PT = 8;
const HANDLING_LINE_HEIGHT_FACTOR = 1.2;
const HANDLING_MIN_ROW_HEIGHT_EMU = 500000;
// 표 본문 5개 행(유해성/취급주의/보호구/응급조치/사고대처)의 표 행 인덱스.
const HANDLING_CONTENT_ROWS = [2, 3, 4, 5, 6];

function wrappedLineCount(text, fontPt, usableWidthEmu) {
  if (!text || usableWidthEmu <= 0) return 1;
  const width = estimateTextWidthEmu(text, fontPt);
  return Math.max(1, Math.ceil(width / usableWidthEmu));
}

// 표의 본문 5개 행 글자 크기를 한 번에 정하고, 그 크기에서 각 행에 필요한
// 높이(EMU)를 함께 돌려준다. 문장을 잘라내는 대신(…) 글자 크기를 줄이거나
// (최소 폰트까지) 각 행 높이를 늘려서, 내용이 길어도 인쇄 영역(budgetEmu)
// 안에 온전히 들어오게 한다.
function fitHandlingTableFont(rowLines, usableWidthEmu, tIns, bIns, budgetEmu) {
  const heightsAt = (fontPt) => rowLines.map((lines) => {
    const nLines = lines.reduce((sum, line) => sum + wrappedLineCount(line, fontPt, usableWidthEmu), 0) || 1;
    const h = Math.round(nLines * fontPt * HANDLING_LINE_HEIGHT_FACTOR * EMU_PER_PT) + tIns + bIns;
    return Math.max(h, HANDLING_MIN_ROW_HEIGHT_EMU);
  });
  for (let fontPt = HANDLING_BODY_MAX_FONT_PT; fontPt >= HANDLING_BODY_MIN_FONT_PT; fontPt--) {
    const heights = heightsAt(fontPt);
    if (heights.reduce((a, b) => a + b, 0) <= budgetEmu) return { fontPt, heights };
  }
  // 최소 크기로도 못 맞으면(극단적으로 내용이 많은 경우), 그 크기 그대로
  // 최선의 높이를 돌려준다(약간의 초과는 감수하되, 문장을 잘라내지는 않는다).
  return { fontPt: HANDLING_BODY_MIN_FONT_PT, heights: heightsAt(HANDLING_BODY_MIN_FONT_PT) };
}

// overrides가 주어지면(편집 화면에서 "PPT 생성"을 눌렀을 때) msds 원본 데이터
// 대신 사용자가 수정한 값을 그대로 사용한다.
async function buildHandlingSlide(msds, overrides = null) {
  const zip = await loadTemplateZip(MSDS_ASSETS.handlingTemplate);
  const doc = await getSlideDoc(zip);

  const productName = (overrides && overrides.productName) || msds.productName;

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

  // 제목: 현장경고표지와 동일하게, 제품명 길이에 맞춰 36pt~20pt 사이에서
  // 동적으로 크기를 정한다(예전에는 여기만 28pt 고정이라, 같은 제품명이라도
  // 현장경고표지와 관리요령의 제목 크기가 서로 달라 보이는 문제가 있었다).
  const titleTxBody = firstEl(cellsOf(0)[0], NS.a, "txBody");
  const titleP = firstEl(titleTxBody, NS.a, "p");
  setParagraphText(titleP, productName);
  const titleTcPr = firstEl(cellsOf(0)[0], NS.a, "tcPr");
  const titleLIns = parseInt((titleTcPr && titleTcPr.getAttribute("marL")) || "91440", 10);
  const titleRIns = parseInt((titleTcPr && titleTcPr.getAttribute("marR")) || "91440", 10);
  const titleTableWidth = parseInt(ext0.getAttribute("cx"), 10);
  const titleUsableWidth = titleTableWidth - titleLIns - titleRIns;
  const titleFontPt = fitTitleFont(productName, titleUsableWidth);
  for (const r of allEls(titleP, NS.a, "r")) {
    const rPr = firstEl(r, NS.a, "rPr");
    if (rPr) {
      rPr.setAttribute("sz", String(Math.round(titleFontPt * 100)));
      rPr.setAttribute("b", "1");
    }
  }

  const rowLinesMap = {
    2: (overrides && overrides.hazardLines) || hazardBulletsForHandling(msds.hazardStatements, msds.classification),
    3: (overrides && overrides.handlingLines) || handlingBullets(msds),
    4: (overrides && overrides.ppeLines) || ppeBullets(msds),
    5: (overrides && overrides.firstAidLines) || firstAidBullets(msds),
    6: (overrides && overrides.accidentLines) || accidentResponseBullets(msds),
  };
  for (const idx of HANDLING_CONTENT_ROWS) {
    replaceParagraphs(firstEl(cellsOf(idx)[1], NS.a, "txBody"), rowLinesMap[idx]);
  }

  // 본문 5개 행 글자 크기를 내용 길이에 맞춰 재계산해, 문장을 "…"로 잘라내지
  // 않으면서도 표 전체가 인쇄 영역(슬라이드 하단)을 벗어나지 않도록 한다.
  const bodyPr2 = firstEl(firstEl(cellsOf(2)[1], NS.a, "txBody"), NS.a, "bodyPr");
  const tIns = parseInt((bodyPr2 && bodyPr2.getAttribute("tIns")) || "45720", 10);
  const bIns = parseInt((bodyPr2 && bodyPr2.getAttribute("bIns")) || "45720", 10);
  const lIns = parseInt((bodyPr2 && bodyPr2.getAttribute("lIns")) || "91440", 10);
  const rIns = parseInt((bodyPr2 && bodyPr2.getAttribute("rIns")) || "91440", 10);

  const gridCols = allEls(firstEl(tbl, NS.a, "tblGrid"), NS.a, "gridCol");
  const col1Width = parseInt(gridCols[1].getAttribute("w"), 10);
  const usableWidth = col1Width - lIns - rIns;

  const fixedRowsHeight = rows.reduce((sum, r, i) => (
    HANDLING_CONTENT_ROWS.includes(i) ? sum : sum + parseInt(r.getAttribute("h"), 10)
  ), 0);
  const tableTopNow = parseInt(off0.getAttribute("y"), 10);
  const budget = (HANDLING_SLIDE_HEIGHT_EMU - tableTopNow) - fixedRowsHeight;

  const { fontPt, heights } = fitHandlingTableFont(
    HANDLING_CONTENT_ROWS.map((idx) => rowLinesMap[idx]), usableWidth, tIns, bIns, budget
  );
  HANDLING_CONTENT_ROWS.forEach((idx, i) => {
    rows[idx].setAttribute("h", String(Math.round(heights[i])));
    for (const p of allEls(cellsOf(idx)[1], NS.a, "p")) {
      for (const r of allEls(p, NS.a, "r")) {
        const rPr = firstEl(r, NS.a, "rPr");
        if (rPr) rPr.setAttribute("sz", String(Math.round(fontPt * 100)));
      }
    }
  });
  const newTotalHeight = rows.reduce((sum, r) => sum + parseInt(r.getAttribute("h"), 10), 0);
  ext0.setAttribute("cy", String(newTotalHeight));

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

  const codes = (overrides && overrides.pictogramCodes) || pictogramsForHcodes(msds.hazardStatements.map(([c]) => c));
  await applyPictogramSlotsCentered(doc, zip, HANDLING_PICTURE_SLOTS, codes, tableLeft, picCellTop, tableWidth, row1Height, {
    cellEl: cellsOf(1)[0],
  });

  zip.file(SLIDE_XML_PATH, serializeDoc(doc));
  return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
}
