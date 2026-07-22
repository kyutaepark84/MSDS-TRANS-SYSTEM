// 산업안전보건법 표준 16개 항목(KOSHA) 형식 MSDS 텍스트를 파싱한다.
// msds_ppt_generator/msds_parser.py 의 JS 포팅본 (로직은 최대한 동일하게 유지).
//
// 입력은 파일 경로가 아니라, PDF.js 등으로 이미 추출한 "페이지별 원문 텍스트 배열"이다.

const _BOILERPLATE_PATTERNS = [
  /^\s*물질안전보건자료\s*$/,
  /^\s*페이지\s*[:：]\s*\d+\(\d+\)\s*$/,
  /^\s*SDS\s*번호\s*[:：]/,
  /^\s*최종개정일자\s*[:：]/,
  /^\s*본\s*물질안전보건자료는.*작성\s*$/,
];

const _REVISION_DATE_RE = /최종개정일자\s*[:：]\s*([\d.]+)/;

const _HCODE_RE = /^(H\d{3}(?:\+H\d{3})*)\s*[:：]\s*(.+)$/;
const _PCODE_RE = /^(P\d{3}(?:\+P\d{3})*)\s*[:：]\s*(.+)$/;
const _SECTION_HEADER_RE = /^(\d{1,2})\.\s+(\S.*)$/;
const _SUB_KO_RE = /^([가-힣])\.\s+(.*)$/;
const _CAS_RE = /\d{2,7}-\d{2}-\d/;
const _NUM_SUB_RE = /^(\d)\)\s*(.*)$/;

function isBoilerplate(line) {
  return _BOILERPLATE_PATTERNS.some((re) => re.test(line));
}

// pages: string[] (페이지별 원문 텍스트) -> { text, revisionDate }
function extractRawTextAndRevisionDate(pages) {
  const outPages = [];
  let revisionDate = "";
  for (const pageText of pages) {
    const lines = (pageText || "").split("\n");
    for (const ln of lines) {
      if (!revisionDate) {
        const m = _REVISION_DATE_RE.exec(ln);
        if (m) revisionDate = m[1];
      }
    }
    const kept = lines.map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() && !isBoilerplate(l));
    outPages.push(kept.join("\n"));
  }
  return { text: outPages.join("\n"), revisionDate };
}

function splitSections(fullText) {
  const lines = fullText.split("\n");
  const boundaries = [];
  let expected = 1;
  for (let i = 0; i < lines.length; i++) {
    const m = _SECTION_HEADER_RE.exec(lines[i].trim());
    if (m && parseInt(m[1], 10) === expected && expected <= 16) {
      boundaries.push([i, expected]);
      expected += 1;
    }
  }
  boundaries.push([lines.length, null]);

  const sections = {};
  for (let i = 0; i < boundaries.length - 1; i++) {
    const [start, no] = boundaries[i];
    const [end] = boundaries[i + 1];
    const headerLine = lines[start].trim();
    const headerM = _SECTION_HEADER_RE.exec(headerLine);
    const remainder = headerM[2];
    const bodyLines = [remainder, ...lines.slice(start + 1, end)];
    sections[no] = bodyLines.filter((l) => l.trim()).join("\n");
  }
  return sections;
}

function splitKoSubitems(text) {
  const lines = text.split("\n");
  const boundaries = [];
  for (let i = 0; i < lines.length; i++) {
    const m = _SUB_KO_RE.exec(lines[i].trim());
    if (m) boundaries.push([i, m[1]]);
  }
  if (!boundaries.length) return {};
  boundaries.push([lines.length, null]);
  const out = {};
  for (let i = 0; i < boundaries.length - 1; i++) {
    const [start, key] = boundaries[i];
    const [end] = boundaries[i + 1];
    const m = _SUB_KO_RE.exec(lines[start].trim());
    out[key] = [m[2], ...lines.slice(start + 1, end)].join("\n").trim();
  }
  return out;
}

function splitKoSubitemsTitled(text) {
  const raw = splitKoSubitems(text);
  const out = {};
  for (const key of Object.keys(raw)) {
    const body = raw[key];
    const idx = body.indexOf("\n");
    if (idx === -1) {
      out[key] = [body.trim(), ""];
    } else {
      out[key] = [body.slice(0, idx).trim(), body.slice(idx + 1).trim()];
    }
  }
  return out;
}

function splitKoNumSubitems(text) {
  const lines = text.split("\n");
  const boundaries = [];
  for (let i = 0; i < lines.length; i++) {
    const m = _NUM_SUB_RE.exec(lines[i].trim());
    if (m) boundaries.push([i, m[1]]);
  }
  if (!boundaries.length) return {};
  boundaries.push([lines.length, null]);
  const out = {};
  for (let i = 0; i < boundaries.length - 1; i++) {
    const [start, key] = boundaries[i];
    const [end] = boundaries[i + 1];
    const m = _NUM_SUB_RE.exec(lines[start].trim());
    out[key] = [m[2], ...lines.slice(start + 1, end)].join("\n").trim();
  }
  return out;
}

