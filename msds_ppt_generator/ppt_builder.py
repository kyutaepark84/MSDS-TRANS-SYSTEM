"""MSDSData -> 현장경고표지/관리요령 PPTX 생성.

두 템플릿(templates/label_template.pptx, templates/handling_template.pptx)의
도형 이름과 표 구조는 고정되어 있다고 가정하고, 해당 도형/셀의 텍스트와 그림문자
이미지만 교체한다. 서식(글꼴, 크기, 색, 표 테두리 등)은 템플릿의 것을 그대로 재사용한다.
"""

import copy
import os
import re

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.oxml.ns import qn
from pptx.util import Emu

from . import ghs

PKG_DIR = os.path.dirname(os.path.abspath(__file__))
LABEL_TEMPLATE = os.path.join(PKG_DIR, "templates", "label_template.pptx")
HANDLING_TEMPLATE = os.path.join(PKG_DIR, "templates", "handling_template.pptx")
PICTOGRAM_DIR = os.path.join(PKG_DIR, "assets", "pictograms")

BULLET = "▪"   # ▪
ARROW = "▶"    # ▶

# 표에 넣을 최대 항목 수(칸이 고정 크기라 너무 많으면 넘칠 수 있음)
MAX_PREVENTION_ITEMS = 8
MAX_HANDLING_BULLETS = 4
MAX_HAZARD_BULLETS = 8


# --------------------------------------------------------------------------
# 공용 XML 유틸
# --------------------------------------------------------------------------

def _first_run_text_elem(p_elem):
    r = p_elem.find(qn("a:r"))
    if r is None:
        return None
    return r.find(qn("a:t"))


def _set_paragraph_text(p_elem, text):
    """단락의 첫 run 텍스트를 교체하고, 첫 run 외 나머지 run은 제거한다."""
    runs = p_elem.findall(qn("a:r"))
    if not runs:
        return
    t = runs[0].find(qn("a:t"))
    if t is None:
        return
    t.text = text
    t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    for extra in runs[1:]:
        p_elem.remove(extra)


def _replace_paragraphs(txBody, lines, template_index=0):
    """txBody 안의 <a:p> 들을 지우고, template_index 번째 단락 서식을 복제해
    lines 개수만큼 새로 만든다."""
    ps = txBody.findall(qn("a:p"))
    if not ps:
        return
    template = copy.deepcopy(ps[min(template_index, len(ps) - 1)])
    for p in ps:
        txBody.remove(p)
    if not lines:
        lines = [""]
    for line in lines:
        new_p = copy.deepcopy(template)
        _set_paragraph_text(new_p, line)
        txBody.append(new_p)


def _txbody_of(shape_or_cell):
    return shape_or_cell.text_frame._txBody


# --------------------------------------------------------------------------
# 공급자 정보 자동 줄맞춤(최소 10pt, 1줄이 안 되면 2줄)
# --------------------------------------------------------------------------

EMU_PER_PT = 12700
FOOTER_MAX_FONT_PT = 12
FOOTER_MIN_FONT_PT = 10
# ※ ☎ ★ ☆ ☀ 등 한글 문서에서 흔히 쓰이는 전각 기호 + 한글 음절/자모/한자 범위
_WIDE_CHAR_EXTRA = {0x203B, 0x260E, 0x2605, 0x2606, 0x2600}


def _is_wide_char(ch):
    cp = ord(ch)
    return (
        0xAC00 <= cp <= 0xD7A3
        or 0x3130 <= cp <= 0x318F
        or 0x2E80 <= cp <= 0x9FFF
        or cp in _WIDE_CHAR_EXTRA
    )


def _estimate_text_width_emu(text, size_pt):
    """실제 폰트 메트릭 없이, 한글/전각 기호는 정사각(1.0em), 영문·숫자·기타는
    0.55em, 공백은 0.28em 정도로 어림잡아 텍스트 폭을 추정한다. 폭을 넉넉히
    잡는 쪽(과대추정)이 실제보다 일찍 두 줄로 나누게 되어 더 안전하다."""
    width_em = 0.0
    for ch in text:
        if ch == " ":
            width_em += 0.28
        elif _is_wide_char(ch):
            width_em += 1.0
        else:
            width_em += 0.55
    return width_em * size_pt * EMU_PER_PT


