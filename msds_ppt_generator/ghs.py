"""GHS(Globally Harmonized System) 유해·위험문구(H-code) <-> 그림문자 매핑.

산업안전보건법/GHS 라벨 표시 기준(고용노동부고시)에 따른 표준 매핑표이다.
그림문자 배정은 국가/제품마다 예외 규칙(동일 유해성 내 그림문자 생략 우선순위 등)이
있을 수 있으므로, 여기서는 H-code -> 그림문자의 기본 매핑만 적용한다.
최종 라벨은 반드시 안전보건 담당자의 검토를 거쳐야 한다.
"""

from dataclasses import dataclass

PICTOGRAM_DIR_NAME = "assets/pictograms"

# 그림문자 코드 -> (한글명, 자산 파일명)
PICTOGRAMS = {
    "GHS01": ("폭발성물질", "ghs01_explosive.png"),
    "GHS02": ("인화성물질", "ghs02_flame.png"),
    "GHS03": ("산화성물질", "ghs03_oxidizer.png"),
    "GHS04": ("고압가스", "ghs04_gas_cylinder.png"),
    "GHS05": ("부식성물질", "ghs05_corrosion.png"),
    "GHS06": ("급성독성물질", "ghs06_toxic.png"),
    "GHS07": ("느낌표(경고표시)", "ghs07_exclamation.png"),
    "GHS08": ("건강유해성", "ghs08_health.png"),
    "GHS09": ("환경유해성", "ghs09_environment.png"),
}

# 그림문자 표시 우선순위(GHS01 -> GHS09 순으로 왼쪽부터 배치)
PICTOGRAM_ORDER = list(PICTOGRAMS.keys())


@dataclass(frozen=True)
class HCodeInfo:
    pictogram: str | None       # PICTOGRAMS 키. 자체 그림문자가 없는 H-code(예: H229)는 None
    family: str                 # 유해성・위험성 분류 항목명(MSDS 2-가 항목과 매칭용)
    extra_pictogram: str | None = None  # 그림문자가 2개 필요한 예외(예: H241)의 두 번째 그림문자


