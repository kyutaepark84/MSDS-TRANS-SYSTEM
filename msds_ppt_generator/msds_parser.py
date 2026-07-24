"""산업안전보건법 표준 16개 항목(KOSHA) 형식의 MSDS PDF를 파싱한다.

이 파서는 회사마다 다른 두 가지 서식 차이를 모두 견디도록 설계되었다:
  - 하위 항목 표기가 "가./나./다."(한글) 인 경우와 "1.1./2.2.4.1." 식
    소수점 번호 체계인 경우가 모두 있다.
  - PDF 텍스트 추출 시 줄바꿈이 거의 보존되지 않는 문서(한 페이지가 사실상
    한 줄로 뭉쳐 나오는 경우)가 있어, 줄바꿈 유무에 의존하지 않는다.

전략: 페이지 텍스트를 pypdf의 layout 모드로 추출한 뒤(줄바꿈/표 순서가
가장 잘 보존됨) 공백 하나로 정규화한 "flat text"를 만들고, 그 위에서
  1) 1~16번 대항목은 법정 표준 제목 문구(약간의 표기 차이는 허용)로 위치를 찾고
  2) 각 대항목 내부의 개별 필드는 "레이블 뒤 텍스트"를 직접 정규식으로 찾아
     캡처한다(상위 하위번호 체계에 의존하지 않음).
전혀 다른 회사 양식이라도 필드 레이블 자체는 법령상 정해진 표현을 그대로
쓰는 경우가 많아, 이 방식이 하위항목 번호체계 차이보다 훨씬 안정적이다.
"""

import re
from dataclasses import dataclass, field

from pypdf import PdfReader

SECTION_TITLES = {
    1: "화학제품과 회사에 관한 정보",
    2: "유해성・위험성",
    3: "구성성분의 명칭 및 함유량",
    4: "응급조치요령",
    5: "폭발・화재시 대처방법",
    6: "누출 사고시 대처방법",
    7: "취급 및 저장방법",
    8: "노출방지 및 개인보호구",
    9: "물리화학적 특성",
    10: "안정성 및 반응성",
    11: "독성에 관한 정보",
    12: "환경에 미치는 영향",
    13: "폐기시 주의사항",
    14: "운송에 필요한 정보",
    15: "법적규제 현황",
    16: "그 밖의 참고사항",
}

SEP = r"[·ㆍ•・∙,]"  # 가운뎃점 표기 변형(쉼표로 쓰는 문서도 있음)

SECTION_TITLE_PATTERNS = {
    1: r"화학제품과\s*회사에\s*관한\s*정보",
    2: rf"유해성?\s*{SEP}?\s*위험성",
    3: r"구성\s*성분의?\s*명칭\s*및\s*함유량",
    4: r"응급\s*조치\s*요령",
    5: rf"폭발\s*{SEP}?\s*화재\s*시\s*대처\s*방법",
    6: r"누출\s*사고\s*시\s*대처\s*방법",
    7: r"취급\s*및\s*저장\s*방법",
    8: r"노출\s*방지\s*및\s*개인\s*보호구",
    9: rf"물리\s*{SEP}?\s*화학적\s*특(?:성|징)",
    10: r"안정성\s*및\s*반응성",
    11: r"독성에\s*관한\s*정보",
    12: r"환경에\s*미치는\s*영향",
    13: r"폐기\s*시?\s*주의사항",
    14: r"운송에\s*필요한\s*정(?:보|도)",
    15: r"법적\s*규제\s*현황",
    16: r"(?:그\s*밖(?:의|에)|기타)\s*참고사항",
}

_REVISION_DATE_RE = re.compile(r"최종개정일자\s*[:：]\s*([\d.]+)")
_HCODE_RE = re.compile(r"H\d{3}(?:\+H\d{3})*")
_PCODE_RE = re.compile(r"P\d{3}(?:\+P\d{3})*")
_CAS_RE = re.compile(r"\d{2,7}-\d{2}-\d")

# 한글 순서 마커로 실제 쓰이는 글자만(임의의 한글 한 글자가 ")"/"." 앞에 오는
# 경우까지 마커로 오인하지 않도록 범위를 좁힌다. 예: "신경계통)" 오탐 방지.
_ORDINAL_CHARS = "가나다라마바사아자차카타파하"
# 한글 순서 마커가 "가."(마침표) 대신 "가)"(괄호)로 쓰이는 문서도 있다.
STOP = (
    rf"(?=[{_ORDINAL_CHARS}]\.\s|[{_ORDINAL_CHARS}]\)|\d+\)|\d+(?:\.\d+)+\.?|-\s+\S|○\s*\S|\Z)"
)
_STOP_MATCH = rf"[{_ORDINAL_CHARS}]\.\s|[{_ORDINAL_CHARS}]\)|\d+\)|\d+(?:\.\d+)+\.?|-\s+\S|○\s*\S"

_BOILERPLATE_PATTERNS = [
    r"물\s*질\s*안\s*전\s*보\s*건\s*자\s*료\s*\(Material Safety Data Sheets\)\s*문서번호\s*\S+\s*개정번호\s*\S+\s*개정일자\s*[\d.\s]+년?월?일?",
    r"물질안전보건자료(?=\s|$)",
    r"페이지\s*[:：]\s*\d+\(\d+\)",
    r"SDS\s*번호\s*[:：]\s*\S+",
    r"최종개정일자\s*[:：]\s*[\d.]+",
    r"본\s*물질안전보건자료는\s*산업안전보건법\s*및\s*시행규칙에\s*의거하여\s*작성",
    r"\S{1,20}\s+\d+\s*페이지\s*중\s*\d+\s*페이지\s*MSDS-\S+\s*\(rev\.\d+\)",
    r"Page\s+\d+\s+of\b\s*\d*",
    r"포함된\s*물질[^./]*있음\.?",
]

