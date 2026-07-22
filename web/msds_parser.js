// 산업안전보건법 표준 16개 항목(KOSHA) 형식 MSDS 텍스트를 파싱한다.
// msds_ppt_generator/msds_parser.py 의 JS 포팅본 (로직은 최대한 동일하게 유지).
//
// 회사마다 다른 두 가지 서식 차이(하위항목이 "가./나." 한글 표기인 경우와
// "1.1./2.2.4.1." 소수점 번호 체계인 경우)를 모두 견디기 위해, 페이지 텍스트를
// 공백 하나로 정규화한 "flat text"를 만든 뒤 1) 대항목은 법정 표준 제목 문구로
// 위치를 찾고 2) 개별 필드는 레이블 뒤 텍스트를 직접 정규식으로 캡처한다
// (하위번호 체계나 원본 줄바꿈 유무에 의존하지 않음).
//
// 입력은 파일 경로가 아니라, PDF.js 등으로 이미 추출한 "페이지별 원문 텍스트 배열"이다.

const SEP = "[·ㆍ•・∙]"; // 가운뎃점 표기 변형

const SECTION_TITLE_PATTERNS = {
  1: "화학제품과\\s*회사에\\s*관한\\s*정보",
  2: `유해성?\\s*${SEP}?\\s*위험성`,
  3: "구성\\s*성분의?\\s*명칭\\s*및\\s*함유량",
  4: "응급\\s*조치\\s*요령",
  5: `폭발\\s*${SEP}?\\s*화재\\s*시\\s*대처\\s*방법`,
  6: "누출\\s*사고\\s*시\\s*대처\\s*방법",
  7: "취급\\s*및\\s*저장\\s*방법",
  8: "노출\\s*방지\\s*및\\s*개인\\s*보호구",
  9: `물리\\s*${SEP}?\\s*화학적\\s*특성`,
  10: "안정성\\s*및\\s*반응성",
  11: "독성에\\s*관한\\s*정보",
  12: "환경에\\s*미치는\\s*영향",
  13: "폐기\\s*시?\\s*주의사항",
  14: "운송에\\s*필요한\\s*정보",
  15: "법적\\s*규제\\s*현황",
  16: "(?:그\\s*밖의|기타)\\s*참고사항",
};

const _REVISION_DATE_RE = /최종개정일자\s*[:：]\s*([\d.]+)/;
const _HCODE_RE = /H\d{3}(?:\+H\d{3})*/g;
const _PCODE_RE = /P\d{3}(?:\+P\d{3})*/g;
const _CAS_RE = /\d{2,7}-\d{2}-\d/g;

// 한글 순서 마커로 실제 쓰이는 글자만(임의의 한글 한 글자가 ")"/"." 앞에 오는
// 경우까지 마커로 오인하지 않도록 범위를 좁힌다. 예: "신경계통)" 오탐 방지.
const _ORDINAL_CHARS = "가나다라마바사아자차카타파하";
const STOP = new RegExp(
  `(?=[${_ORDINAL_CHARS}]\\.\\s|\\d+\\)|\\d+(?:\\.\\d+)+\\.?|-\\s+\\S|○\\s*\\S|$)`
);
const _STOP_MATCH_SRC = `[${_ORDINAL_CHARS}]\\.\\s|\\d+\\)|\\d+(?:\\.\\d+)+\\.?|-\\s+\\S|○\\s*\\S`;

const _BOILERPLATE_PATTERNS = [
  /물\s*질\s*안\s*전\s*보\s*건\s*자\s*료\s*\(Material Safety Data Sheets\)\s*문서번호\s*\S+\s*개정번호\s*\S+\s*개정일자\s*[\d.\s]+년?월?일?/g,
  /물질안전보건자료(?=\s|$)/g,
  /페이지\s*[:：]\s*\d+\(\d+\)/g,
  /SDS\s*번호\s*[:：]\s*\S+/g,
  /최종개정일자\s*[:：]\s*[\d.]+/g,
  /본\s*물질안전보건자료는\s*산업안전보건법\s*및\s*시행규칙에\s*의거하여\s*작성/g,
  /\S{1,20}\s+\d+\s*페이지\s*중\s*\d+\s*페이지\s*MSDS-\S+\s*\(rev\.\d+\)/g,
];