def _fit_footer_lines(address, company, phone, available_width_emu):
    """전체 문구가 available_width_emu 안에 최대(12pt)~최소(10pt) 크기로 한 줄에
    들어가면 그 크기의 한 줄로, 10pt에서도 안 들어가면 두 줄로 나눈다. 전화번호가
    혼자 한 줄을 차지하지 않도록, 우선 회사명과 같은 줄에 붙여본다(그래도 안
    맞으면 전화번호만 따로 뺀다). 항상 10pt 이상을 유지한다."""
    full = f"※ 공급자 정보 : {address}  {company} ☎ {phone}"
    for size in range(FOOTER_MAX_FONT_PT, FOOTER_MIN_FONT_PT - 1, -1):
        if _estimate_text_width_emu(full, size) <= available_width_emu:
            return [full], size

    size = FOOTER_MIN_FONT_PT
    candidates = [
        (f"※ 공급자 정보 : {address}", f"{company}  ☎ {phone}"),
        (f"※ 공급자 정보 : {address}  {company}", f"☎ {phone}"),
    ]
    for line1, line2 in candidates:
        if (_estimate_text_width_emu(line1, size) <= available_width_emu
                and _estimate_text_width_emu(line2, size) <= available_width_emu):
            return [line1, line2], size
    # 둘 다 안 맞아도(주소가 극단적으로 긴 경우) 최소 크기로 최선의 후보를 사용
    return list(candidates[0]), size


def _set_footer_text(shape, lines, size_pt, max_bottom=None):
    """자동 축소(normAutofit)를 끄고 지정한 크기를 그대로 적용한다. 두 줄이 되어
    글상자 높이를 늘려야 할 때는 아래쪽 경계(max_bottom, 보통 라벨 바깥 굵은
    테두리 선의 y좌표)를 넘지 않도록 위쪽으로만 확장한다."""
    txBody = _txbody_of(shape)
    bodyPr = txBody.find(qn("a:bodyPr"))
    for tag in ("a:normAutofit", "a:spAutoFit"):
        el = bodyPr.find(qn(tag))
        if el is not None:
            bodyPr.remove(el)
    if bodyPr.find(qn("a:noAutofit")) is None:
        bodyPr.append(bodyPr.makeelement(qn("a:noAutofit"), {}))

    t_ins = int(bodyPr.get("tIns", "45720"))
    b_ins = int(bodyPr.get("bIns", "45720"))

    _replace_paragraphs(txBody, lines)
    for p in txBody.findall(qn("a:p")):
        for r in p.findall(qn("a:r")):
            rPr = r.find(qn("a:rPr"))
            if rPr is not None:
                rPr.set("sz", str(int(size_pt * 100)))

    needed_height = int(len(lines) * size_pt * 1.2 * EMU_PER_PT) + t_ins + b_ins
    if needed_height > shape.height:
        bottom = shape.top + shape.height
        if max_bottom is not None:
            bottom = min(bottom, max_bottom)
        shape.height = needed_height
        shape.top = bottom - needed_height


# --------------------------------------------------------------------------
# 제품명 + 성분 목록 글상자 자동 축소
# --------------------------------------------------------------------------

TITLE_FIXED_FONT_PT = 36
COMPOSITION_MAX_FONT_PT = 12
COMPOSITION_MIN_FONT_PT = 8
_LINE_HEIGHT_FACTOR = 1.2
# 그림문자(그림)와 상자 사이에 남겨 둘 최소 여백.
PICTOGRAM_GAP_EMU = 50000