# 자주 쓰이는 합금/용접재료 원소의 CAS 번호 -> 이름. 표 제목 등 잡음 단어가
# 구성성분명으로 잘못 잡혔을 때의 안전망으로만 사용한다.
KNOWN_CAS_NAMES = {
    "7439-89-6": "철", "7440-47-3": "크롬", "7440-02-0": "니켈",
    "7439-96-5": "망간", "7440-50-8": "구리", "7440-21-3": "실리콘",
    "7440-03-1": "니오븀", "7440-31-5": "주석", "7440-33-7": "텅스텐",
    "7440-48-4": "코발트", "7439-95-4": "마그네슘", "7429-90-5": "알루미늄",
}
_COMPOSITION_HEADER_NOISE = {
    "단위", "함유량", "물질명", "화학물질명", "이명", "비고", "성분명", "구성성분",
}

FIRST_AID_LABELS = {
    "eye": r"눈에\s*들어갔을\s*때",
    "skin": r"피부에\s*접촉(?:했|되었)을\s*때",
    "inhalation": r"흡입(?:했|하였)을\s*때",
    "ingestion": r"(?:먹었을\s*때|섭취(?:했|하였)을\s*때)",
}
FIREFIGHTING_LABELS = {
    "extinguishing": r"(?:적절한|절적한)\s*(?:\(및\s*부적절한\))?\s*소화제",
    "hazards": r"화학물질로부터\s*생기는\s*특정\s*유해성",
    "protective": r"(?:화재\s*진압\s*시|화재진압시)\s*착용할\s*보호구(?:\s*및\s*예방조치)?",
}
ACCIDENTAL_RELEASE_LABELS = {
    "personal": r"인체를\s*보호하기\s*위해\s*필요한\s*조치\s*사?항?(?:\s*및\s*보호구)?",
    "environmental": r"환경을\s*보호하기\s*위해\s*필요한\s*조치\s*사?항?",
    "cleanup": r"정화\s*또는\s*제거\s*방법?",
}
HANDLING_STORAGE_LABELS = {
    "handling": r"안전\s*취급\s*요령",
    "storage": r"안전한\s*저장\s*방법(?:\s*\([^)]*\))?",
}
PPE_LABELS = {
    "respiratory": r"호흡기\s*보호",
    "eye": r"눈\s*(?:/?\s*안면)?\s*보호",
    "hand": r"손\s*보호",
    "body": r"신체\s*보호",
}


@dataclass
class MSDSData:
    product_name: str = ""
    product_name_desc: str = ""
    supplier_name: str = ""
    supplier_address: str = ""
    supplier_phone: str = ""
    classification: list = field(default_factory=list)   # [(family, category)]
    signal_word: str = ""
    hazard_statements: list = field(default_factory=list)     # [(code, text)]
    precaution: dict = field(default_factory=dict)            # {prevention/response/storage/disposal: [(code,text)]}
    composition: list = field(default_factory=list)           # [(name, cas, content)]
    first_aid: dict = field(default_factory=dict)             # {eye/skin/inhalation/ingestion: {"label","text"}}
    firefighting: dict = field(default_factory=dict)          # {extinguishing/hazards/protective: str}
    accidental_release: dict = field(default_factory=dict)    # {personal/environmental/cleanup: str}
    handling_storage: dict = field(default_factory=dict)      # {handling/storage: [sentence, ...]}
    exposure_controls: dict = field(default_factory=dict)     # {respiratory/eye/hand/body: str}
    revision_date: str = ""


# --------------------------------------------------------------------------
# 텍스트 추출 및 정규화
# --------------------------------------------------------------------------

def _strip_boilerplate(text):
    for pat in _BOILERPLATE_PATTERNS:
        text = re.sub(pat, " ", text)
    return text


def extract_flat_text(pdf_path):
    """PDF를 layout 모드로 추출한 뒤, 반복되는 머리말/꼬리말을 지우고
    공백을 하나로 정규화한 문자열을 돌려준다. 최종개정일자도 함께 반환한다."""
    reader = PdfReader(pdf_path)
    pages = []
    revision_date = ""
    for page in reader.pages:
        text = page.extract_text(extraction_mode="layout") or page.extract_text() or ""
        if not revision_date:
            m = _REVISION_DATE_RE.search(text)
            if m:
                revision_date = m.group(1)
        pages.append(text)
    full = "\n".join(pages)
    full = _strip_boilerplate(full)
    flat = re.sub(r"[ \t]+", " ", full)
    flat = re.sub(r"\n+", " ", flat)
    flat = re.sub(r" +", " ", flat).strip()
    return flat, revision_date