// 자주 쓰이는 합금/용접재료 원소의 CAS 번호 -> 이름. 표 제목 등 잡음 단어가
// 구성성분명으로 잘못 잡혔을 때의 안전망으로만 사용한다.
const KNOWN_CAS_NAMES = {
  "7439-89-6": "철", "7440-47-3": "크롬", "7440-02-0": "니켈",
  "7439-96-5": "망간", "7440-50-8": "구리", "7440-21-3": "실리콘",
  "7440-03-1": "니오븀", "7440-31-5": "주석", "7440-33-7": "텅스텐",
  "7440-48-4": "코발트", "7439-95-4": "마그네슘", "7429-90-5": "알루미늄",
};
const _COMPOSITION_HEADER_NOISE = new Set([
  "단위", "함유량", "물질명", "화학물질명", "이명", "비고", "성분명", "구성성분",
]);

const FIRST_AID_LABELS = {
  eye: "눈에\\s*들어갔을\\s*때",
  skin: "피부에\\s*접촉(?:했|되었)을\\s*때",
  inhalation: "흡입(?:했|하였)을\\s*때",
  ingestion: "(?:먹었을\\s*때|섭취(?:했|하였)을\\s*때)",
};
const FIREFIGHTING_LABELS = {
  extinguishing: "(?:적절한|절적한)\\s*(?:\\(및\\s*부적절한\\))?\\s*소화제",
  hazards: "화학물질로부터\\s*생기는\\s*특정\\s*유해성",
  protective: "(?:화재\\s*진압\\s*시|화재진압시)\\s*착용할\\s*보호구(?:\\s*및\\s*예방조치)?",
};
const ACCIDENTAL_RELEASE_LABELS = {
  personal: "인체를\\s*보호하기\\s*위해\\s*필요한\\s*조치\\s*사?항?(?:\\s*및\\s*보호구)?",
  environmental: "환경을\\s*보호하기\\s*위해\\s*필요한\\s*조치\\s*사?항?",
  cleanup: "정화\\s*또는\\s*제거\\s*방법?",
};
const HANDLING_STORAGE_LABELS = {
  handling: "안전\\s*취급\\s*요령",
  storage: "안전한\\s*저장\\s*방법",
};
const PPE_LABELS = {
  respiratory: "호흡기\\s*보호",
  eye: "눈\\s*/?\\s*안면\\s*보호",
  hand: "손\\s*보호",
  body: "신체\\s*보호",
};

// --------------------------------------------------------------------------
// 텍스트 추출 및 정규화
// --------------------------------------------------------------------------

function stripBoilerplate(text) {
  for (const re of _BOILERPLATE_PATTERNS) {
    text = text.replace(re, " ");
  }
  return text;
}

// pages: string[] (PDF.js 등으로 추출한 페이지별 원문 텍스트) -> { flat, revisionDate }
function extractFlatText(pages) {
  let revisionDate = "";
  for (const pageText of pages) {
    if (revisionDate) break;
    const m = _REVISION_DATE_RE.exec(pageText || "");
    if (m) revisionDate = m[1];
  }
  let full = pages.join("\n");
  full = stripBoilerplate(full);
  let flat = full.replace(/[ \t]+/g, " ");
  flat = flat.replace(/\n+/g, " ");
  flat = flat.replace(/ +/g, " ").trim();
  return { flat, revisionDate };
}

function splitSections(flatText) {
  const boundaries = [];
  let expected = 1;
  let pos = 0;
  while (expected <= 16) {
    const pat = new RegExp(`${expected}\\.\\s*${SECTION_TITLE_PATTERNS[expected]}`);
    const m = pat.exec(flatText.slice(pos));
    if (!m) break;
    boundaries.push([pos + m.index, expected]);
    pos = pos + m.index + m[0].length;
    expected += 1;
  }
  boundaries.push([flatText.length, null]);

  const sections = {};
  for (let i = 0; i < boundaries.length - 1; i++) {
    const [start, no] = boundaries[i];
    const end = boundaries[i + 1][0];
    sections[no] = flatText.slice(start, end);
  }
  return sections;
}

