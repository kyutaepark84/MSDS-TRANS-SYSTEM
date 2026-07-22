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

SEP = r"[·ㆍ•・∙]"  # 가운뎃점 표기 변형

SECTION_TITLE_PATTERNS = {
    1: r"화학제품과\s*회사에\s*관한\s*정보",
    2: rf"유해성?\s*{SEP}?\s*위험성",
    3: r"구성\s*성분의?\s*명칭\s*및\s*함유량",
    4: r"응급\s*조치\s*요령",
    5: rf"폭발\s*{SEP}?\s*화재\s*시\s*대처\s*방법",
    6: r"누출\s*사고\s*시\s*대처\s*방법",
    7: r"취급\s*및\s*저장\s*방법",
    8: r"노출\s*방지\s*및\s*개인\s*보호구",
    9: rf"물리\s*{SEP}?\s*화학적\s*특성",
    10: r"안정성\s*및\s*반응성",
    11: r"독성에\s*관한\s*정보",
    12: r"환경에\s*미치는\s*영향",
    13: r"폐기\s*시?\s*주의사항",
    14: r"운송에\s*필요한\s*정보",
    15: r"법적\s*규제\s*현황",
    16: r"(?:그\s*밖의|기타)\s*참고사항",
}

_REVISION_DATE_RE = re.compile(r"최종개정일자\s*[:：]\s*([\d.]+)")
_HCODE_RE = re.compile(r"H\d{3}(?:\+H\d{3})*")
_PCODE_RE = re.compile(r"P\d{3}(?:\+P\d{3})*")
_CAS_RE = re.compile(r"\d{2,7}-\d{2}-\d")

# 한글 순서 마커로 실제 쓰이는 글자만(임의의 한글 한 글자가 ")"/"." 앞에 오는
# 경우까지 마커로 오인하지 않도록 범위를 좁힌다. 예: "신경계통)" 오탐 방지.
_ORDINAL_CHARS = "가나다라마바사아자차카타파하"
STOP = (
    rf"(?=[{_ORDINAL_CHARS}]\.\s|\d+\)|\d+(?:\.\d+)+\.?|-\s+\S|○\s*\S|\Z)"
)
_STOP_MATCH = rf"[{_ORDINAL_CHARS}]\.\s|\d+\)|\d+(?:\.\d+)+\.?|-\s+\S|○\s*\S"

_BOILERPLATE_PATTERNS = [
    r"물\s*질\s*안\s*전\s*보\s*건\s*자\s*료\s*\(Material Safety Data Sheets\)\s*문서번호\s*\S+\s*개정번호\s*\S+\s*개정일자\s*[\d.\s]+년?월?일?",
    r"물질안전보건자료(?=\s|$)",
    r"페이지\s*[:：]\s*\d+\(\d+\)",
    r"SDS\s*번호\s*[:：]\s*\S+",
    r"최종개정일자\s*[:：]\s*[\d.]+",
    r"본\s*물질안전보건자료는\s*산업안전보건법\s*및\s*시행규칙에\s*의거하여\s*작성",
    r"\S{1,20}\s+\d+\s*페이지\s*중\s*\d+\s*페이지\s*MSDS-\S+\s*\(rev\.\d+\)",
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
    "storage": r"안전한\s*저장\s*방법",
}
PPE_LABELS = {
    "respiratory": r"호흡기\s*보호",
    "eye": r"눈\s*/?\s*안면\s*보호",
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

def _capture_after_label(text, label_pattern, max_chars=150):
    m = re.search(rf"{label_pattern}\s*[:：]?\s*", text)
    if not m:
        return ""
    rest = text[m.end():]
    # 첫 STOP 지점이 거의 즉시(빈 캡처 수준)라면 같은 항목의 하위번호
    # (예: "6.2. 환경보호 6.2.1. 대기 : ...")일 가능성이 높으므로 그 마커를
    # 건너뛰고(캡처 시작점도 함께 이동) 다음 STOP까지 계속 찾는다(최대 3회).
    search_from = 0
    content_start = 0
    end = len(rest)
    for _ in range(3):
        stop_m = re.search(_STOP_MATCH, rest[search_from:])
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
    code_m = re.match(r"[A-Za-z][A-Za-z0-9\-]{1,19}", window)
    if code_m:
        return code_m.group(0)
    stop_m = re.search(STOP, window)
    captured = (window[:stop_m.start()] if stop_m else window).strip()
    code_m2 = re.search(r"[A-Za-z][A-Za-z0-9\-]{1,19}", captured)
    if code_m2 and len(captured) > len(code_m2.group(0)) + 10:
        return code_m2.group(0)
    return captured


_PHONE_RE = re.compile(r"\d{2,4}[-–]\d{3,4}[-–]\d{4}")


def _parse_supplier_phone(section1):
    for label in (r"긴급\s*전화\s*번호", r"긴급연락\s*전화", r"긴급\s*연락처", r"TEL"):
        val = _capture_after_label(section1, label, max_chars=100)
        m = _PHONE_RE.search(val)
        if m:
            return m.group(0)
    m = _PHONE_RE.search(section1)
    return m.group(0) if m else ""


def _parse_section1(section1):
    name = _parse_product_name(section1)
    supplier_name = ""
    for label in (r"제조자\s*정보", r"회사명"):
        val = _capture_after_label(section1, label)
        if val:
            supplier_name = val
            break
    supplier_address = _capture_after_label(section1, r"주\s*소", max_chars=120)
    supplier_phone = _parse_supplier_phone(section1)
    return name, supplier_name, supplier_address, supplier_phone


# --------------------------------------------------------------------------
# 섹션 2: 유해성・위험성 (분류, 신호어, H-code, P-code)
# --------------------------------------------------------------------------

def _parse_classification(section2):
    body = re.sub(rf"유해성?{SEP}?\s*위험성\s*분류", "", section2, count=1)
    pairs = []
    for m in re.finditer(r"([가-힣][가-힣0-9()\-/\s]{1,30}?)\s*[:：]?\s*구분\s*(\d+)", body):
        pairs.append((m.group(1).strip(), f"구분{m.group(2)}"))
        if len(pairs) >= 8:
            break
    return pairs


def _parse_signal_word(section2):
    m = re.search(r"신호어\s*[:：]?\s*(위험|경고)", section2)
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
            rf"(?:(?<![가-힣])[{_ORDINAL_CHARS}]\)|\d+\)|\d+(?:\.\d+)+|[HP]\d{{3}}|예방조치문구|응급조치요령)", window
        )
        candidates = [c.end() if c is period_m else c.start() for c in (period_m, marker_m) if c]
        desc = window[:min(candidates)] if candidates else window
        out.append((m.group(0), desc.strip(), m.start()))
    return out