function collectCodedStatements(text, codeRe) {
  const out = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = codeRe.exec(line);
    if (m) {
      out.push([m[1], m[2].trim()]);
    } else if (out.length) {
      out[out.length - 1][1] = (out[out.length - 1][1] + " " + line).trim();
    }
  }
  return out;
}

function searchAfterLabel(text, labelPattern) {
  const m = new RegExp(`${labelPattern}\\s*[:：]?\\s*(.+)`).exec(text);
  return m ? m[1].trim() : "";
}

function parseProductInfo(section1) {
  let name = "";
  let desc = "";
  const m = /제품명\s*[:：]\s*(.*)/.exec(section1);
  if (m) {
    desc = m[1].trim();
    const idx = section1.indexOf(m[0]);
    const after = section1.slice(idx + m[0].length).split("\n");
    for (const raw of after) {
      const ln = raw.trim();
      if (!ln) continue;
      if (ln.startsWith("나.") || _SUB_KO_RE.test(ln)) break;
      name = ln;
      break;
    }
  }
  const supplierName = searchAfterLabel(section1, "회사명");
  const supplierAddress = searchAfterLabel(section1, "주\\s*소");
  const supplierPhone = searchAfterLabel(section1, "긴급전화번호");
  return { name: name || desc, desc, supplierName, supplierAddress, supplierPhone };
}

const _CLASSIFICATION_LABEL_RE = /^유해성[•·ㆍ]?위험성\s*분류\s*/;

function parseClassification(section2) {
  const sub = splitKoSubitems(section2);
  let body = sub["가"] || "";
  body = body.replace(_CLASSIFICATION_LABEL_RE, "");
  const pairs = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    const m = /^(.+?)\s*[:：]\s*(구분\s*\d+[A-Za-z]?|해당없음|비분류)\s*$/.exec(line);
    if (m) pairs.push([m[1].trim(), m[2].replace(/\s+/g, "")]);
  }
  return pairs;
}

function parsePrecaution(section2) {
  const sub = splitKoSubitems(section2);
  const body = sub["나"] || "";

  const signalM = /신호어\s*(위험|경고)/.exec(body);
  const signalWord = signalM ? signalM[1] : "";

  const hBlockM = /유해[·ㆍ•]위험문구\s*([\s\S]+?)(?=\n\s*4\)|$)/.exec(body);
  const hBlock = hBlockM ? hBlockM[1] : "";
  const hazardStatements = collectCodedStatements(hBlock, _HCODE_RE);

  const pBlockM = /예방조치문구\s*([\s\S]+)$/.exec(body);
  const pBlock = pBlockM ? pBlockM[1] : "";

  const labels = { 가: "prevention", 나: "response", 다: "storage", 라: "disposal" };
  const groupTitles = { prevention: "예방", response: "대응", storage: "저장", disposal: "폐기" };
  const labelRe = /^([가-힣])\)\s*(.*)$/;
  let cur = null;
  const buf = { prevention: [], response: [], storage: [], disposal: [] };
  for (const raw of pBlock.split("\n")) {
    let ln = raw.trim();
    const m = labelRe.exec(ln);
    if (m && labels[m[1]]) {
      cur = labels[m[1]];
      ln = m[2].replace(new RegExp(`^${groupTitles[cur]}\\s*`), "");
      if (!ln) continue;
    }
    if (cur) buf[cur].push(ln);
  }

  const precaution = {};
  for (const key of Object.values(labels)) {
    precaution[key] = collectCodedStatements(buf[key].join("\n"), _PCODE_RE);
  }
  return { signalWord, hazardStatements, precaution };
}

function parseComposition(section3) {
  const out = [];
  for (const raw of section3.split("\n")) {
    const line = raw.trim();
    if (!line || (line.includes("물질명") && line.includes("CAS"))) continue;
    const casM = _CAS_RE.exec(line);
    if (!casM) continue;
    const cas = casM[0];
    const before = line.slice(0, casM.index).trim();
    const after = line.slice(casM.index + cas.length).trim();
    const parts = before.split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    const name = parts[0];
    const contentM = /[<>]?\s*\d[\d.~]*/.exec(after);
    let content;
    if (contentM) content = contentM[0].replace(/\s+/g, "");
    else content = after ? after.split(/\s+/)[0] : "";
    out.push([name, cas, content]);
  }
  return out;
}