// --------------------------------------------------------------------------
// 레이블 뒤 텍스트 캡처 공용 유틸
// --------------------------------------------------------------------------

function captureAfterLabel(text, labelPattern, maxChars = 150) {
  const m = new RegExp(`${labelPattern}\\s*[:：]?\\s*`).exec(text);
  if (!m) return "";
  const rest = text.slice(m.index + m[0].length);
  // 첫 STOP 지점이 거의 즉시(빈 캡처 수준)라면 같은 항목의 하위번호
  // (예: "6.2. 환경보호 6.2.1. 대기 : ...")일 가능성이 높으므로 그 마커를
  // 건너뛰고(캡처 시작점도 함께 이동) 다음 STOP까지 계속 찾는다(최대 3회).
  let searchFrom = 0;
  let contentStart = 0;
  let end = rest.length;
  const stopRe = new RegExp(_STOP_MATCH_SRC);
  for (let i = 0; i < 3; i++) {
    const stopM = stopRe.exec(rest.slice(searchFrom));
    if (!stopM) {
      end = rest.length;
      break;
    }
    if (stopM.index < 3) {
      searchFrom += stopM.index + stopM[0].length;
      contentStart = searchFrom;
      continue;
    }
    end = searchFrom + stopM.index;
    break;
  }
  end = Math.min(end, contentStart + maxChars);
  return rest.slice(contentStart, end).trim();
}

function sentences(text, maxSentences = 4, maxCharsEach = 90) {
  const parts = text.trim().split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const p0 of parts.slice(0, maxSentences)) {
    let p = p0;
    if (p.length > maxCharsEach) p = p.slice(0, maxCharsEach).trimEnd() + "…";
    out.push(p);
  }
  return out;
}

function firstSentences(text, maxSentences = 2, maxChars = 90) {
  return sentences(text, maxSentences, maxChars).join(" ");
}

// --------------------------------------------------------------------------
// 섹션 1: 제품/공급자 정보
// --------------------------------------------------------------------------

function parseProductName(section1) {
  const m = /제품명\s*[:：]?\s*/.exec(section1);
  if (!m) return "";
  const window_ = section1.slice(m.index + m[0].length, m.index + m[0].length + 60);
  const codeM = /^[A-Za-z][A-Za-z0-9\-]{1,19}/.exec(window_);
  if (codeM) return codeM[0];
  const stopM = STOP.exec(window_);
  const captured = (stopM ? window_.slice(0, stopM.index) : window_).trim();
  const codeM2 = /[A-Za-z][A-Za-z0-9\-]{1,19}/.exec(captured);
  if (codeM2 && captured.length > codeM2[0].length + 10) return codeM2[0];
  return captured;
}

const _PHONE_RE = /\d{2,4}[-–]\d{3,4}[-–]\d{4}/;

function parseSupplierPhone(section1) {
  for (const label of ["긴급\\s*전화\\s*번호", "긴급연락\\s*전화", "긴급\\s*연락처", "TEL"]) {
    const val = captureAfterLabel(section1, label, 100);
    const m = _PHONE_RE.exec(val);
    if (m) return m[0];
  }
  const m = _PHONE_RE.exec(section1);
  return m ? m[0] : "";
}

function parseSection1(section1) {
  const name = parseProductName(section1);
  let supplierName = "";
  for (const label of ["제조자\\s*정보", "회사명"]) {
    const val = captureAfterLabel(section1, label);
    if (val) {
      supplierName = val;
      break;
    }
  }
  const supplierAddress = captureAfterLabel(section1, "주\\s*소", 120);
  const supplierPhone = parseSupplierPhone(section1);
  return { name, supplierName, supplierAddress, supplierPhone };
}

