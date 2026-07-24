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

const SEP = "[·ㆍ•・∙,]"; // 가운뎃점 표기 변형(쉼표로 쓰는 문서도 있음)

const SECTION_TITLE_PATTERNS = {
  1: "화학제품과\\s*회사에\\s*관한\\s*정보",
  2: `유해성?\\s*${SEP}?\\s*위험성`,
  3: "구성\\s*성분의?\\s*명칭\\s*및\\s*함유량",
  4: "응급\\s*조치\\s*요령",
  5: `폭발\\s*${SEP}?\\s*화재\\s*시\\s*대처\\s*방법`,
  6: "누출\\s*사고\\s*시\\s*대처\\s*방법",
  7: "취급\\s*및\\s*저장\\s*(?:방법|밥법)", // 원본에 "방법"이 "밥법"으로 오타난 문서가 있음
  8: "노출\\s*방지\\s*및\\s*개인\\s*보호구",
  9: `물리\\s*${SEP}?\\s*화학적\\s*특(?:성|징)`,
  10: "안정성\\s*및\\s*반응성",
  11: "독성에\\s*관한\\s*정보",
  12: "환경에\\s*미치는\\s*영향",
  13: "폐기\\s*시?\\s*주의사항",
  14: "운송에\\s*필요한\\s*정(?:보|도)",
  15: "법적\\s*규제\\s*현황",
  16: "(?:그\\s*밖(?:의|에)|기타)\\s*참고사항",
};

const _REVISION_DATE_RE = /최종개정일자\s*[:：]\s*([\d.]+)/;
const _HCODE_RE = /H\d{3}(?:\+H\d{3})*/g;
const _PCODE_RE = /P\d{3}(?:\+P\d{3})*/g;
const _CAS_RE = /\d{2,7}-\d{2}-\d/g;

