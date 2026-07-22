"""산업안전보건법 표준 16개 항목(KOSHA) 형식의 MSDS PDF를 파싱한다.

파서는 아래를 가정한다:
  - 매 페이지 상단에 "물질안전보건자료 / 페이지: N(M) / SDS 번호: ... /
    최종개정일자: ... / 본 물질안전보건자료는 ... 작성" 형태의 반복 머리말이 있다.
  - 1.~16. 로 시작하는 16개 대항목이 이 순서 그대로 존재한다.
  - 대항목 내부는 "가./나./다." 및 "1)/2)/3)" 하위 항목으로 구성된다.

형식이 다른 MSDS(다른 회사 양식, 스캔본 등)에는 그대로 적용되지 않을 수 있으며,
그 경우 각 파싱 함수를 개별적으로 조정해야 한다.
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

_BOILERPLATE_PATTERNS = [
    re.compile(r"^\s*물질안전보건자료\s*$"),
    re.compile(r"^\s*페이지\s*[:：]\s*\d+\(\d+\)\s*$"),
    re.compile(r"^\s*SDS\s*번호\s*[:：]"),
    re.compile(r"^\s*최종개정일자\s*[:：]"),
    re.compile(r"^\s*본\s*물질안전보건자료는.*작성\s*$"),
]

_REVISION_DATE_RE = re.compile(r"최종개정일자\s*[:：]\s*([\d.]+)")

_HCODE_RE = re.compile(r"^(H\d{3}(?:\+H\d{3})*)\s*[:：]\s*(.+)$")
_PCODE_RE = re.compile(r"^(P\d{3}(?:\+P\d{3})*)\s*[:：]\s*(.+)$")
_SECTION_HEADER_RE = re.compile(r"^(\d{1,2})\.\s+(\S.*)$")
_SUB_KO_RE = re.compile(r"^([가-힣])\.\s+(.*)$")
_CAS_RE = re.compile(r"\d{2,7}-\d{2}-\d")


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
    first_aid: dict = field(default_factory=dict)             # {eye/skin/inhalation/ingestion/other: {"label","text"}}
    firefighting: dict = field(default_factory=dict)          # {extinguishing/hazards/protective: [str,...]}
    accidental_release: dict = field(default_factory=dict)    # {personal/environmental/cleanup: [str,...]}
    handling_storage: dict = field(default_factory=dict)      # {handling/storage: [sentence, ...]}
    exposure_controls: dict = field(default_factory=dict)     # {respiratory/eye/hand/body: [str,...]}
    revision_date: str = ""


def extract_raw_text(pdf_path):
    text, _ = extract_raw_text_and_revision_date(pdf_path)
    return text


def extract_raw_text_and_revision_date(pdf_path):
    reader = PdfReader(pdf_path)
    pages = []
    revision_date = ""
    for pg in reader.pages:
        text = pg.extract_text() or ""
        for ln in text.split("\n"):
            if not revision_date:
                m = _REVISION_DATE_RE.search(ln)
                if m:
                    revision_date = m.group(1)
        lines = [ln.rstrip() for ln in text.split("\n")]
        kept = [ln for ln in lines if ln.strip() and not _is_boilerplate(ln)]
        pages.append("\n".join(kept))
    return "\n".join(pages), revision_date


def _is_boilerplate(line):
    return any(p.match(line) for p in _BOILERPLATE_PATTERNS)


def split_sections(full_text):
    """전체 텍스트를 {번호: 본문} 딕셔너리로 나눈다."""
    lines = full_text.split("\n")
    boundaries = []  # (line_index, section_no)
    expected = 1
    for i, ln in enumerate(lines):
        m = _SECTION_HEADER_RE.match(ln.strip())
        if m and int(m.group(1)) == expected and expected <= 16:
            boundaries.append((i, expected))
            expected += 1
    boundaries.append((len(lines), None))

    sections = {}
    for (start, no), (end, _) in zip(boundaries, boundaries[1:]):
        header_line = lines[start].strip()
        header_m = _SECTION_HEADER_RE.match(header_line)
        remainder = header_m.group(2)
        body_lines = [remainder] + lines[start + 1:end]
        sections[no] = "\n".join(l for l in body_lines if l.strip())
    return sections


def _split_ko_subitems(text):
    """'가./나./다.' 로 시작하는 하위 항목을 {글자: 본문} 으로 나눈다."""
    lines = text.split("\n")
    boundaries = []
    for i, ln in enumerate(lines):
        m = _SUB_KO_RE.match(ln.strip())
        if m:
            boundaries.append((i, m.group(1)))
    if not boundaries:
        return {}
    boundaries.append((len(lines), None))
    out = {}
    for (start, key), (end, _) in zip(boundaries, boundaries[1:]):
        m = _SUB_KO_RE.match(lines[start].strip())
        body = "\n".join([m.group(2)] + lines[start + 1:end])
        out[key] = body.strip()
    return out


def _split_ko_subitems_titled(text):
    """가./나./다. 하위 항목을 {글자: (제목, 본문)} 으로 나눈다.
    KOSHA 서식은 '가. <제목 한 줄>\\n<내용 문장들>' 패턴을 따른다."""
    raw = _split_ko_subitems(text)
    out = {}
    for key, body in raw.items():
        lines = body.split("\n", 1)
        title = lines[0].strip()
        rest = lines[1].strip() if len(lines) > 1 else ""
        out[key] = (title, rest)
    return out


def _collect_coded_statements(text, code_re):
    """'Hxxx : 설명' / 'Pxxx : 설명' 줄들을 (코드, 설명) 목록으로 모은다.
    설명이 다음 줄로 개행된 경우 새 코드가 나오기 전까지 이어붙인다."""
    out = []
    for raw_line in text.split("\n"):
        line = raw_line.strip()
        if not line:
            continue
        m = code_re.match(line)
        if m:
            out.append([m.group(1), m.group(2).strip()])
        elif out:
            out[-1][1] = (out[-1][1] + " " + line).strip()
    return [tuple(x) for x in out]


def _parse_product_info(section1):
    name = ""
    desc = ""
    m = re.search(r"제품명\s*[:：]\s*(.*)", section1)
    if m:
        desc = m.group(1).strip()
        idx = section1.find(m.group(0))
        after = section1[idx + len(m.group(0)):].split("\n")
        for ln in after:
            ln = ln.strip()
            if not ln:
                continue
            if ln.startswith("나.") or _SUB_KO_RE.match(ln):
                break
            name = ln
            break
    supplier_name = _search_after_label(section1, "회사명")
    supplier_address = _search_after_label(section1, "주\\s*소")
    supplier_phone = _search_after_label(section1, "긴급전화번호")
    return name or desc, desc, supplier_name, supplier_address, supplier_phone


def _search_after_label(text, label):
    m = re.search(rf"{label}\s*[:：]?\s*(.+)", text)
    return m.group(1).strip() if m else ""


_CLASSIFICATION_LABEL_RE = re.compile(r"^유해성[•·ㆍ]?위험성\s*분류\s*")


def _parse_classification(section2):
    sub = _split_ko_subitems(section2)
    body = sub.get("가", "")
    body = _CLASSIFICATION_LABEL_RE.sub("", body, count=1)
    pairs = []
    for line in body.split("\n"):
        line = line.strip()
        m = re.match(r"^(.+?)\s*[:：]\s*(구분\s*\d+[A-Za-z]?|해당없음|비분류)\s*$", line)
        if m:
            pairs.append((m.group(1).strip(), re.sub(r"\s+", "", m.group(2))))
    return pairs


def _parse_precaution(section2):
    sub = _split_ko_subitems(section2)
    body = sub.get("나", "")
    # 나. 하위는 1)그림문자 2)신호어 3)유해위험문구 4)예방조치문구(가~라)
    signal_m = re.search(r"신호어\s*(위험|경고)", body)
    signal_word = signal_m.group(1) if signal_m else ""

    h_block_m = re.search(r"유해[·ㆍ•]위험문구\s*(.+?)(?=\n\s*4\)|\Z)", body, re.S)
    h_block = h_block_m.group(1) if h_block_m else ""
    hazard_statements = _collect_coded_statements(h_block, _HCODE_RE)

    p_block_m = re.search(r"예방조치문구\s*(.+)\Z", body, re.S)
    p_block = p_block_m.group(1) if p_block_m else ""

    lines = p_block.split("\n")
    labels = {"가": "prevention", "나": "response", "다": "storage", "라": "disposal"}
    # 각 그룹 표제 뒤에 개행 없이 "예방/대응/저장/폐기" 라는 단어가 곧바로 붙고,
    # 그 뒤를 이어 첫 P-code가 같은 줄에 등장한다("가) 예방 P201 : ..."). 이 표제어를
    # 제거하지 않으면 첫 P-code 줄이 Pxxx로 시작하지 않아 누락된다.
    group_titles = {"prevention": "예방", "response": "대응", "storage": "저장", "disposal": "폐기"}
    label_re = re.compile(r"^([가-힣])\)\s*(.*)$")
    cur = None
    buf = {k: [] for k in labels.values()}
    for ln in lines:
        ln = ln.strip()
        m = label_re.match(ln)
        if m and m.group(1) in labels:
            cur = labels[m.group(1)]
            ln = m.group(2)
            ln = re.sub(rf"^{group_titles[cur]}\s*", "", ln, count=1)
            if not ln:
                continue
        if cur:
            buf[cur].append(ln)

    precaution = {}
    for key in labels.values():
        text = "\n".join(buf[key])
        precaution[key] = _collect_coded_statements(text, _PCODE_RE)

    return signal_word, hazard_statements, precaution


def _parse_composition(section3):
    out = []
    for raw in section3.split("\n"):
        line = raw.strip()
        if not line or "물질명" in line and "CAS" in line:
            continue
        cas_m = _CAS_RE.search(line)
        if not cas_m:
            continue
        cas = cas_m.group(0)
        before = line[:cas_m.start()].strip()
        after = line[cas_m.end():].strip()
        parts = before.split()
        if not parts:
            continue
        name = parts[0]
        content_m = re.search(r"[<>]?\s*\d[\d.~]*", after)
        content = content_m.group(0).replace(" ", "") if content_m else after.split()[0] if after else ""
        out.append((name, cas, content))
    return out


def _join_wrapped_lines(text):
    """PDF 추출 시 한 문장이 줄바꿈으로 잘린 경우('...' 로 끝나지 않는 줄) 다음
    줄과 이어 붙여 온전한 문장 단위로 되돌린다."""
    out = []
    buf = ""
    for raw in text.split("\n"):
        ln = raw.strip()
        if not ln:
            continue
        buf = f"{buf} {ln}".strip() if buf else ln
        if buf.endswith((".", ":", "：")):
            out.append(buf)
            buf = ""
    if buf:
        out.append(buf)
    return out


def _sentences(text, max_sentences=4, max_chars_each=90):
    """text 를 (줄바꿈으로 잘린 문장을 복원한 뒤) 문장 목록으로 반환한다."""
    logical_lines = _join_wrapped_lines(text)
    combined = " ".join(logical_lines)
    sentences = re.split(r"(?<=[.!?])\s+", combined.strip())
    sentences = [s.strip() for s in sentences if s.strip()]
    out = []
    for s in sentences[:max_sentences]:
        if len(s) > max_chars_each:
            s = s[:max_chars_each].rstrip() + "…"
        out.append(s)
    return out


def _first_sentences(text, max_sentences=2, max_chars=90):
    return " ".join(_sentences(text, max_sentences=max_sentences, max_chars_each=max_chars))


def _parse_first_aid(section4):
    """각 항목을 {"label": 상황(예: 눈에 들어갔을 때), "text": 조치 요약} 으로 반환한다."""
    sub = _split_ko_subitems_titled(section4)
    mapping = {"가": "eye", "나": "skin", "다": "inhalation", "라": "ingestion", "마": "other"}
    out = {}
    for k, v in mapping.items():
        if k in sub:
            title, rest = sub[k]
            out[v] = {"label": title, "text": _first_sentences(rest)}
    return out


def _parse_firefighting(section5):
    sub = _split_ko_subitems_titled(section5)
    mapping = {"가": "extinguishing", "나": "hazards", "다": "protective"}
    return {v: _first_sentences(sub[k][1], max_sentences=1, max_chars=80) for k, v in mapping.items() if k in sub}


def _parse_accidental_release(section6):
    sub = _split_ko_subitems_titled(section6)
    mapping = {"가": "personal", "나": "environmental", "다": "cleanup"}
    return {v: _first_sentences(sub[k][1], max_sentences=1, max_chars=80) for k, v in mapping.items() if k in sub}


def _parse_handling_storage(section7):
    """카테고리별 문장 목록(list[str])을 반환한다 (관리요령 슬라이드에서 항목별로
    불릿 하나씩 표시하기 위함)."""
    sub = _split_ko_subitems_titled(section7)
    mapping = {"가": "handling", "나": "storage"}
    return {v: _sentences(sub[k][1], max_sentences=4, max_chars_each=85) for k, v in mapping.items() if k in sub}


def _parse_exposure_controls(section8):
    sub = _split_ko_subitems(section8)
    body = sub.get("다", "")
    inner = _split_ko_num_subitems(body)
    mapping = {"1": "respiratory", "2": "eye", "3": "hand", "4": "body"}
    out = {}
    for k, v in mapping.items():
        if k in inner:
            lines = inner[k].split("\n", 1)
            rest = lines[1].strip() if len(lines) > 1 else lines[0].strip()
            out[v] = _first_sentences(rest, max_sentences=1, max_chars=80)
    return out


_NUM_SUB_RE = re.compile(r"^(\d)\)\s*(.*)$")


def _split_ko_num_subitems(text):
    lines = text.split("\n")
    boundaries = []
    for i, ln in enumerate(lines):
        m = _NUM_SUB_RE.match(ln.strip())
        if m:
            boundaries.append((i, m.group(1)))
    if not boundaries:
        return {}
    boundaries.append((len(lines), None))
    out = {}
    for (start, key), (end, _) in zip(boundaries, boundaries[1:]):
        m = _NUM_SUB_RE.match(lines[start].strip())
        body = "\n".join([m.group(2)] + lines[start + 1:end])
        out[key] = body.strip()
    return out


def parse_msds(pdf_path):
    raw, revision_date = extract_raw_text_and_revision_date(pdf_path)
    sections = split_sections(raw)

    data = MSDSData()
    name, desc, s_name, s_addr, s_phone = _parse_product_info(sections.get(1, ""))
    data.product_name = name
    data.product_name_desc = desc
    data.supplier_name = s_name
    data.supplier_address = s_addr
    data.supplier_phone = s_phone

    data.classification = _parse_classification(sections.get(2, ""))
    signal_word, hazard_statements, precaution = _parse_precaution(sections.get(2, ""))
    data.signal_word = signal_word
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