// --------------------------------------------------------------------------
// 섹션 2: 유해성・위험성 (분류, 신호어, H-code, P-code)
// --------------------------------------------------------------------------

function parseClassification(section2) {
  const body = section2.replace(new RegExp(`유해성?${SEP}?\\s*위험성\\s*분류`), "");
  const pairs = [];
  const re = /([가-힣][가-힣0-9()\-/\s]{1,30}?)\s*[:：]?\s*구분\s*(\d+)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    pairs.push([m[1].trim(), `구분${m[2]}`]);
    if (pairs.length >= 8) break;
  }
  return pairs;
}

function parseSignalWord(section2) {
  const m = /신호어\s*[:：]?\s*(위험|경고)/.exec(section2);
  return m ? m[1] : "";
}

function extractCodedStatements(text, codeRe, maxChars = 150) {
  const matches = [...text.matchAll(codeRe)];
  const out = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const mEnd = m.index + m[0].length;
    const rest = text.slice(mEnd);
    const colonM = /^\s*[:：]?\s*/.exec(rest);
    const descStart = mEnd + colonM[0].length;
    const naturalEnd = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const descEnd = Math.min(naturalEnd, descStart + maxChars);
    let desc = text.slice(descStart, descEnd);
    // 문장 끝(마침표) 또는 다음 소항목 마커(그룹 표제 등 포함)에서 한번 더 잘라,
    // 코드 사이에 낀 그룹 표제나 다음 섹션 텍스트가 섞이지 않게 한다.
    const win = desc.slice(0, 90);
    const periodM = /[.!?]/.exec(win);
    const markerRe = new RegExp(
      `(?:(?<![가-힣])[${_ORDINAL_CHARS}]\\)|\\d+\\)|\\d+(?:\\.\\d+)+|[HP]\\d{3}|예방조치문구|응급조치요령)`
    );
    const markerM = markerRe.exec(win);
    const candidates = [];
    if (periodM) candidates.push(periodM.index + periodM[0].length);
    if (markerM) candidates.push(markerM.index);
    desc = candidates.length ? win.slice(0, Math.min(...candidates)) : win;
    out.push([m[0], desc.trim(), m.index]);
  }
  return out;
}

function groupPrecautionCodes(section2, pEntries) {
  const groupLabels = { prevention: "예방", response: "대응", storage: "저장", disposal: "폐기" };
  const anchors = [];
  for (const [key, word] of Object.entries(groupLabels)) {
    // 주의: JS의 \b는 ASCII 단어문자 기준이라 한글 뒤에서는 경계로 인식되지
    // 않는다(Python re의 유니코드 \b와 다름) — 여기서는 붙이지 않는다.
    const re = new RegExp(`(?:[${_ORDINAL_CHARS}]\\)|\\d+(?:\\.\\d+)+\\.?)\\s*${word}`, "g");
    let m;
    while ((m = re.exec(section2)) !== null) {
      anchors.push([m.index, key]);
    }
  }
  anchors.sort((a, b) => a[0] - b[0]);
  const result = { prevention: [], response: [], storage: [], disposal: [] };
  for (const [code, desc, pos] of pEntries) {
    let cur = null;
    for (const [aPos, aKey] of anchors) {
      if (aPos <= pos) cur = aKey;
      else break;
    }
    if (cur) result[cur].push([code, desc]);
  }
  return result;
}

function parseSection2(section2) {
  const signalWord = parseSignalWord(section2);
  const classification = parseClassification(section2);
  const hazardStatements = extractCodedStatements(section2, _HCODE_RE).map(([c, d]) => [c, d]);
  const pEntries = extractCodedStatements(section2, _PCODE_RE);
  const precaution = groupPrecautionCodes(section2, pEntries);
  return { signalWord, classification, hazardStatements, precaution };
}

// --------------------------------------------------------------------------
// 섹션 3: 구성성분
// --------------------------------------------------------------------------