def _fit_label_composition_size(n_rows, t_ins, b_ins, top_gap_emu, max_height_emu, title_lines=1):
    """제목(36pt 고정) + 성분 목록이 상자 높이 안에 들어가도록 성분 목록
    글자 크기와 상자에 필요한 높이를 정한다. 상자는 세로 가운데 정렬(anchor=ctr)
    이라 내용이 길어지면 위/아래로 넘쳐 인쇄 서식 경계(제목 위쪽 테두리, 그림문자
    영역)를 넘어갈 수 있어, 성분 목록 글자 크기부터 줄이고 그래도 안 맞으면
    상자 높이를(그림문자와 겹치지 않는 한도까지) 늘린다. 제품명이 길어 제목이
    여러 줄로 줄바꿈되는 경우, title_lines로 그 줄 수를 반영해야 높이 계산이
    맞다(1줄로 가정하면 실제로 2줄 이상 넘칠 때 다시 테두리를 침범한다)."""
    title_height_factor = TITLE_FIXED_FONT_PT * title_lines
    for content_pt in range(COMPOSITION_MAX_FONT_PT, COMPOSITION_MIN_FONT_PT - 1, -1):
        needed = (_LINE_HEIGHT_FACTOR * (title_height_factor + content_pt * n_rows) * EMU_PER_PT
                  + t_ins + b_ins + 2 * top_gap_emu)
        if needed <= max_height_emu:
            return content_pt, needed
    content_pt = COMPOSITION_MIN_FONT_PT
    needed = (_LINE_HEIGHT_FACTOR * (title_height_factor + content_pt * n_rows) * EMU_PER_PT
              + t_ins + b_ins + 2 * top_gap_emu)
    return content_pt, min(needed, max_height_emu)


# --------------------------------------------------------------------------
# 그림문자(그림) 배치
# --------------------------------------------------------------------------

def _remove_pictures(slide, names):
    for shape in list(slide.shapes):
        if shape.name in names:
            shape._element.getparent().remove(shape._element)


MAX_PICTOGRAMS = 6  # 동시에 표시할 그림문자 최대 개수(실제 GHS 라벨에서 5개 이상
                     # 동시 적용은 드묾). 그 이상은 우선순위(GHS01→GHS09) 상위만 표시.


def _place_pictogram_row(slide, slide_width, codes, band_left, band_top, max_size, gap=Emu(150000)):
    codes = codes[:MAX_PICTOGRAMS]
    n = len(codes)
    if n == 0:
        return
    band_width = slide_width - 2 * band_left
    # 아이콘이 template 원본(최대 3개칸)보다 많아지면 축소해서 같은 폭에 맞추되,
    # 원래 크기의 45% 밑으로는 줄이지 않는다(그 이하로는 식별이 어려움 -> 여백을 조금 침범).
    min_size = int(max_size) * 0.45
    size = min(int(max_size), int((band_width - (n - 1) * gap) / n))
    size = max(size, int(min_size))
    total = n * size + (n - 1) * int(gap)
    start_x = int(band_left + (band_width - total) / 2)
    for i, code in enumerate(codes):
        _, filename = ghs.PICTOGRAMS[code]
        path = os.path.join(PICTOGRAM_DIR, filename)
        x = start_x + i * (size + int(gap))
        slide.shapes.add_picture(path, x, int(band_top), size, size)


def _place_pictogram_row_in_cell(slide, cell_left, cell_top, cell_width, cell_height, codes,
                                  gap=Emu(150000), pad_ratio=0.08):
    """표 칸(cell) 안에 그림문자를 가로 중앙 정렬로 배치하고, 칸 높이(세로)를
    기준으로 테두리를 넘지 않는 한도 내에서 최대한 크게 키운다. 아이콘이 많아
    가로 폭이 부족해지면 폭 기준으로 다시 줄인다."""
    codes = codes[:MAX_PICTOGRAMS]
    n = len(codes)
    if n == 0:
        return
    max_size_by_height = int(cell_height * (1 - pad_ratio))
    max_size_by_width = int((cell_width - (n - 1) * int(gap)) / n)
    size = max(1, min(max_size_by_height, max_size_by_width))
    total = n * size + (n - 1) * int(gap)
    start_x = int(cell_left + (cell_width - total) / 2)
    y = int(cell_top + (cell_height - size) / 2)
    for i, code in enumerate(codes):
        _, filename = ghs.PICTOGRAMS[code]
        path = os.path.join(PICTOGRAM_DIR, filename)
        x = start_x + i * (size + int(gap))
        slide.shapes.add_picture(path, x, y, size, size)