def split_sections(flat_text):
    """flat text를 {번호: 본문} 으로 나눈다. 법정 표준 제목 문구를 앵커로 삼아
    찾으므로, 하위 항목 번호 체계(한글/소수점)나 줄바꿈 유무에 좌우되지 않는다."""
    boundaries = []
    expected = 1
    pos = 0
    while expected <= 16:
        pat = re.compile(rf"{expected}\.\s*{SECTION_TITLE_PATTERNS[expected]}")
        m = pat.search(flat_text, pos)
        if not m:
            break
        boundaries.append((m.start(), expected))
        pos = m.end()
        expected += 1
    boundaries.append((len(flat_text), None))

    sections = {}
    for i in range(len(boundaries) - 1):
        start, no = boundaries[i]
        end = boundaries[i + 1][0]
        sections[no] = flat_text[start:end]
    return sections


# --------------------------------------------------------------------------
# 레이블 뒤 텍스트 캡처 공용 유틸
# --------------------------------------------------------------------------

def _capture_after_label(text, label_pattern, max_chars=150, extra_stop=None):
    m = re.search(rf"{label_pattern}\s*[:：]?\s*", text)
    if not m:
        return ""
    rest = text[m.end():]
    # 레이블 바로 뒤에 붙는 장식용 불릿("- ", "○ ")은 실제 경계가 아니라 그
    # 뒤에 오는 내용 자체의 시작 표시이므로, 캡처 전에 먼저 벗겨낸다. 벗기지
    # 않으면 아래 STOP 판정에서 이 불릿을 "거의 즉시 나온 마커"로 오인해
    # 건너뛰면서, 그 과정에서 실제 내용의 첫 글자까지 함께 삼켜버리게 된다.
    rest = re.sub(r"^\s*[-○]\s*", "", rest)
    stop_pattern = _STOP_MATCH if not extra_stop else rf"{_STOP_MATCH}|{extra_stop}"
    # 첫 STOP 지점이 거의 즉시(빈 캡처 수준)라면 같은 항목의 하위번호
    # (예: "6.2. 환경보호 6.2.1. 대기 : ...")일 가능성이 높으므로 그 마커를
    # 건너뛰고(캡처 시작점도 함께 이동) 다음 STOP까지 계속 찾는다(최대 3회).
    search_from = 0
    content_start = 0
    end = len(rest)
    for _ in range(3):
        stop_m = re.search(stop_pattern, rest[search_from:])
        if not stop_m:
            end = len(rest)
            break
        if stop_m.start() < 3:
            search_from += stop_m.end()
            content_start = search_from
            continue
        end = search_from + stop_m.start()
        break
    end = min(end, content_start + max_chars)
    return rest[content_start:end].strip()


def _sentences(text, max_sentences=4, max_chars_each=90):
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    parts = [p.strip() for p in parts if p.strip()]
    out = []
    for p in parts[:max_sentences]:
        if len(p) > max_chars_each:
            p = p[:max_chars_each].rstrip() + "…"
        out.append(p)
    return out


def _first_sentences(text, max_sentences=2, max_chars=90):
    return " ".join(_sentences(text, max_sentences=max_sentences, max_chars_each=max_chars))


# --------------------------------------------------------------------------
# 섹션 1: 제품/공급자 정보
# --------------------------------------------------------------------------

def _parse_product_name(section1):
    m = re.search(r"제품명\s*[:：]?\s*", section1)
    if not m:
        return ""
    window = section1[m.end():m.end() + 60]
    stop_m = re.search(STOP, window)
    captured = (window[:stop_m.start()] if stop_m else window).strip()

    code_m = re.match(r"[A-Za-z][A-Za-z0-9\-]{1,19}", window)
    if code_m:
        # 코드 바로 뒤에 다음 항목(STOP)이 거의 바로 이어지면(공백만 있고 그
        # 뒤가 바로 "1.2." 같은 다음 항목이면), 이 코드 자체가 제품명 전체다
        # (예: "ST-309\n1.1.1. 제품에 대한 기술 : ..."). 코드 뒤에 괄호나
        # 단어가 더 이어지면 그 코드는 제품명의 시작일 뿐이므로(예: "PN02994
        # (L/C) Green corps cut-off wheel"), 뒤에 이어지는 내용까지 포함해서
        # 캡처한다.
        gap_m = re.match(r"\s*", window[code_m.end():])
        if stop_m and code_m.end() + gap_m.end() >= stop_m.start():
            return code_m.group(0)
    else:
        code_m2 = re.search(r"[A-Za-z][A-Za-z0-9\-]{1,19}", captured)
        if code_m2 and len(captured) > len(code_m2.group(0)) + 10:
            return code_m2.group(0)
    return captured


# 국가번호가 앞에 붙어 4개 조각으로 쓰이는 경우(예: "82-2-3771-4114",
# "82-80-033-4114")와 국내 표기 3개 조각(예: "02-2121-5114")을 모두 포괄
# 하도록, 조각 개수(2~3개의 하이픈)와 각 조각 자릿수(1~4자리)를 넉넉하게
# 잡는다. 너무 좁은 조각 수 고정(예: 정확히 3개 조각만 허용)은 국가번호가
# 붙은 4개 조각 번호에서 앞부분을 잘라먹는 문제를 일으켰다.
_PHONE_RE = re.compile(r"\d{1,4}(?:[-–]\d{1,4}){2,3}")


def _parse_supplier_phone(section1):
    for label in (r"긴급\s*전화\s*번호", r"긴급연락\s*전화", r"긴급\s*연락처", r"TEL"):
        val = _capture_after_label(section1, label, max_chars=100)
        m = _PHONE_RE.search(val)
        if m:
            return m.group(0)
    m = _PHONE_RE.search(section1)
    return m.group(0) if m else ""


