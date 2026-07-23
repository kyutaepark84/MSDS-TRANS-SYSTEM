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
  /Page\s+\d+\s+of\b\s*\d*/g,
  /포함된\s*물질[^./]*있음\.?/g,
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
  storage: "안전한\\s*저장\\s*방법(?:\\s*\\([^)]*\\))?",
};
const PPE_LABELS = {
  respiratory: "호흡기\\s*보호",
  eye: "눈\\s*(?:/?\\s*안면)?\\s*보호",
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

function captureAfterLabel(text, labelPattern, maxChars = 150, extraStop = null) {
  const m = new RegExp(`${labelPattern}\\s*[:：]?\\s*`).exec(text);
  if (!m) return "";
  let rest = text.slice(m.index + m[0].length);
  // 레이블 바로 뒤에 붙는 장식용 불릿("- ", "○ ")은 실제 경계가 아니라 그
  // 뒤에 오는 내용 자체의 시작 표시이므로, 캡처 전에 먼저 벗겨낸다. 벗기지
  // 않으면 아래 STOP 판정에서 이 불릿을 "거의 즉시 나온 마커"로 오인해
  // 건너뛰면서, 그 과정에서 실제 내용의 첫 글자까지 함께 삼켜버리게 된다.
  rest = rest.replace(/^\s*[-○]\s*/, "");
  // 첫 STOP 지점이 거의 즉시(빈 캡처 수준)라면 같은 항목의 하위번호
  // (예: "6.2. 환경보호 6.2.1. 대기 : ...")일 가능성이 높으므로 그 마커를
  // 건너뛰고(캡처 시작점도 함께 이동) 다음 STOP까지 계속 찾는다(최대 3회).
  let searchFrom = 0;
  let contentStart = 0;
  let end = rest.length;
  const stopRe = new RegExp(extraStop ? `${_STOP_MATCH_SRC}|${extraStop}` : _STOP_MATCH_SRC);
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
  const stopM = STOP.exec(window_);
  const captured = (stopM ? window_.slice(0, stopM.index) : window_).trim();

  const codeM = /^[A-Za-z][A-Za-z0-9\-]{1,19}/.exec(window_);
  if (codeM) {
    // 코드 바로 뒤에 다음 항목(STOP)이 거의 바로 이어지면(공백만 있고 그
    // 뒤가 바로 "1.2." 같은 다음 항목이면), 이 코드 자체가 제품명 전체다
    // (예: "ST-309\n1.1.1. 제품에 대한 기술 : ..."). 코드 뒤에 괄호나
    // 단어가 더 이어지면 그 코드는 제품명의 시작일 뿐이므로(예: "PN02994
    // (L/C) Green corps cut-off wheel"), 뒤에 이어지는 내용까지 포함해서
    // 캡처한다.
    const gapM = /^\s*/.exec(window_.slice(codeM[0].length));
    if (stopM && codeM[0].length + gapM[0].length >= stopM.index) {
      return codeM[0];
    }
  } else {
    const codeM2 = /[A-Za-z][A-Za-z0-9\-]{1,19}/.exec(captured);
    if (codeM2 && captured.length > codeM2[0].length + 10) return codeM2[0];
  }
  return captured;
}

// 국가번호가 앞에 붙어 4개 조각으로 쓰이는 경우(예: "82-2-3771-4114",
// "82-80-033-4114")와 국내 표기 3개 조각(예: "02-2121-5114")을 모두 포괄
// 하도록, 조각 개수(2~3개의 하이픈)와 각 조각 자릿수(1~4자리)를 넉넉하게
// 잡는다. 너무 좁은 조각 수 고정(예: 정확히 3개 조각만 허용)은 국가번호가
// 붙은 4개 조각 번호에서 앞부분을 잘라먹는 문제를 일으켰다.
const _PHONE_RE = /\d{1,4}(?:[-–]\d{1,4}){2,3}/;

function parseSupplierPhone(section1) {
  for (const label of ["긴급\\s*전화\\s*번호", "긴급연락\\s*전화", "긴급\\s*연락처", "TEL"]) {
    const val = captureAfterLabel(section1, label, 100);
    const m = _PHONE_RE.exec(val);
    if (m) return m[0];
  }
  const m = _PHONE_RE.exec(section1);
  return m ? m[0] : "";
}

// 공급자 정보(1.3)는 "회사명:/주소:/전화:/팩스:/웹사이트/긴급전화번호:" 처럼
// 레이블이 붙은 필드가 한 줄씩 이어지는 문서가 있다. 이런 필드 레이블은
// STOP(번호/불릿) 판정에 걸리지 않아, 그대로 두면 다음 필드 레이블까지
// 통째로 삼켜버린다(예: 회사명이 "한국쓰리엠 주소: 서울특별시 ... 전화: ...
// 긴급전화번호: ..." 전체가 되어버림). 그래서 이 필드들을 캡처할 때는 서로를
// 추가 경계로 함께 써서 다음 레이블 앞에서 멈추도록 한다.
const _SUPPLIER_FIELD_STOP =
  "회사명\\s*[:：]|주\\s*소\\s*[:：]|전화\\s*(?:번호)?\\s*[:：]|팩스\\s*(?:번호)?\\s*[:：]|" +
  "웹\\s*사이트|홈페이지|e-?mail\\s*[:：]|긴급\\s*(?:연락\\s*)?(?:전화|연락처)\\s*(?:번호)?\\s*[:：]?";

function parseSection1(section1) {
  const name = parseProductName(section1);
  let supplierName = "";
  for (const label of ["제조자\\s*정보", "회사명"]) {
    const val = captureAfterLabel(section1, label, 150, _SUPPLIER_FIELD_STOP);
    if (val) {
      supplierName = val;
      break;
    }
  }
  const supplierAddress = captureAfterLabel(section1, "주\\s*소", 120, _SUPPLIER_FIELD_STOP);
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
    if (pairs.length >= 15) break;
  }
  return pairs;
}