# --------------------------------------------------------------------------
# 유해・예방조치 문구 선택
# --------------------------------------------------------------------------

def _select_precaution_lines(precaution):
    lines = []
    for code, desc in precaution.get("prevention", [])[:MAX_PREVENTION_ITEMS]:
        lines.append(f"{BULLET} {desc}")
    for group in ("response", "storage", "disposal"):
        items = precaution.get(group, [])
        if items:
            code, desc = items[0]
            lines.append(f"{BULLET} {desc}")
    return lines


_WS_RE = re.compile(r"\s+")


def _normalize(text):
    return _WS_RE.sub("", text or "")


def _classification_lookup(classification):
    return {_normalize(family): category for family, category in classification}


def _hazard_bullets(hazard_statements, classification):
    """행 높이가 고정되어 있어 문장을 짧게 유지해야 하므로, 유해성 분류항목명은
    생략하고 구분 번호만 덧붙인다."""
    lookup = _classification_lookup(classification)
    lines = []
    for code, desc in hazard_statements[:MAX_HAZARD_BULLETS]:
        family = ghs.family_for_hcode(code.split("+")[0])
        category = lookup.get(_normalize(family)) if family else None
        if category:
            lines.append(f"- {desc}({category})")
        else:
            lines.append(f"- {desc}")
    return lines


# --------------------------------------------------------------------------
# 템플릿 A: 현장경고표지
# --------------------------------------------------------------------------