# H-code -> (그림문자, 분류항목명). 분류항목명은 MSDS 2.가 "유해성・위험성 분류" 목록에서
# "{family} : 구분N" 형태로 등장하는 표현과 매칭하는 데 사용한다.
H_CODE_TABLE = {
    # 물리적 위험성
    "H200": HCodeInfo("GHS01", "불안정 폭발성 물질"),
    "H201": HCodeInfo("GHS01", "폭발성 물질"),
    "H202": HCodeInfo("GHS01", "폭발성 물질"),
    "H203": HCodeInfo("GHS01", "폭발성 물질"),
    "H204": HCodeInfo("GHS01", "폭발성 물질"),
    "H205": HCodeInfo("GHS01", "폭발성 물질"),
    "H220": HCodeInfo("GHS02", "인화성 가스"),
    "H221": HCodeInfo("GHS02", "인화성 가스"),
    "H222": HCodeInfo("GHS02", "인화성 에어로졸"),
    "H223": HCodeInfo("GHS02", "인화성 에어로졸"),
    "H224": HCodeInfo("GHS02", "인화성 액체"),
    "H225": HCodeInfo("GHS02", "인화성 액체"),
    "H226": HCodeInfo("GHS02", "인화성 액체"),
    "H228": HCodeInfo("GHS02", "인화성 고체"),
    # H229는 "에어로졸" 유해성 자체가 아니라 가압 용기 경고 문구로, 인화성
    # 에어로졸(H222/H223)에 딸려 나오는 보조 문구다. 그림문자는 GHS04(고압가스)가
    # 아니라 H222/H223이 이미 부여하는 GHS02(인화성)를 그대로 쓰거나(1·2등급),
    # 비인화성 에어로졸(3등급)은 그림문자가 아예 없다 - H229 자체는 그림문자를
    # 추가하지 않는다.
    "H229": HCodeInfo(None, "에어로졸"),
    # H230/H231("공기가 없어도 폭발적으로 반응할 수 있음")은 자기반응성
    # 물질이 아니라 "화학적으로 불안정한 가스"(인화성 가스 구분1A에 딸린
    # 보조 분류)다. 그림문자는 이미 H220/H221이 부여하는 GHS02(인화성)로
    # 충분해, H230/H231 자체는 추가 그림문자가 없다(H229와 동일한 패턴).
    "H230": HCodeInfo(None, "화학적으로 불안정한 가스"),
    "H231": HCodeInfo(None, "화학적으로 불안정한 가스"),
    "H240": HCodeInfo("GHS01", "자기반응성 물질"),
    # H241(자기반응성/유기과산화물 유형B, "가열하면 화재 또는 폭발할 수
    # 있음")은 GHS상 GHS01(폭발성)과 GHS02(인화성) 그림문자를 함께 표시해야
    # 한다(유형A인 H240은 GHS01만, 유형C~F인 H242는 GHS02만).
    "H241": HCodeInfo("GHS01", "자기반응성 물질", extra_pictogram="GHS02"),
    "H242": HCodeInfo("GHS02", "자기반응성 물질"),
    "H250": HCodeInfo("GHS02", "자연발화성 물질"),
    "H251": HCodeInfo("GHS02", "자기발열성 물질"),
    "H252": HCodeInfo("GHS02", "자기발열성 물질"),
    "H260": HCodeInfo("GHS02", "물반응성 물질"),
    "H261": HCodeInfo("GHS02", "물반응성 물질"),
    "H270": HCodeInfo("GHS03", "산화성 가스"),
    "H271": HCodeInfo("GHS03", "산화성 물질"),
    "H272": HCodeInfo("GHS03", "산화성 물질"),
    "H280": HCodeInfo("GHS04", "고압가스"),
    "H281": HCodeInfo("GHS04", "고압가스"),
    "H290": HCodeInfo("GHS05", "금속부식성 물질"),
    # 건강 유해성
    "H300": HCodeInfo("GHS06", "급성 독성(경구)"),
    "H301": HCodeInfo("GHS06", "급성 독성(경구)"),
    "H302": HCodeInfo("GHS07", "급성 독성(경구)"),
    # H303/H313/H333(구분5)는 GHS상 그림문자가 아예 없는 등급이다("...할 수
    # 있음"류 최저 등급 문구). 이전에는 구분4(H302/H312/H332)와 똑같이
    # GHS07로 매핑돼 있어, 구분5만 있는 문서에서도 느낌표가 잘못 표시됐다.
    "H303": HCodeInfo(None, "급성 독성(경구)"),
    "H304": HCodeInfo("GHS08", "흡인 유해성"),
    "H310": HCodeInfo("GHS06", "급성 독성(경피)"),
    "H311": HCodeInfo("GHS06", "급성 독성(경피)"),
    "H312": HCodeInfo("GHS07", "급성 독성(경피)"),
    "H313": HCodeInfo(None, "급성 독성(경피)"),
    "H314": HCodeInfo("GHS05", "피부 부식성/자극성"),
    "H315": HCodeInfo("GHS07", "피부 부식성/자극성"),
    "H316": HCodeInfo("GHS07", "피부 부식성/자극성"),
    "H317": HCodeInfo("GHS07", "피부과민성"),
    "H318": HCodeInfo("GHS05", "심한 눈 손상성/눈 자극성"),
    "H319": HCodeInfo("GHS07", "심한 눈 손상성/눈 자극성"),
    "H320": HCodeInfo("GHS07", "심한 눈 손상성/눈 자극성"),
    "H330": HCodeInfo("GHS06", "급성 독성(흡입)"),
    "H331": HCodeInfo("GHS06", "급성 독성(흡입)"),
    "H332": HCodeInfo("GHS07", "급성 독성(흡입)"),
    "H333": HCodeInfo(None, "급성 독성(흡입)"),  # 구분5, 그림문자 없음
    "H334": HCodeInfo("GHS08", "호흡기과민성"),
    "H335": HCodeInfo("GHS07", "특정표적장기독성(1회 노출)"),
    "H336": HCodeInfo("GHS07", "특정표적장기독성(1회 노출)"),
    "H340": HCodeInfo("GHS08", "생식세포변이원성"),
    "H341": HCodeInfo("GHS08", "생식세포변이원성"),
    "H350": HCodeInfo("GHS08", "발암성"),
    "H351": HCodeInfo("GHS08", "발암성"),
    "H360": HCodeInfo("GHS08", "생식독성"),
    "H361": HCodeInfo("GHS08", "생식독성"),
    # H362("수유 중인 자녀에게 유해할 수 있음")는 생식독성의 정식 구분이
    # 아니라 수유 영향에 대한 추가 정보로, GHS상 그림문자·신호어가 필요
    # 없다(생식독성 구분1/2는 H360/H361이 이미 GHS08을 부여함).
    "H362": HCodeInfo(None, "생식독성(수유독성)"),
    "H370": HCodeInfo("GHS08", "특정표적장기독성(1회 노출)"),
    "H371": HCodeInfo("GHS08", "특정표적장기독성(1회 노출)"),
    "H372": HCodeInfo("GHS08", "특정표적장기독성(반복 노출)"),
    "H373": HCodeInfo("GHS08", "특정표적장기독성(반복 노출)"),
    # 환경 유해성
    "H400": HCodeInfo("GHS09", "급성 수생환경 유해성"),
    "H410": HCodeInfo("GHS09", "만성 수생환경 유해성"),
    "H411": HCodeInfo("GHS09", "만성 수생환경 유해성"),
    # H412/H413(만성 수생환경유해성 구분3/4)은 GHS상 그림문자·신호어가 필요
    # 없는 가장 약한 등급이다(구분1/2인 H410/H411까지만 GHS09가 필요함).
    "H412": HCodeInfo(None, "만성 수생환경 유해성"),
    "H413": HCodeInfo(None, "만성 수생환경 유해성"),
}