function parseSignalWord(section2) {
  const m = /신호어\s*[-:：]?\s*(위험|경고)/.exec(section2);
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
      `(?:(?<![가-힣])[${_ORDINAL_CHARS}]\\)|\\d+\\)|\\d+(?:\\.\\d+)+|[HP]\\d{3}|예방조치문구|응급조치요령|○)`
    );
    const markerM = markerRe.exec(win);
    const candidates = [];
    if (periodM) candidates.push(periodM.index + periodM[0].length);
    if (markerM) candidates.push(markerM.index);
    desc = candidates.length ? win.slice(0, Math.min(...candidates)) : win;
    desc = desc.trim();
    // 일부 문서는 각 코드 항목 앞뒤로 "-" 를 장식용 불릿으로 쓰는데, 마침표
    // 없이 바로 다음 코드로 이어지는 문장의 경우 그 다음 항목의 불릿("- ")까지
    // 함께 캡처되어 끝에 하이픈만 덩그러니 남는 경우가 있어 마지막으로 한 번
    // 더 정리한다.
    desc = desc.replace(/\s*-\s*$/, "").trim();
    out.push([m[0], desc, m.index]);
  }
  return out;
}

function groupPrecautionCodes(section2, pEntries) {
  const groupLabels = { prevention: "예방", response: "대응", storage: "저장", disposal: "폐기" };
  const anchors = [];
  for (const [key, word] of Object.entries(groupLabels)) {
    // 주의: JS의 \b는 ASCII 단어문자 기준이라 한글 뒤에서는 경계로 인식되지
    // 않는다(Python re의 유니코드 \b와 다름) — 여기서는 붙이지 않는다.
    const re = new RegExp(`(?:[${_ORDINAL_CHARS}]\\)|\\d+\\)|\\d+(?:\\.\\d+)+\\.?)\\s*${word}`, "g");
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

function parseComposition(section3, productName = "") {
  section3 = section3.replace(/구성\s*성분의?\s*명칭\s*및\s*함유량/g, "");
  // "이 제품의 물질은 혼합물로 구성"류 안내문(단일물질인 경우 "단일 화학물질로
  // 구성"으로도 쓰임)은 표 앞에 붙는 상투어라, 지우지 않으면 첫 행의 이름
  // 탐색 구간에 걸려 "이"처럼 엉뚱한 글자가 이름으로 잡힌다.
  section3 = section3.replace(/이\s*제품의?\s*물질은\s*(?:단일\s*화학\s*물질로|혼합물로)\s*구성(?:됨|되어\s*있음)?\.?/g, "");
  section3 = section3.replace(/화학\s*물질명|물질명|관용명(?:\s*및\s*이명)?|이명\s*\(관용명\)|이명/g, "");
  // "CAS번호"와 "또는 식별번호"를 하나로 묶어서 지우면, 표 헤더가 두 줄로
  // 나뉘어 추출되는 문서(예: "CAS번호 또는 식별번" 다음 줄에 "호"만 떨어져
  // 나옴)에서 그 사이에 낀 "함유량 (%)" 때문에 통짜 매칭이 실패해 헤더
  // 잔여 글자가 이름으로 오인될 수 있다. 그래서 각각 따로 지운다.
  section3 = section3.replace(/CAS\s*번호/g, "");
  section3 = section3.replace(/또는\s*식별\s*번\s*호?/g, "");
  // "식별번호"가 줄바꿈으로 "식별번"과 "호"로 쪼개져 추출되면, 떨어져 나간
  // "호" 한 글자가 열 순서상 "함유량 (%)" 바로 뒤에 붙어서 나온다. 위에서
  // 못 지운 그 "호"를 여기서 마저 지운다(안 지우면 다음 성분명으로 오인됨).
  section3 = section3.replace(/함유량\s*\(%\)\s*호?/g, "");
  section3 = section3.replace(/단위\s*[:：]\s*\S+/g, "");
  // 영문 표기 문서는 "Cas No. / EU No. / KE No." 처럼 영문 표 헤더를 쓰기도
  // 하는데, 이름을 영문도 허용하도록 넓힌 뒤로는 이 헤더 문구 자체가 이름으로
  // 오인될 수 있어 미리 지운다.
  section3 = section3.replace(/Cas\s*No\.?|EU\s*No\.?|KE\s*No\.?/gi, "");
  if (productName) {
    // 일부 문서는 표 머리말 부근에 제품명(코드)이 워터마크처럼 한 번 더
    // 섞여 들어와 있어(예: "CAS 번호 NC-T30R 크롬 ..."), 본문에서 이미
    // 확인된 제품명과 정확히 같은 문자열이 나오면 이름으로 오인하지 않도록
    // 먼저 지운다.
    const escaped = productName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    section3 = section3.replace(new RegExp(escaped, "g"), "");
  }

  const out = [];
  const casMatches = [...section3.matchAll(_CAS_RE)];
  let prevContentEnd = 0;
  for (let i = 0; i < casMatches.length; i++) {
    const m = casMatches[i];
    // 이름은 "직전 행의 함유량 끝"부터 "이번 CAS 시작"까지의 구간에서 찾는다
    // (단순히 직전 CAS 뒤부터로 잡으면, 표 사이에 낀 "포함된 물질..." 같은
    // 안내문이 함께 걸려 이름으로 오인될 여지가 남아있어 이쪽이 더 좁고 정확).
    const casPrevEnd = i > 0 ? casMatches[i - 1].index + casMatches[i - 1][0].length : 0;
    const beforeStart = Math.max(casPrevEnd, prevContentEnd);
    const before = section3.slice(Math.max(beforeStart, m.index - 60), m.index);
    // 이름은 한글 단어일 수도(NC-T30R 등) 영문 화학명일 수도(휘발유 등) 있다.
    // "관용명/이명" 칸이 바로 뒤에 붙어 있어도(예: "크롬 자료없음", "Ethylbenzene
    // Benzene, ethyl-") 그건 제외하고 화학물질명 칸 하나만 가져와야 하므로,
    // (공백으로 끝나는) 첫 번째 단어류 토큰만 취한다 — 표 안에서 가장 먼저
    // 나오는 이름류 어구가 항상 화학물질명 칸이기 때문이다.
    const nameM = /(?:\d+(?:,\d+)*-)?[A-Za-z가-힣][A-Za-z가-힣0-9\-]*/.exec(before);
    let name = nameM ? nameM[0].trim() : "";
    if (!name || _COMPOSITION_HEADER_NOISE.has(name)) {
      name = KNOWN_CAS_NAMES[m[0]] || name || "";
    }

    const afterEnd = i + 1 < casMatches.length ? casMatches[i + 1].index : section3.length;
    const after = section3.slice(m.index + m[0].length, afterEnd);
    // CAS 번호 뒤에는 "EU번호/식별번호"(예: "231-096-4/KE-21059")가 붙는
    // 경우도, EU번호 없이 "/KE-21971"처럼 식별번호만 슬래시로 바로 붙는
    // 경우도 있어 앞의 EU번호 부분은 있어도 되고 없어도 되게 한다.
    const identifierM = /^\s*(?:\d+-\d+(?:-\d+)?)?\/[A-Z]{1,4}-?\d*\s*/.exec(after);
    const searchArea = identifierM ? after.slice(identifierM[0].length) : after;
    // 함유량 구간(범위) 표기는 "~"(예: "10~30")를 쓰는 문서도, "-"(예: "60 - 70")를
    // 쓰는 문서도 있어 둘 다 구간 구분자로 인정한다.
    const contentM = /[<>]?\s*\d[\d.]*(?:\s*[~\-]\s*\d[\d.]*)?/.exec(searchArea);
    const content = contentM ? contentM[0].replace(/\s+/g, "") : "";
    let contentOffset = (identifierM ? identifierM[0].length : 0) + (contentM ? contentM.index + contentM[0].length : 0);
    // 함유량 뒤에 영문 이명이 괄호로 바로 붙는 경우가 있다(예: "55~65 (Iron)").
    // 그 괄호를 이번 행이 다 삼키고 지나가지 않으면, 다음 CAS의 이름 탐색
    // 구간에 이 괄호가 섞여 들어가 다음 행의 이름으로 잘못 잡힐 수 있다.
    const parenM = /^\s*\([^)]*\)/.exec(after.slice(contentOffset));
    if (parenM) contentOffset += parenM[0].length;
    // 관용명(영문 합성명)이 표 셀 안에서 줄바꿈되면, 그 뒷부분이 이번 행의
    // CAS·함유량 뒤로 밀려나 다음 행 앞에 낀 채로 추출된다(예: "ACTIVATED
    // ALUMINUM"이 한 줄, "OXIDE"가 다음 줄인 셀은 "... 60-70 OXIDE
    // Sodium Aluminum ..." 순서로 나옴). 관용명은 보통 영문 대문자로 쓰이므로,
    // 함유량 뒤에 곧바로 오는 대문자 전용 단어(들)는 이번 행의 잔여 관용명으로
    // 보고 먼저 소비해, 다음 행 이름 탐색 구간에 섞여 들어가지 않게 한다.
    const capsM = /^\s*(?:[A-Z][A-Z.\-]{1,}(?:\s+|$)){1,3}/.exec(after.slice(contentOffset));
    if (capsM) contentOffset += capsM[0].length;
    prevContentEnd = m.index + m[0].length + contentOffset;

    if (name && content) out.push([name, m[0], content]);
  }
  return out;
}

// --------------------------------------------------------------------------
// 파일명 기반 제품명 추출
// --------------------------------------------------------------------------

const _FILENAME_PRODUCT_RE = /MSDS\s*\(([^)]+)\)/i;