def build_label_slide(msds, out_path, template_path=LABEL_TEMPLATE):
    prs = Presentation(template_path)
    slide = prs.slides[0]

    shapes = {s.name: s for s in slide.shapes}

    # 제품명 + 성분 목록
    rect14 = shapes["Rectangle 14"]
    txBody = _txbody_of(rect14)
    ps = txBody.findall(qn("a:p"))
    title_p = ps[0]
    _set_paragraph_text(title_p, msds.product_name)
    comp_template_idx = 1 if len(ps) > 1 else 0
    comp_template = copy.deepcopy(ps[comp_template_idx])
    for p in ps[1:]:
        txBody.remove(p)
    for name, cas, content in msds.composition:
        new_p = copy.deepcopy(comp_template)
        content_disp = content if content.endswith("%") else f"{content}%"
        _set_paragraph_text(new_p, f"( CAS No. : {cas} ,  함유량 : {content_disp}) - {name}")
        txBody.append(new_p)

    # 상자가 세로 가운데 정렬이라, 성분이 많아 전체 내용이 길어지면 제목이
    # 위쪽 테두리를 넘어가거나 아래쪽 그림문자와 겹칠 수 있다. 제목은 항상
    # 36pt 굵게 고정하고, 성분 목록 글자 크기와 상자 높이를 성분 개수에 맞춰
    # 다시 계산해 위쪽 테두리와 그림문자 사이 안에 들어오도록 한다.
    bodyPr14 = txBody.find(qn("a:bodyPr"))
    t_ins14 = int(bodyPr14.get("tIns", "45720"))
    b_ins14 = int(bodyPr14.get("bIns", "45720"))
    l_ins14 = int(bodyPr14.get("lIns", "90000"))
    r_ins14 = int(bodyPr14.get("rIns", "90000"))
    outline = shapes.get("Rectangle 2")
    top_gap_emu = max(0, outline.top - rect14.top - t_ins14) if outline is not None else 0
    pic_tops = [s.top for s in slide.shapes if s.shape_type == MSO_SHAPE_TYPE.PICTURE]
    if pic_tops:
        max_bottom = min(pic_tops) - PICTOGRAM_GAP_EMU
        max_height = max(rect14.height, max_bottom - rect14.top)
    else:
        max_height = rect14.height
    # 제품명이 길면(특히 영문 제품명) 36pt 고정 폭에 한 줄로 안 들어가 줄바꿈될
    # 수 있다. 1줄로 가정하고 높이를 계산하면 실제로 2줄 이상이 될 때 다시
    # 테두리를 침범하므로, 줄바꿈 예상 줄 수를 미리 추정해 반영한다.
    title_usable_width = rect14.width - l_ins14 - r_ins14
    title_width = _estimate_text_width_emu(msds.product_name, TITLE_FIXED_FONT_PT)
    title_lines = max(1, -(-title_width // title_usable_width)) if title_usable_width > 0 else 1
    content_pt, required_height = _fit_label_composition_size(
        len(msds.composition), t_ins14, b_ins14, top_gap_emu, max_height, title_lines=title_lines
    )
    if required_height > rect14.height:
        rect14.height = int(required_height)
    for r in title_p.findall(qn("a:r")):
        rPr = r.find(qn("a:rPr"))
        if rPr is not None:
            rPr.set("sz", str(int(TITLE_FIXED_FONT_PT * 100)))
            rPr.set("b", "1")
    for p in txBody.findall(qn("a:p"))[1:]:
        for r in p.findall(qn("a:r")):
            rPr = r.find(qn("a:rPr"))
            if rPr is not None:
                rPr.set("sz", str(int(content_pt * 100)))

    # 신호어 (원본이 "신호어 : 해당없음"으로 명시한 문서는 실제로 GHS
    # 미분류 제품이라 신호어가 없는 것이 맞으므로, "경고"로 임의 대체하지
    # 않고 원본 값을 그대로(없으면 빈 칸으로) 반영한다.
    rect15 = shapes["Rectangle 15"]
    _set_paragraph_text(_txbody_of(rect15).find(qn("a:p")), msds.signal_word)

    # 공급자 정보 (최소 10pt 유지, 한 줄에 안 맞으면 전화번호 앞에서 두 줄로)
    rect16 = shapes["Rectangle 16"]
    phone = (msds.supplier_phone or "").split(",")[0].strip()
    bodyPr = _txbody_of(rect16).find(qn("a:bodyPr"))
    l_ins = int(bodyPr.get("lIns", "91440"))
    r_ins = int(bodyPr.get("rIns", "91440"))
    available_width = rect16.width - l_ins - r_ins
    footer_lines, footer_size = _fit_footer_lines(msds.supplier_address, msds.supplier_name, phone, available_width)
    outline = shapes.get("Rectangle 2")
    max_bottom = (outline.top + outline.height) if outline is not None else None
    _set_footer_text(rect16, footer_lines, footer_size, max_bottom=max_bottom)

    # 표: 유해ㆍ위험 문구 / 예방조치 문구
    table_shape = next(s for s in slide.shapes if s.has_table)
    tbl = table_shape.table
    # 유해・위험문구는 H-code(예: H317)를 표기하지 않고 문장만 표시한다
    hazard_lines = [f"{BULLET} {desc}" for code, desc in msds.hazard_statements[:MAX_HAZARD_BULLETS]]
    _replace_paragraphs(tbl.cell(0, 1).text_frame._txBody, hazard_lines)
    precaution_lines = _select_precaution_lines(msds.precaution)
    _replace_paragraphs(tbl.cell(1, 1).text_frame._txBody, precaution_lines)

    # 그림문자
    pic_names = {s.name for s in slide.shapes if s.shape_type == MSO_SHAPE_TYPE.PICTURE}
    first_pic = next(s for s in slide.shapes if s.name in pic_names)
    band_left, band_top, band_size = first_pic.left, first_pic.top, first_pic.width
    _remove_pictures(slide, pic_names)
    codes = ghs.pictograms_for_hcodes([c for c, _ in msds.hazard_statements])
    _place_pictogram_row(slide, prs.slide_width, codes, band_left, band_top, band_size)

    prs.save(out_path)


# --------------------------------------------------------------------------
# 템플릿 B: 관리요령
# --------------------------------------------------------------------------

def _join_fragments(parts):
    """서로 다른 레이블에서 뽑아낸 문장 조각들을 하나로 이어붙일 때, 앞
    조각이 마침표 등으로 끝나지 않으면 그냥 공백만 넣어 이어붙이지 않고
    마침표를 넣어 두 문장이 붙어 읽히지 않게 한다."""
    parts = [p for p in parts if p]
    out = ""
    for p in parts:
        if out and not out.endswith((".", "!", "?")):
            out += ". "
        elif out:
            out += " "
        out += p
    return out


def _accident_response_bullets(msds):
    lines = []
    fire = _join_fragments([msds.firefighting.get("extinguishing"), msds.firefighting.get("protective")])
    if fire:
        lines.append(f"- 화재 시 {fire}")
    leak = _join_fragments([msds.accidental_release.get("personal"), msds.accidental_release.get("environmental")])
    if leak:
        lines.append(f"- 누출 시 {leak}")
    return lines


def _ppe_bullets(msds):
    order = ["respiratory", "eye", "hand", "body"]
    return [f"- {msds.exposure_controls[k]}" for k in order if msds.exposure_controls.get(k)]


def _first_aid_bullets(msds):
    order = ["eye", "skin", "inhalation", "ingestion", "other"]
    lines = []
    for k in order:
        item = msds.first_aid.get(k)
        if not item:
            continue
        lines.append(f"{ARROW} {item['label']}")
        if item["text"]:
            lines.append(f"- {item['text']}")
    return lines


def _handling_bullets(msds):
    lines = [f"- {s}" for s in msds.handling_storage.get("handling", [])[:MAX_HANDLING_BULLETS]]
    storage = msds.handling_storage.get("storage", [])
    if storage:
        lines.append(f"- {storage[0]}")
    return lines


def build_handling_slide(msds, out_path, template_path=HANDLING_TEMPLATE):
    prs = Presentation(template_path)
    slide = prs.slides[0]

    table_shape = next(s for s in slide.shapes if s.has_table)
    tbl = table_shape.table

    # 템플릿 표의 실제 높이가 슬라이드 높이보다 조금 더 커서, 맨 아래 행
    # ("※ 기타 자세한 내용은...") 일부가 인쇄 가능 영역을 벗어나 있다. 표는
    # 이미 위쪽 테두리를 가리려고 top을 음수로 잡아둔 상태라, 그만큼 더
    # 위로 올려도 보이는 내용에는 영향이 없어 이 방식으로 넘치는 만큼 보정한다.
    overflow = (table_shape.top + table_shape.height) - prs.slide_height
    if overflow > 0:
        table_shape.top -= overflow

    _set_paragraph_text(tbl.cell(0, 0).text_frame._txBody.find(qn("a:p")), msds.product_name)

    _replace_paragraphs(tbl.cell(2, 1).text_frame._txBody, _hazard_bullets(msds.hazard_statements, msds.classification))
    _replace_paragraphs(tbl.cell(3, 1).text_frame._txBody, _handling_bullets(msds))
    _replace_paragraphs(tbl.cell(4, 1).text_frame._txBody, _ppe_bullets(msds))
    _replace_paragraphs(tbl.cell(5, 1).text_frame._txBody, _first_aid_bullets(msds))
    _replace_paragraphs(tbl.cell(6, 1).text_frame._txBody, _accident_response_bullets(msds))

    pic_names = {s.name for s in slide.shapes if s.shape_type == MSO_SHAPE_TYPE.PICTURE}
    _remove_pictures(slide, pic_names)
    # 그림문자 칸은 표 2번째 행(가로 두 칸 병합)이다. 그 칸의 실제 좌표를 계산해
    # 그 안에서 가로 중앙 정렬 + 칸 높이에 맞춘 최대 크기로 배치한다.
    rows = list(tbl.rows)
    pic_row_top = table_shape.top + rows[0].height
    pic_row_height = rows[1].height
    codes = ghs.pictograms_for_hcodes([c for c, _ in msds.hazard_statements])
    _place_pictogram_row_in_cell(slide, table_shape.left, pic_row_top, table_shape.width, pic_row_height, codes)

    prs.save(out_path)