function joinWrappedLines(text) {
  const out = [];
  let buf = "";
  for (const raw of text.split("\n")) {
    const ln = raw.trim();
    if (!ln) continue;
    buf = buf ? `${buf} ${ln}`.trim() : ln;
    if (buf.endsWith(".") || buf.endsWith(":") || buf.endsWith("：")) {
      out.push(buf);
      buf = "";
    }
  }
  if (buf) out.push(buf);
  return out;
}

function sentences(text, maxSentences = 4, maxCharsEach = 90) {
  const logicalLines = joinWrappedLines(text);
  const combined = logicalLines.join(" ");
  const parts = combined.trim().split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const s0 of parts.slice(0, maxSentences)) {
    let s = s0;
    if (s.length > maxCharsEach) s = s.slice(0, maxCharsEach).trimEnd() + "…";
    out.push(s);
  }
  return out;
}

function firstSentences(text, maxSentences = 2, maxChars = 90) {
  return sentences(text, maxSentences, maxChars).join(" ");
}

function parseFirstAid(section4) {
  const sub = splitKoSubitemsTitled(section4);
  const mapping = { 가: "eye", 나: "skin", 다: "inhalation", 라: "ingestion", 마: "other" };
  const out = {};
  for (const [k, v] of Object.entries(mapping)) {
    if (sub[k]) {
      const [title, rest] = sub[k];
      out[v] = { label: title, text: firstSentences(rest) };
    }
  }
  return out;
}

function parseFirefighting(section5) {
  const sub = splitKoSubitemsTitled(section5);
  const mapping = { 가: "extinguishing", 나: "hazards", 다: "protective" };
  const out = {};
  for (const [k, v] of Object.entries(mapping)) {
    if (sub[k]) out[v] = firstSentences(sub[k][1], 1, 80);
  }
  return out;
}

function parseAccidentalRelease(section6) {
  const sub = splitKoSubitemsTitled(section6);
  const mapping = { 가: "personal", 나: "environmental", 다: "cleanup" };
  const out = {};
  for (const [k, v] of Object.entries(mapping)) {
    if (sub[k]) out[v] = firstSentences(sub[k][1], 1, 80);
  }
  return out;
}

function parseHandlingStorage(section7) {
  const sub = splitKoSubitemsTitled(section7);
  const mapping = { 가: "handling", 나: "storage" };
  const out = {};
  for (const [k, v] of Object.entries(mapping)) {
    if (sub[k]) out[v] = sentences(sub[k][1], 4, 85);
  }
  return out;
}

function parseExposureControls(section8) {
  const sub = splitKoSubitems(section8);
  const body = sub["다"] || "";
  const inner = splitKoNumSubitems(body);
  const mapping = { 1: "respiratory", 2: "eye", 3: "hand", 4: "body" };
  const out = {};
  for (const [k, v] of Object.entries(mapping)) {
    if (inner[k]) {
      const idx = inner[k].indexOf("\n");
      const rest = idx === -1 ? inner[k].trim() : inner[k].slice(idx + 1).trim();
      out[v] = firstSentences(rest, 1, 80);
    }
  }
  return out;
}

// pages: string[] (PDF.js 등으로 추출한 페이지별 원문) -> MSDSData 형태의 객체
function parseMsds(pages) {
  const { text: raw, revisionDate } = extractRawTextAndRevisionDate(pages);
  const sections = splitSections(raw);

  const data = {
    productName: "",
    productNameDesc: "",
    supplierName: "",
    supplierAddress: "",
    supplierPhone: "",
    classification: [],
    signalWord: "",
    hazardStatements: [],
    precaution: {},
    composition: [],
    firstAid: {},
    firefighting: {},
    accidentalRelease: {},
    handlingStorage: {},
    exposureControls: {},
    revisionDate: "",
  };

  const info = parseProductInfo(sections[1] || "");
  data.productName = info.name;
  data.productNameDesc = info.desc;
  data.supplierName = info.supplierName;
  data.supplierAddress = info.supplierAddress;
  data.supplierPhone = info.supplierPhone;

  data.classification = parseClassification(sections[2] || "");
  const { signalWord, hazardStatements, precaution } = parsePrecaution(sections[2] || "");
  data.signalWord = signalWord;
  data.hazardStatements = hazardStatements;
  data.precaution = precaution;

  data.composition = parseComposition(sections[3] || "");
  data.firstAid = parseFirstAid(sections[4] || "");
  data.firefighting = parseFirefighting(sections[5] || "");
  data.accidentalRelease = parseAccidentalRelease(sections[6] || "");
  data.handlingStorage = parseHandlingStorage(sections[7] || "");
  data.exposureControls = parseExposureControls(sections[8] || "");
  data.revisionDate = revisionDate;

  return data;
}