# 공급자 정보(1.3)는 "회사명:/주소:/전화:/팩스:/웹사이트/긴급전화번호:" 처럼
# 레이블이 붙은 필드가 한 줄씩 이어지는 문서가 있다. 이런 필드 레이블은
# STOP(번호/불릿) 판정에 걸리지 않아, 그대로 두면 다음 필드 레이블까지
# 통째로 삼켜버린다(예: 회사명이 "한국쓰리엠 주소: 서울특별시 ... 전화: ...
# 긴급전화번호: ..." 전체가 되어버림). 그래서 이 필드들을 캡처할 때는 서로를
# 추가 경계로 함께 써서 다음 레이블 앞에서 멈추도록 한다.
# 콜론 없이 레이블만 쓰는 문서도 있어(예: "회사명 제일연마공업㈜ 주소 경북 ...")
# 콜론을 필수로 요구하지 않는다.
_SUPPLIER_FIELD_STOP = (
    r"회사명\s*[:：]?|주\s*소\s*[:：]?|전화\s*(?:번호)?\s*[:：]?|팩스\s*(?:번호)?\s*[:：]?|"
    r"웹\s*사이트|홈페이지|e-?mail\s*[:：]?|긴급\s*(?:연락\s*)?(?:전화|연락처)\s*(?:번호)?\s*[:：]?"
)


def _parse_section1(section1):
    name = _parse_product_name(section1)
    supplier_name = ""
    for label in (r"제조자\s*정보", r"회사명"):
        val = _capture_after_label(section1, label, extra_stop=_SUPPLIER_FIELD_STOP)
        if val:
            supplier_name = val
            break
    supplier_address = _capture_after_label(section1, r"주\s*소", max_chars=120, extra_stop=_SUPPLIER_FIELD_STOP)
    supplier_phone = _parse_supplier_phone(section1)
    return name, supplier_name, supplier_address, supplier_phone


# --------------------------------------------------------------------------
# 섹션 2: 유해성・위험성 (분류, 신호어, H-code, P-code)
# --------------------------------------------------------------------------

def _parse_classification(section2):
    # 섹션 제목 자체("2.유해성, 위험성")도 "유해성...위험성"을 포함하고 있어,
    # 먼저 이 제목 앞부분을 지워야 그 안의 "위험성"이 뒤 "가)유해성,위험성
    # 분류"를 지운 자리에 잔여 글자로 남아 분류명 앞에 잘못 붙지 않는다.
    body = re.sub(rf"^\s*2\.\s*{SECTION_TITLE_PATTERNS[2]}", "", section2, count=1)
    # "가)유해성,위험성 분류"처럼 앞에 한글 순서 마커가 바로 붙어 있는 문서가
    # 있어, 그 마커도 함께 지워야 뒤이은 첫 분류명이 "위험성 가) 특정표적장기..."
    # 처럼 마커/제목 잔여 글자를 덧붙인 채로 잡히지 않는다.
    body = re.sub(
        rf"(?:[{_ORDINAL_CHARS}]\)|[{_ORDINAL_CHARS}]\.\s)?\s*유해성?{SEP}?\s*위험성\s*분류",
        "", body, count=1,
    )
    pairs = []
    for m in re.finditer(r"([가-힣][가-힣0-9()\-/\s]{1,30}?)\s*[:：]?\s*구분\s*(\d+)", body):
        pairs.append((m.group(1).strip(), f"구분{m.group(2)}"))
        if len(pairs) >= 15:
            break
    return pairs


def _parse_signal_word(section2):
    m = re.search(r"신호어\s*[-:：]?\s*(위험|경고)", section2)
    return m.group(1) if m else ""


def _extract_coded_statements(text, code_re, max_chars=150):
    matches = list(code_re.finditer(text))
    out = []
    for i, m in enumerate(matches):
        rest = text[m.end():]
        colon_m = re.match(r"\s*[:：]?\s*", rest)
        desc_start = m.end() + colon_m.end()
        natural_end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        desc_end = min(natural_end, desc_start + max_chars)
        desc = text[desc_start:desc_end]
        # 문장 끝(마침표) 또는 다음 소항목 마커(그룹 표제 "2.2.4.2. 대응" 등 포함)에서
        # 한번 더 잘라, 코드 사이에 낀 그룹 표제나 다음 섹션 텍스트가 섞이지 않게 한다.
        # (다음 코드가 있는 항목도 그 사이에 그룹 표제만 있고 실제 다음 코드는 더
        # 뒤에 있을 수 있어 모든 항목에 적용한다.)
        window = desc[:90]
        period_m = re.search(r"[.!?]", window)
        marker_m = re.search(
            rf"(?:(?<![가-힣])[{_ORDINAL_CHARS}]\)|\d+\)|\d+(?:\.\d+)+|[HP]\d{{3}}|"
            r"예방조치\s*문구|응급조치요령|○)", window
        )
        candidates = [c.end() if c is period_m else c.start() for c in (period_m, marker_m) if c]
        desc = window[:min(candidates)] if candidates else window
        desc = desc.strip()
        # 일부 문서는 각 코드 항목 앞뒤로 "-" 를 장식용 불릿으로 쓰는데, 마침표
        # 없이 바로 다음 코드로 이어지는 문장의 경우 그 다음 항목의 불릿("- ")까지
        # 함께 캡처되어 끝에 하이픈만 덩그러니 남는 경우가 있어 마지막으로 한 번
        # 더 정리한다.
        desc = re.sub(r"\s*-\s*$", "", desc).strip()
        out.append((m.group(0), desc, m.start()))
    return out