def _group_precaution_codes(section2, p_entries):
    group_labels = {"prevention": "예방", "response": "대응", "storage": "저장", "disposal": "폐기"}
    anchors = []
    for key, word in group_labels.items():
        for m in re.finditer(rf"(?:[{_ORDINAL_CHARS}]\)|\d+(?:\.\d+)+\.?)\s*{word}\b", section2):
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

def _parse_composition(section3):
    section3 = re.sub(r"구성\s*성분의?\s*명칭\s*및\s*함유량", "", section3)
    section3 = re.sub(r"화학\s*물질명|물질명|이명\s*\(관용명\)|이명", "", section3)
    out = []
    cas_matches = list(_CAS_RE.finditer(section3))
    for i, m in enumerate(cas_matches):
        before_start = cas_matches[i - 1].end() if i > 0 else 0
        before = section3[max(before_start, m.start() - 40):m.start()]
        name_m = re.search(r"[가-힣]+", before)
        name = name_m.group(0) if name_m else ""
        if not name or name in _COMPOSITION_HEADER_NOISE:
            name = KNOWN_CAS_NAMES.get(m.group(0), name)

        after_end = cas_matches[i + 1].start() if i + 1 < len(cas_matches) else len(section3)
        after = section3[m.end():after_end]
        eu_m = re.match(r"\s*\d+-\d+(?:-\d+)?/[A-Z]{1,4}-?\d*\s*", after)
        search_area = after[eu_m.end():] if eu_m else after
        content_m = re.search(r"[<>]?\s*\d[\d.]*(?:\s*~\s*\d[\d.]*)?", search_area)
        content = re.sub(r"\s+", "", content_m.group(0)) if content_m else ""
        if name and content:
            out.append((name, m.group(0), content))
    return out


# --------------------------------------------------------------------------
# 섹션 4~8: 응급조치/화재/누출/취급저장/보호구
# --------------------------------------------------------------------------

def _parse_first_aid(section4):
    out = {}
    for key, label in FIRST_AID_LABELS.items():
        m = re.search(label, section4)
        if not m:
            continue
        captured = _capture_after_label(section4, label, max_chars=200)
        out[key] = {"label": m.group(0), "text": _first_sentences(captured)}
    return out


def _parse_firefighting(section5):
    out = {}
    for key, label in FIREFIGHTING_LABELS.items():
        if not re.search(label, section5):
            continue
        captured = _capture_after_label(section5, label, max_chars=150)
        out[key] = _first_sentences(captured, max_sentences=1, max_chars=80)
    return out


def _parse_accidental_release(section6):
    out = {}
    for key, label in ACCIDENTAL_RELEASE_LABELS.items():
        if not re.search(label, section6):
            continue
        captured = _capture_after_label(section6, label, max_chars=150)
        out[key] = _first_sentences(captured, max_sentences=1, max_chars=80)
    return out


def _parse_handling_storage(section7):
    out = {}
    for key, label in HANDLING_STORAGE_LABELS.items():
        if not re.search(label, section7):
            continue
        captured = _capture_after_label(section7, label, max_chars=400)
        out[key] = _sentences(captured, max_sentences=4, max_chars_each=85)
    return out


def _parse_exposure_controls(section8):
    out = {}
    for key, label in PPE_LABELS.items():
        if not re.search(label, section8):
            continue
        captured = _capture_after_label(section8, label, max_chars=200)
        out[key] = _first_sentences(captured, max_sentences=1, max_chars=80)
    return out


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

    data.composition = _parse_composition(sections.get(3, ""))
    data.first_aid = _parse_first_aid(sections.get(4, ""))
    data.firefighting = _parse_firefighting(sections.get(5, ""))
    data.accidental_release = _parse_accidental_release(sections.get(6, ""))
    data.handling_storage = _parse_handling_storage(sections.get(7, ""))
    data.exposure_controls = _parse_exposure_controls(sections.get(8, ""))
    data.revision_date = revision_date

    return data