function parseComposition(section3) {
  section3 = section3.replace(/구성\s*성분의?\s*명칭\s*및\s*함유량/g, "");
  section3 = section3.replace(/화학\s*물질명|물질명|이명\s*\(관용명\)|이명/g, "");
  const out = [];
  const casMatches = [...section3.matchAll(_CAS_RE)];
  for (let i = 0; i < casMatches.length; i++) {
    const m = casMatches[i];
    const beforeStart = i > 0 ? casMatches[i - 1].index + casMatches[i - 1][0].length : 0;
    const before = section3.slice(Math.max(beforeStart, m.index - 40), m.index);
    const nameM = /[가-힣]+/.exec(before);
    let name = nameM ? nameM[0] : "";
    if (!name || _COMPOSITION_HEADER_NOISE.has(name)) {
      name = KNOWN_CAS_NAMES[m[0]] || name || "";
    }

    const afterEnd = i + 1 < casMatches.length ? casMatches[i + 1].index : section3.length;
    const after = section3.slice(m.index + m[0].length, afterEnd);
    const euM = /^\s*\d+-\d+(?:-\d+)?\/[A-Z]{1,4}-?\d*\s*/.exec(after);
    const searchArea = euM ? after.slice(euM[0].length) : after;
    const contentM = /[<>]?\s*\d[\d.]*(?:\s*~\s*\d[\d.]*)?/.exec(searchArea);
    const content = contentM ? contentM[0].replace(/\s+/g, "") : "";
    if (name && content) out.push([name, m[0], content]);
  }
  return out;
}

// --------------------------------------------------------------------------
// 섹션 4~8: 응급조치/화재/누출/취급저장/보호구
// --------------------------------------------------------------------------

function parseFirstAid(section4) {
  const out = {};
  for (const [key, label] of Object.entries(FIRST_AID_LABELS)) {
    const m = new RegExp(label).exec(section4);
    if (!m) continue;
    const captured = captureAfterLabel(section4, label, 200);
    out[key] = { label: m[0], text: firstSentences(captured) };
  }
  return out;
}

function parseFirefighting(section5) {
  const out = {};
  for (const [key, label] of Object.entries(FIREFIGHTING_LABELS)) {
    if (!new RegExp(label).test(section5)) continue;
    const captured = captureAfterLabel(section5, label, 150);
    out[key] = firstSentences(captured, 1, 80);
  }
  return out;
}

function parseAccidentalRelease(section6) {
  const out = {};
  for (const [key, label] of Object.entries(ACCIDENTAL_RELEASE_LABELS)) {
    if (!new RegExp(label).test(section6)) continue;
    const captured = captureAfterLabel(section6, label, 150);
    out[key] = firstSentences(captured, 1, 80);
  }
  return out;
}

function parseHandlingStorage(section7) {
  const out = {};
  for (const [key, label] of Object.entries(HANDLING_STORAGE_LABELS)) {
    if (!new RegExp(label).test(section7)) continue;
    const captured = captureAfterLabel(section7, label, 400);
    out[key] = sentences(captured, 4, 85);
  }
  return out;
}

function parseExposureControls(section8) {
  const out = {};
  for (const [key, label] of Object.entries(PPE_LABELS)) {
    if (!new RegExp(label).test(section8)) continue;
    const captured = captureAfterLabel(section8, label, 200);
    out[key] = firstSentences(captured, 1, 80);
  }
  return out;
}

// --------------------------------------------------------------------------
// 진입점
// --------------------------------------------------------------------------

// pages: string[] (PDF.js 등으로 추출한 페이지별 원문) -> MSDSData 형태의 객체
function parseMsds(pages) {
  const { flat, revisionDate } = extractFlatText(pages);
  const sections = splitSections(flat);

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

  const info = parseSection1(sections[1] || "");
  data.productName = info.name;
  data.supplierName = info.supplierName;
  data.supplierAddress = info.supplierAddress;
  data.supplierPhone = info.supplierPhone;

  const { signalWord, classification, hazardStatements, precaution } = parseSection2(sections[2] || "");
  data.signalWord = signalWord;
  data.classification = classification;
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