def _group_precaution_codes(section2, p_entries):
    group_labels = {"prevention": "예방", "response": "대응", "storage": "저장", "disposal": "폐기"}
    anchors = []
    for key, word in group_labels.items():
        for m in re.finditer(rf"(?:[{_ORDINAL_CHARS}]\)|\d+\)|\d+(?:\.\d+)+\.?)\s*{word}\b", section2):
            anchors.append((m.start(), key))
    if not anchors:
        # 일부 문서는 "가)/나)" 같은 전용 순서 마커 없이 "예방조치 문구/대응/
        # 저장/폐기"처럼 필드명만으로 그룹을 구분한다("예방"은 "예방조치 문구"로
        # 나타남). 그런 문서에서는 위 마커-앞잡이 방식으로 앵커를 하나도 못
        # 찾으므로, 순서 마커 없이 레이블 단어 자체를 경계로 쓴다.
        bare_group_labels = {
            "prevention": r"예방(?:조치\s*문구)?", "response": "대응", "storage": "저장", "disposal": "폐기",
        }
        for key, word in bare_group_labels.items():
            for m in re.finditer(rf"(?<![가-힣])(?:{word})(?![가-힣])", section2):
                anchors.append((m.start(), key))
    anchors.sort()
    result = {k: [] for k in group_labels}
    for code, desc, pos in p_entries:
        cur = None
        for a_pos, a_key in anchors:
            if a_pos <= pos:
                cur = a_key
            else:
                break
        if cur:
            result[cur].append((code, desc))
    return result


def _parse_section2(section2):
    signal_word = _parse_signal_word(section2)
    classification = _parse_classification(section2)
    hazard_statements = [(c, d) for c, d, _ in _extract_coded_statements(section2, _HCODE_RE)]
    p_entries = _extract_coded_statements(section2, _PCODE_RE)
    precaution = _group_precaution_codes(section2, p_entries)
    return signal_word, classification, hazard_statements, precaution


# --------------------------------------------------------------------------
# 섹션 3: 구성성분
# --------------------------------------------------------------------------

# 화학물질명 뒤에 "관용명/이명" 칸이 바로 붙어 있는 문서가 많아(예: "크롬
# 자료없음", "Toluene Methylbenzene"), 단어 표기 형태(대소문자 등)만으로는
# "다음 단어가 화학물질명의 연장인지 관용명 칸의 시작인지"를 안정적으로 구분할
# 수 없다(실제로 시도했다가 휘발유 문서에서 관용명이 이름에 잘못 붙는 회귀가
# 발생함: "Toluene"의 관용명 "Methylbenzene"도 Title Case라 이름처럼 보임).
# 그래서 "그 다음 단어가 원소명이거나 화합물 접미어일 때만" 이어붙인다 — 이건
# 화학물질명이 "원소/화합물류"일 때만 참이 되는 좁고 안전한 신호라, "알루미늄
# 산화물"/"Sodium Aluminum Hexafluoride" 같은 진짜 여러 단어 이름은 온전히
# 잡히면서도 "자료없음"/"Methylbenzene" 같은 관용명은 걸러진다.
_COMPOSITION_CONTINUATION_WORDS_KO = {
    "산화물", "수산화물", "과산화물", "황산염", "황화물", "아황산염", "염화물",
    "불화물", "브롬화물", "요오드화물", "질산염", "아질산염", "탄산염", "중탄산염",
    "인산염", "아인산염", "규산염", "붕산염", "크롬산염", "중크롬산염", "시안화물",
    "초산염", "아세트산염", "수화물", "화합물", "합금",
    "알루미늄", "나트륨", "칼륨", "칼슘", "마그네슘", "철", "구리", "아연", "니켈",
    "크롬", "망간", "코발트", "주석", "납", "은", "금", "백금", "티타늄", "규소",
    "붕소", "인", "황", "염소", "불소", "브롬", "요오드", "탄소", "질소", "수소", "산소",
}
_COMPOSITION_CONTINUATION_WORDS_EN = {
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
}


def _extract_composition_name(before):
    """화학물질명 칸을 "before"(직전 행 함유량 끝 ~ 이번 CAS 시작) 구간에서
    찾는다. 이름은 한글 단어일 수도(NC-T30R 등) 영문 화학명일 수도(휘발유 등)
    있고, "Sodium Aluminum Hexafluoride"처럼 여러 단어인 경우도 있다."""
    first_m = _COMPOSITION_NAME_FIRST_RE.search(before)
    if not first_m:
        return ""
    words = [first_m.group(0)]
    is_korean = bool(re.match(r"^[가-힣]", words[0]))
    allowed = _COMPOSITION_CONTINUATION_WORDS_KO if is_korean else _COMPOSITION_CONTINUATION_WORDS_EN
    rest = before[first_m.end():]
    for word_m in re.finditer(r"\s+(\S+)", rest):
        token = word_m.group(1)
        key = token.lower() if not is_korean else token
        if key not in allowed:
            break
        words.append(token)
    return " ".join(words).strip()