# GHS 그림문자 우선순위 규칙(그림문자 병용 원칙): 부식성(GHS05)·급성독성
# (GHS06) 그림문자나 호흡기과민성(H334, GHS08)이 이미 쓰이면, 그보다 약한
# 피부/눈 자극성·특정표적장기독성(1회노출) 자극/마취영향에 대한 느낌표
# (GHS07)는 표시하지 않는다. 다른 사유(예: 피부과민성 H317, 급성독성
# 구분4)로도 GHS07이 필요하면 그건 생략되지 않는다.
_GHS07_OMITTED_WHEN_STRONGER_PRESENT = {"H315", "H316", "H319", "H320", "H335", "H336"}
_GHS07_OMISSION_TRIGGER_PICTOGRAMS = {"GHS05", "GHS06"}
_GHS07_OMISSION_TRIGGER_CODES = {"H334"}


def pictograms_for_hcodes(hcodes):
    """H-code(예: 'H317', 'H305+H351') 목록에서 필요한 그림문자 코드를 중복 없이,
    GHS01 -> GHS09 순서로 정렬해 반환한다. 동일 유해성 안에서 더 심각한
    그림문자가 이미 쓰이면 약한 그림문자를 생략하는 GHS 표시 규칙도 반영한다.
    """
    flat_codes = [c for raw in hcodes for c in _split_combined_code(raw)]
    contributors = {}  # 그림문자 -> 이를 요구한 H-code 집합
    for code in flat_codes:
        info = H_CODE_TABLE.get(code)
        if not info:
            continue
        if info.pictogram:
            contributors.setdefault(info.pictogram, set()).add(code)
        if info.extra_pictogram:
            contributors.setdefault(info.extra_pictogram, set()).add(code)

    has_stronger = (
        any(p in contributors for p in _GHS07_OMISSION_TRIGGER_PICTOGRAMS)
        or any(c in flat_codes for c in _GHS07_OMISSION_TRIGGER_CODES)
    )
    if has_stronger and "GHS07" in contributors:
        contributors["GHS07"] -= _GHS07_OMITTED_WHEN_STRONGER_PRESENT
        if not contributors["GHS07"]:
            del contributors["GHS07"]

    needed = set(contributors.keys())
    return [p for p in PICTOGRAM_ORDER if p in needed]


def _split_combined_code(raw):
    # 예방조치문구처럼 "P305+P351+P338"로 결합된 코드, 또는 "H315"단독 모두 처리
    return [c for c in raw.replace(" ", "").split("+") if c]


def family_for_hcode(code):
    info = H_CODE_TABLE.get(code)
    return info.family if info else None