// 업로드된 MSDS 파일명이 "...MSDS(제품명)..." 형식을 따르는 경우, 괄호 안의
// 제품명을 그대로 추출한다. 본문에서 뽑아낸 이름은 회사마다 표기가 제각각이라
// 신뢰도가 떨어질 수 있는 반면, 파일명의 제품명은 사내에서 이미 정리해 놓은
// 표준 표기이므로 있으면 이쪽을 우선한다. 이 패턴이 아니면 빈 문자열을 돌려준다.
function extractProductNameFromFilename(filename) {
  const m = _FILENAME_PRODUCT_RE.exec(filename || "");
  return m ? m[1].trim() : "";
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
function parseMsds(pages, sourceFilename = "") {
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

  // 파일명이 "...MSDS(제품명)..." 형식을 따르면, 본문에서 뽑아낸 이름보다
  // 파일명의 제품명을 우선한다(회사에서 이미 정리해 둔 표준 표기이기 때문).
  const filenameProduct = extractProductNameFromFilename(sourceFilename);
  if (filenameProduct) data.productName = filenameProduct;

  const { signalWord, classification, hazardStatements, precaution } = parseSection2(sections[2] || "");
  data.signalWord = signalWord;
  data.classification = classification;
  data.hazardStatements = hazardStatements;
  data.precaution = precaution;

  data.composition = parseComposition(sections[3] || "", data.productName);
  data.firstAid = parseFirstAid(sections[4] || "");
  data.firefighting = parseFirefighting(sections[5] || "");
  data.accidentalRelease = parseAccidentalRelease(sections[6] || "");
  data.handlingStorage = parseHandlingStorage(sections[7] || "");
  data.exposureControls = parseExposureControls(sections[8] || "");
  data.revisionDate = revisionDate;

  return data;
}