_COMPOSITION_NAME_FIRST_RE = re.compile(r"(?:\d+(?:,\d+)*-)?[A-Za-z가-힣][A-Za-z가-힣0-9\-]*")


_CAS_HEADER_RE = re.compile(r"CAS\s*[.\s]*(?:번호|No\.?|NO)?", re.IGNORECASE)


def _parse_composition_reversed(section3):
    """일부 문서는 표 열 순서가 "구성(역할) | 명칭 | 함유량(%) | CAS.NO"라서
    함유량이 CAS보다 먼저 나오고(다른 문서 대부분과 반대), CAS가 없는 혼합물
    행은 그 자리에 "혼합물"/"자료없음" 같은 자리표시자가 온다(예: "연마재
    ALUNDUM 70~80% 1344-28-1", "본드 Cured resin 10~20% 혼합물"). "구성"
    (연마재/본드/충진제/보강제 등 역할 분류로, 화학물질명이 아님) 다음에 오는
    "명칭"칸을 화학물질명으로 취한다."""
    section3 = re.sub(r"구성|명칭|함유량(?:\s*\(?%\)?)?|CAS\s*[.\s]*(?:번호|No\.?|NO)?", "", section3)
    out = []
    # 맨 앞 "구성"(역할: 연마재/본드/충진제/보강제 등)은 항상 한글 단어이므로,
    # 남아있는 절 번호("3.") 같은 잡문자를 역할 칸으로 잘못 집지 않도록
    # \S+ 대신 한글 전용으로 좁힌다.
    pattern = re.compile(
        r"[가-힣]+\s+(.+?)\s*(\d[\d.]*(?:\s*~\s*\d[\d.]*)?)\s*%\s*(\d{2,7}-\d{2}-\d|혼합물|자료없음)"
    )
    for m in pattern.finditer(section3):
        name, content, cas = m.groups()
        name = name.strip()
        content = content.replace(" ", "")
        if name:
            out.append((name, cas, content))
    return out