// 한글 순서 마커로 실제 쓰이는 글자만(임의의 한글 한 글자가 ")"/"." 앞에 오는
// 경우까지 마커로 오인하지 않도록 범위를 좁힌다. 예: "신경계통)" 오탐 방지.
const _ORDINAL_CHARS = "가나다라마바사아자차카타파하";
// 한글 순서 마커가 "가."(마침표) 대신 "가)"(괄호)로 쓰이는 문서도 있다.
const STOP = new RegExp(
  `(?=[${_ORDINAL_CHARS}]\\.\\s|[${_ORDINAL_CHARS}]\\)|\\d+\\)|\\d+(?:\\.\\d+)+\\.?|-\\s+\\S|○\\s*\\S|$)`
);
const _STOP_MATCH_SRC = `[${_ORDINAL_CHARS}]\\.\\s|[${_ORDINAL_CHARS}]\\)|\\d+\\)|\\d+(?:\\.\\d+)+\\.?|-\\s+\\S|○\\s*\\S`;

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
  /\S+\(MSDS\)\s+\d+\/\d+/g, // 쪽 하단 "제품명(MSDS)   2/6" 식 꼬리말
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
// 콜론 없이 레이블만 쓰는 문서도 있어(예: "회사명 제일연마공업㈜ 주소 경북 ...")
// 콜론을 필수로 요구하지 않는다.
const _SUPPLIER_FIELD_STOP =
  "회사명\\s*[:：]?|주\\s*소\\s*[:：]?|전화\\s*(?:번호)?\\s*[:：]?|팩스\\s*(?:번호)?\\s*[:：]?|" +
  "웹\\s*사이트|홈페이지|e-?mail\\s*[:：]?|긴급\\s*(?:연락\\s*)?(?:전화|연락처)\\s*(?:번호)?\\s*[:：]?";

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
  // 섹션 제목 자체("2.유해성, 위험성")도 "유해성...위험성"을 포함하고 있어,
  // 먼저 이 제목 앞부분을 지워야 그 안의 "위험성"이 뒤 "가)유해성,위험성
  // 분류"를 지운 자리에 잔여 글자로 남아 분류명 앞에 잘못 붙지 않는다.
  let body = section2.replace(new RegExp(`^\\s*2\\.\\s*${SECTION_TITLE_PATTERNS[2]}`), "");
  // "가)유해성,위험성 분류"처럼 앞에 한글 순서 마커가 바로 붙어 있는 문서가
  // 있어, 그 마커도 함께 지워야 뒤이은 첫 분류명이 마커/제목 잔여 글자를
  // 덧붙인 채로 잡히지 않는다.
  body = body.replace(
    new RegExp(`(?:[${_ORDINAL_CHARS}]\\)|[${_ORDINAL_CHARS}]\\.\\s)?\\s*유해성?${SEP}?\\s*위험성\\s*분류`),
    ""
  );
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
      `(?:(?<![가-힣])[${_ORDINAL_CHARS}]\\)|\\d+\\)|\\d+(?:\\.\\d+)+|[HP]\\d{3}|예방조치\\s*문구|응급조치요령|○)`
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
  if (!anchors.length) {
    // 일부 문서는 "가)/나)" 같은 전용 순서 마커 없이 "예방조치 문구/대응/
    // 저장/폐기"처럼 필드명만으로 그룹을 구분한다("예방"은 "예방조치 문구"로
    // 나타남). 그런 문서에서는 위 마커-앞잡이 방식으로 앵커를 하나도 못
    // 찾으므로, 순서 마커 없이 레이블 단어 자체를 경계로 쓴다(\b 대신
    // 한글 전후 lookaround로 "고립된 단어"만 매치되게 한다).
    const bareGroupLabels = { prevention: "예방(?:조치\\s*문구)?", response: "대응", storage: "저장", disposal: "폐기" };
    for (const [key, word] of Object.entries(bareGroupLabels)) {
      const re = new RegExp(`(?<![가-힣])(?:${word})(?![가-힣])`, "g");
      let m;
      while ((m = re.exec(section2)) !== null) {
        anchors.push([m.index, key]);
      }
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

// 화학물질명 뒤에 "관용명/이명" 칸이 바로 붙어 있는 문서가 많아(예: "크롬
// 자료없음", "Toluene Methylbenzene"), 단어 표기 형태(대소문자 등)만으로는
// "다음 단어가 화학물질명의 연장인지 관용명 칸의 시작인지"를 안정적으로 구분할
// 수 없다(실제로 시도했다가 휘발유 문서에서 관용명이 이름에 잘못 붙는 회귀가
// 발생함: "Toluene"의 관용명 "Methylbenzene"도 Title Case라 이름처럼 보임).
// 그래서 "그 다음 단어가 원소명이거나 화합물 접미어일 때만" 이어붙인다 — 이건
// 화학물질명이 "원소/화합물류"일 때만 참이 되는 좁고 안전한 신호라, "알루미늄
// 산화물"/"Sodium Aluminum Hexafluoride" 같은 진짜 여러 단어 이름은 온전히
// 잡히면서도 "자료없음"/"Methylbenzene" 같은 관용명은 걸러진다.
const _COMPOSITION_CONTINUATION_WORDS_KO = new Set([
  "산화물", "수산화물", "과산화물", "황산염", "황화물", "아황산염", "염화물",
  "불화물", "브롬화물", "요오드화물", "질산염", "아질산염", "탄산염", "중탄산염",
  "인산염", "아인산염", "규산염", "붕산염", "크롬산염", "중크롬산염", "시안화물",
  "초산염", "아세트산염", "수화물", "화합물", "합금",
  "알루미늄", "나트륨", "칼륨", "칼슘", "마그네슘", "철", "구리", "아연", "니켈",
  "크롬", "망간", "코발트", "주석", "납", "은", "금", "백금", "티타늄", "규소",
  "붕소", "인", "황", "염소", "불소", "브롬", "요오드", "탄소", "질소", "수소", "산소",
]);
const _COMPOSITION_CONTINUATION_WORDS_EN = new Set([
  "oxide", "hydroxide", "peroxide", "sulfate", "sulfite", "sulfide", "chloride",
  "fluoride", "hexafluoride", "tetrafluoride", "trifluoride", "bromide", "iodide",
  "nitride", "nitrate", "nitrite", "carbonate", "bicarbonate", "phosphate",
  "phosphide", "phosphite", "silicate", "borate", "chromate", "dichromate",
  "permanganate", "cyanide", "acetate", "oxalate", "arsenate", "arsenide",
  "selenide", "selenate", "telluride", "azide", "hydride", "carbide", "silicide",
  "boride", "amide", "imide", "monoxide", "dioxide", "trioxide",
  "sodium", "potassium", "calcium", "magnesium", "aluminum", "aluminium", "iron",
  "copper", "zinc", "nickel", "chromium", "manganese", "cobalt", "tin", "lead",
  "silver", "gold", "platinum", "titanium", "silicon", "boron", "phosphorus",
  "sulfur", "chlorine", "fluorine", "bromine", "iodine", "carbon", "nitrogen",
  "hydrogen", "oxygen", "barium", "lithium", "strontium", "tungsten", "molybdenum",
  "vanadium", "zirconium", "cadmium", "arsenic", "antimony", "bismuth", "mercury",
]);

const _COMPOSITION_NAME_FIRST_RE = /(?:\d+(?:,\d+)*-)?[A-Za-z가-힣][A-Za-z가-힣0-9\-]*/;

function extractCompositionName(before) {
  const firstM = _COMPOSITION_NAME_FIRST_RE.exec(before);
  if (!firstM) return "";
  const words = [firstM[0]];
  const isKorean = /^[가-힣]/.test(words[0]);
  const allowed = isKorean ? _COMPOSITION_CONTINUATION_WORDS_KO : _COMPOSITION_CONTINUATION_WORDS_EN;
  const rest = before.slice(firstM.index + firstM[0].length);
  for (const wordM of rest.matchAll(/\s+(\S+)/g)) {
    const token = wordM[1];
    const key = isKorean ? token : token.toLowerCase();
    if (!allowed.has(key)) break;
    words.push(token);
  }
  return words.join(" ").trim();
}

const _CAS_HEADER_RE = /CAS\s*[.\s]*(?:번호|No\.?|NO)?/i;

function parseCompositionReversed(section3) {
  // 일부 문서는 표 열 순서가 "구성(역할) | 명칭 | 함유량(%) | CAS.NO"라서
  // 함유량이 CAS보다 먼저 나오고(다른 문서 대부분과 반대), CAS가 없는 혼합물
  // 행은 그 자리에 "혼합물"/"자료없음" 같은 자리표시자가 온다(예: "연마재
  // ALUNDUM 70~80% 1344-28-1", "본드 Cured resin 10~20% 혼합물"). "구성"
  // (연마재/본드/충진제/보강제 등 역할 분류로, 화학물질명이 아님) 다음에 오는
  // "명칭"칸을 화학물질명으로 취한다.
  section3 = section3.replace(/구성|명칭|함유량(?:\s*\(?%\)?)?|CAS\s*[.\s]*(?:번호|No\.?|NO)?/gi, "");
  const out = [];
  // 맨 앞 "구성"(역할: 연마재/본드/충진제/보강제 등)은 항상 한글 단어이므로,
  // 남아있는 절 번호("3.") 같은 잡문자를 역할 칸으로 잘못 집지 않도록
  // \S+ 대신 한글 전용으로 좁힌다.
  const pattern = /[가-힣]+\s+(.+?)\s*(\d[\d.]*(?:\s*~\s*\d[\d.]*)?)\s*%\s*(\d{2,7}-\d{2}-\d|혼합물|자료없음)/g;
  for (const m of section3.matchAll(pattern)) {
    const name = m[1].trim();
    const content = m[2].replace(/\s+/g, "");
    const cas = m[3];
    if (name) out.push([name, cas, content]);
  }
  return out;
}

function parseComposition(section3, productName = "") {
  section3 = section3.replace(/구성\s*성분의?\s*명칭\s*및\s*함유량/g, "");
  // 표 헤더에서 "함유량"이 "CAS"보다 먼저 나오면 열 순서가 반대인 문서다
  // (구성/명칭/함유량/CAS.NO 순). 이 경우는 완전히 다른 파싱 전략이 필요하다.
  // (섹션 제목 자체를 이미 지운 뒤에 판단해야, 제목에 포함된 "...명칭 및
  // 함유량"의 "함유량"을 표 헤더로 착각해 항상 반대 순서로 오판하지 않는다.)
  const contentHeaderM = /함유량/.exec(section3);
  const casHeaderM = _CAS_HEADER_RE.exec(section3);
  if (contentHeaderM && casHeaderM && contentHeaderM.index < casHeaderM.index) {
    return parseCompositionReversed(section3);
  }
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
    let name = extractCompositionName(before);
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

// 레이블 dict의 다른 레이블들을 하나의 대체(|) 패턴으로 묶는다. 전용
// 하위번호("가)/나)" 등) 없이 필드명만으로 다음 항목과 구분되는 문서에서,
// 같은 dict의 다른 레이블이 바로 뒤에 붙어 있어도 그 레이블 앞에서 캡처를
// 멈추게 하는 데 쓴다(값이 다음 필드 레이블까지 통째로 삼키는 것을 방지).
// exclude(현재 캡처 중인 키)는 반드시 빼야 한다 — 일부 레이블은 오탐 방지를
// 위해 폭넓게 짜여 있어(예: "적절한(부적절한) 소화제"용 패턴이 뒤에 나오는
// "부적절한 소화제"라는 별개 문구 안의 "적절한"과도 우연히 겹쳐 매치될 수
// 있음), 자기 자신을 경계로 넣으면 자기 값 안에서 스스로를 잘라먹는다.
function labelsAsExtraStop(labels, exclude = null) {
  return Object.entries(labels)
    .filter(([k]) => k !== exclude)
    .map(([, p]) => `(?:${p})`)
    .join("|");
}

function parseFirstAid(section4) {
  const out = {};
  for (const [key, label] of Object.entries(FIRST_AID_LABELS)) {
    const m = new RegExp(label).exec(section4);
    if (!m) continue;
    const extraStop = labelsAsExtraStop(FIRST_AID_LABELS, key);
    const captured = captureAfterLabel(section4, label, 200, extraStop);
    out[key] = { label: m[0], text: firstSentences(captured) };
  }
  return out;
}

// "적절한 소화제" 바로 뒤에 오는 "부적절한 소화제"/"대형 화재시"는 그 자체로는
// FIREFIGHTING_LABELS의 어느 키에도 대응하지 않는(별도로 값을 뽑지 않는)
// 형제 하위 항목이지만, 그래도 "적절한 소화제" 값이 그 항목까지 삼키지
// 않도록 경계로는 써야 한다.
const _FIREFIGHTING_EXTRA_STOP = "부적절한\\s*소화제|대형\\s*화재시";

function parseFirefighting(section5) {
  const out = {};
  for (const [key, label] of Object.entries(FIREFIGHTING_LABELS)) {
    if (!new RegExp(label).test(section5)) continue;
    let extraStop = labelsAsExtraStop(FIREFIGHTING_LABELS, key);
    extraStop = extraStop ? `${extraStop}|${_FIREFIGHTING_EXTRA_STOP}` : _FIREFIGHTING_EXTRA_STOP;
    const captured = captureAfterLabel(section5, label, 150, extraStop);
    out[key] = firstSentences(captured, 1, 80);
  }
  return out;
}

function parseAccidentalRelease(section6) {
  const out = {};
  for (const [key, label] of Object.entries(ACCIDENTAL_RELEASE_LABELS)) {
    if (!new RegExp(label).test(section6)) continue;
    const extraStop = labelsAsExtraStop(ACCIDENTAL_RELEASE_LABELS, key);
    let captured = captureAfterLabel(section6, label, 150, extraStop);
    // "인체를 보호하기 위해 필요한 조치사항 및 보호구"처럼 레이블 자체가 두
    // 줄로 나뉜 문서는, 줄 순서상 레이블의 둘째 줄("및 보호구")이 값보다
    // 뒤에 붙어 나온다(예: "자료없음 및 보호구"). 값 뒤에 붙은 레이블
    // 잔여 문구를 떼어낸다.
    captured = captured.replace(/\s*및\s*보호구\s*$/, "");
    out[key] = firstSentences(captured, 1, 80);
  }
  return out;
}

function parseHandlingStorage(section7) {
  const out = {};
  for (const [key, label] of Object.entries(HANDLING_STORAGE_LABELS)) {
    if (!new RegExp(label).test(section7)) continue;
    const extraStop = labelsAsExtraStop(HANDLING_STORAGE_LABELS, key);
    const captured = captureAfterLabel(section7, label, 400, extraStop);
    out[key] = sentences(captured, 4, 85);
  }
  return out;
}

function parseExposureControls(section8) {
  const out = {};
  for (const [key, label] of Object.entries(PPE_LABELS)) {
    if (!new RegExp(label).test(section8)) continue;
    const extraStop = labelsAsExtraStop(PPE_LABELS, key);
    const captured = captureAfterLabel(section8, label, 200, extraStop);
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