def _parse_composition(section3, product_name=""):
    section3 = re.sub(r"구성\s*성분의?\s*명칭\s*및\s*함유량", "", section3)
    # 표 헤더에서 "함유량"이 "CAS"보다 먼저 나오면 열 순서가 반대인 문서다
    # (구성/명칭/함유량/CAS.NO 순). 이 경우는 완전히 다른 파싱 전략이 필요하다.
    # (섹션 제목 자체를 이미 지운 뒤에 판단해야, 제목에 포함된 "...명칭 및
    # 함유량"의 "함유량"을 표 헤더로 착각해 항상 반대 순서로 오판하지 않는다.)
    content_header_m = re.search(r"함유량", section3)
    cas_header_m = _CAS_HEADER_RE.search(section3)
    if content_header_m and cas_header_m and content_header_m.start() < cas_header_m.start():
        return _parse_composition_reversed(section3)

    # "이 제품의 물질은 혼합물로 구성"류 안내문(단일물질인 경우 "단일 화학물질로
    # 구성"으로도 쓰임)은 표 앞에 붙는 상투어라, 지우지 않으면 첫 행의 이름
    # 탐색 구간에 걸려 "이"처럼 엉뚱한 글자가 이름으로 잡힌다.
    section3 = re.sub(r"이\s*제품의?\s*물질은\s*(?:단일\s*화학\s*물질로|혼합물로)\s*구성(?:됨|되어\s*있음)?\.?", "", section3)
    section3 = re.sub(r"화학\s*물질명|물질명|관용명(?:\s*및\s*이명)?|이명\s*\(관용명\)|이명", "", section3)
    # "CAS번호"와 "또는 식별번호"를 하나로 묶어서 지우면, 표 헤더가 두 줄로
    # 나뉘어 추출되는 문서(예: "CAS번호 또는 식별번" 다음 줄에 "호"만 떨어져
    # 나옴)에서 그 사이에 낀 "함유량 (%)" 때문에 통짜 매칭이 실패해 헤더
    # 잔여 글자가 이름으로 오인될 수 있다. 그래서 각각 따로 지운다.
    section3 = re.sub(r"CAS\s*번호", "", section3)
    section3 = re.sub(r"또는\s*식별\s*번\s*호?", "", section3)
    # "식별번호"가 줄바꿈으로 "식별번"과 "호"로 쪼개져 추출되면, 떨어져 나간
    # "호" 한 글자가 열 순서상 "함유량 (%)" 바로 뒤에 붙어서 나온다. 위에서
    # 못 지운 그 "호"를 여기서 마저 지운다(안 지우면 다음 성분명으로 오인됨).
    section3 = re.sub(r"함유량\s*\(%\)\s*호?", "", section3)
    section3 = re.sub(r"단위\s*[:：]\s*\S+", "", section3)
    # 영문 표기 문서는 "Cas No. / EU No. / KE No." 처럼 영문 표 헤더를 쓰기도
    # 하는데, 이름을 영문도 허용하도록 넓힌 뒤로는 이 헤더 문구 자체가 이름으로
    # 오인될 수 있어 미리 지운다.
    section3 = re.sub(r"Cas\s*No\.?|EU\s*No\.?|KE\s*No\.?", "", section3, flags=re.IGNORECASE)
    if product_name:
        # 일부 문서는 표 머리말 부근에 제품명(코드)이 워터마크처럼 한 번 더
        # 섞여 들어와 있어(예: "CAS 번호 NC-T30R 크롬 ..."), 본문에서 이미
        # 확인된 제품명과 정확히 같은 문자열이 나오면 이름으로 오인하지 않도록
        # 먼저 지운다.
        section3 = re.sub(re.escape(product_name), "", section3)
    out = []
    cas_matches = list(_CAS_RE.finditer(section3))
    prev_content_end = 0
    for i, m in enumerate(cas_matches):
        # 이름은 "직전 행의 함유량 끝"부터 "이번 CAS 시작"까지의 구간에서 찾는다
        # (단순히 직전 CAS 뒤부터로 잡으면, 표 사이에 낀 "포함된 물질..." 같은
        # 안내문이 함께 걸려 이름으로 오인될 여지가 남아있어 이쪽이 더 좁고 정확).
        before_start = max(cas_matches[i - 1].end() if i > 0 else 0, prev_content_end)
        before = section3[max(before_start, m.start() - 60):m.start()]
        name = _extract_composition_name(before)
        if not name or name in _COMPOSITION_HEADER_NOISE:
            name = KNOWN_CAS_NAMES.get(m.group(0), name)

        after_end = cas_matches[i + 1].start() if i + 1 < len(cas_matches) else len(section3)
        after = section3[m.end():after_end]
        # CAS 번호 뒤에는 "EU번호/식별번호"(예: "231-096-4/KE-21059")가 붙는
        # 경우도, EU번호 없이 "/KE-21971"처럼 식별번호만 슬래시로 바로 붙는
        # 경우도 있어 앞의 EU번호 부분은 있어도 되고 없어도 되게 한다.
        identifier_m = re.match(r"\s*(?:\d+-\d+(?:-\d+)?)?/[A-Z]{1,4}-?\d*\s*", after)
        search_area = after[identifier_m.end():] if identifier_m else after
        # 함유량 구간(범위) 표기는 "~"(예: "10~30")를 쓰는 문서도, "-"(예: "60 - 70")를
        # 쓰는 문서도 있어 둘 다 구간 구분자로 인정한다.
        content_m = re.search(r"[<>]?\s*\d[\d.]*(?:\s*[~\-]\s*\d[\d.]*)?", search_area)
        content = re.sub(r"\s+", "", content_m.group(0)) if content_m else ""
        content_offset = (identifier_m.end() if identifier_m else 0) + (content_m.end() if content_m else 0)
        # 함유량 뒤에 영문 이명이 괄호로 바로 붙는 경우가 있다(예: "55~65 (Iron)").
        # 그 괄호를 이번 행이 다 삼키고 지나가지 않으면, 다음 CAS의 이름 탐색
        # 구간에 이 괄호가 섞여 들어가 다음 행의 이름으로 잘못 잡힐 수 있다.
        paren_m = re.match(r"\s*\([^)]*\)", after[content_offset:])
        if paren_m:
            content_offset += paren_m.end()
        # 관용명(영문 합성명)이 표 셀 안에서 줄바꿈되면, 그 뒷부분이 이번 행의
        # CAS·함유량 뒤로 밀려나 다음 행 앞에 낀 채로 추출된다(예: "ACTIVATED
        # ALUMINUM"이 한 줄, "OXIDE"가 다음 줄인 셀은 "... 60-70 OXIDE
        # Sodium Aluminum ..." 순서로 나옴). 관용명은 보통 영문 대문자로 쓰이므로,
        # 함유량 뒤에 곧바로 오는 대문자 전용 단어(들)는 이번 행의 잔여 관용명으로
        # 보고 먼저 소비해, 다음 행 이름 탐색 구간에 섞여 들어가지 않게 한다.
        caps_m = re.match(r"\s*(?:[A-Z][A-Z.\-]{1,}(?:\s+|$)){1,3}", after[content_offset:])
        if caps_m:
            content_offset += caps_m.end()
        prev_content_end = m.end() + content_offset
        if name and content:
            out.append((name, m.group(0), content))
    return out


# --------------------------------------------------------------------------
# 섹션 4~8: 응급조치/화재/누출/취급저장/보호구
# --------------------------------------------------------------------------

def _labels_as_extra_stop(labels, exclude=None):
    """레이블 dict의 다른 레이블들을 하나의 대체(|) 패턴으로 묶는다. 전용
    하위번호("가)/나)" 등) 없이 필드명만으로 다음 항목과 구분되는 문서에서,
    같은 dict의 다른 레이블이 바로 뒤에 붙어 있어도 그 레이블 앞에서 캡처를
    멈추게 하는 데 쓴다(값이 다음 필드 레이블까지 통째로 삼키는 것을 방지).
    exclude(현재 캡처 중인 키)는 반드시 빼야 한다 — 일부 레이블은 오탐 방지를
    위해 폭넓게 짜여 있어(예: "적절한(부적절한) 소화제"용 패턴이 뒤에 나오는
    "부적절한 소화제"라는 별개 문구 안의 "적절한"과도 우연히 겹쳐 매치될 수
    있음), 자기 자신을 경계로 넣으면 자기 값 안에서 스스로를 잘라먹는다."""
    return "|".join(f"(?:{p})" for k, p in labels.items() if k != exclude)


def _parse_first_aid(section4):
    out = {}
    for key, label in FIRST_AID_LABELS.items():
        m = re.search(label, section4)
        if not m:
            continue
        extra_stop = _labels_as_extra_stop(FIRST_AID_LABELS, exclude=key)
        captured = _capture_after_label(section4, label, max_chars=200, extra_stop=extra_stop)
        out[key] = {"label": m.group(0), "text": _first_sentences(captured)}
    return out


# "적절한 소화제" 바로 뒤에 오는 "부적절한 소화제"/"대형 화재시"는 그 자체로는
# FIREFIGHTING_LABELS의 어느 키에도 대응하지 않는(별도로 값을 뽑지 않는)
# 형제 하위 항목이지만, 그래도 "적절한 소화제" 값이 그 항목까지 삼키지
# 않도록 경계로는 써야 한다.
_FIREFIGHTING_EXTRA_STOP = r"부적절한\s*소화제|대형\s*화재시"


def _parse_firefighting(section5):
    out = {}
    for key, label in FIREFIGHTING_LABELS.items():
        if not re.search(label, section5):
            continue
        extra_stop = _labels_as_extra_stop(FIREFIGHTING_LABELS, exclude=key)
        extra_stop = f"{extra_stop}|{_FIREFIGHTING_EXTRA_STOP}" if extra_stop else _FIREFIGHTING_EXTRA_STOP
        captured = _capture_after_label(section5, label, max_chars=150, extra_stop=extra_stop)
        out[key] = _first_sentences(captured, max_sentences=1, max_chars=80)
    return out


def _parse_accidental_release(section6):
    out = {}
    for key, label in ACCIDENTAL_RELEASE_LABELS.items():
        if not re.search(label, section6):
            continue
        extra_stop = _labels_as_extra_stop(ACCIDENTAL_RELEASE_LABELS, exclude=key)
        captured = _capture_after_label(section6, label, max_chars=150, extra_stop=extra_stop)
        # "인체를 보호하기 위해 필요한 조치사항 및 보호구"처럼 레이블 자체가 두
        # 줄로 나뉜 문서는, 줄 순서상 레이블의 둘째 줄("및 보호구")이 값보다
        # 뒤에 붙어 나온다(예: "자료없음 및 보호구"). 값 뒤에 붙은 레이블
        # 잔여 문구를 떼어낸다.
        captured = re.sub(r"\s*및\s*보호구\s*$", "", captured)
        out[key] = _first_sentences(captured, max_sentences=1, max_chars=80)
    return out


def _parse_handling_storage(section7):
    out = {}
    for key, label in HANDLING_STORAGE_LABELS.items():
        if not re.search(label, section7):
            continue
        extra_stop = _labels_as_extra_stop(HANDLING_STORAGE_LABELS, exclude=key)
        captured = _capture_after_label(section7, label, max_chars=400, extra_stop=extra_stop)
        out[key] = _sentences(captured, max_sentences=4, max_chars_each=85)
    return out


def _parse_exposure_controls(section8):
    out = {}
    for key, label in PPE_LABELS.items():
        if not re.search(label, section8):
            continue
        extra_stop = _labels_as_extra_stop(PPE_LABELS, exclude=key)
        captured = _capture_after_label(section8, label, max_chars=200, extra_stop=extra_stop)
        out[key] = _first_sentences(captured, max_sentences=1, max_chars=80)
    return out


# --------------------------------------------------------------------------
# 파일명 기반 제품명 추출
# --------------------------------------------------------------------------

_FILENAME_PRODUCT_RE = re.compile(r"MSDS\s*\(([^)]+)\)", re.IGNORECASE)


def extract_product_name_from_filename(filename):
    """업로드된 MSDS 파일명이 "...MSDS(제품명)..." 형식을 따르는 경우, 괄호
    안의 제품명을 그대로 추출한다. 본문에서 뽑아낸 이름은 회사마다 표기가
    제각각이라(예: "휘발유(Regular Gasoline)" 중 일부만 추출되는 등) 신뢰도가
    떨어질 수 있는 반면, 파일명의 제품명은 사내에서 이미 정리해 놓은 표준
    표기이므로 있으면 이쪽을 우선한다. 이 패턴이 아니면 빈 문자열을 돌려준다."""
    m = _FILENAME_PRODUCT_RE.search(filename or "")
    return m.group(1).strip() if m else ""


# --------------------------------------------------------------------------
# 진입점
# --------------------------------------------------------------------------

def parse_msds(pdf_path):
    flat_text, revision_date = extract_flat_text(pdf_path)
    sections = split_sections(flat_text)

    data = MSDSData()
    name, supplier_name, supplier_address, supplier_phone = _parse_section1(sections.get(1, ""))
    data.product_name = name
    data.supplier_name = supplier_name
    data.supplier_address = supplier_address
    data.supplier_phone = supplier_phone

    signal_word, classification, hazard_statements, precaution = _parse_section2(sections.get(2, ""))
    data.signal_word = signal_word
    data.classification = classification
    data.hazard_statements = hazard_statements
    data.precaution = precaution

    data.composition = _parse_composition(sections.get(3, ""), product_name=data.product_name)
    data.first_aid = _parse_first_aid(sections.get(4, ""))
    data.firefighting = _parse_firefighting(sections.get(5, ""))
    data.accidental_release = _parse_accidental_release(sections.get(6, ""))
    data.handling_storage = _parse_handling_storage(sections.get(7, ""))
    data.exposure_controls = _parse_exposure_controls(sections.get(8, ""))
    data.revision_date = revision_date

    return data
