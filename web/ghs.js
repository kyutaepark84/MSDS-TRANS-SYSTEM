// GHS(Globally Harmonized System) 유해·위험문구(H-code) <-> 그림문자 매핑.
// msds_ppt_generator/ghs.py 의 JS 포팅본. 매핑 내용은 원본과 동일하게 유지한다.

const GHS_PICTOGRAM_ORDER = [
  "GHS01", "GHS02", "GHS03", "GHS04", "GHS05", "GHS06", "GHS07", "GHS08", "GHS09",
];

const GHS_PICTOGRAM_NAMES = {
  GHS01: "폭발성물질",
  GHS02: "인화성물질",
  GHS03: "산화성물질",
  GHS04: "고압가스",
  GHS05: "부식성물질",
  GHS06: "급성독성물질",
  GHS07: "느낌표(경고표시)",
  GHS08: "건강유해성",
  GHS09: "환경유해성",
};

// H-code -> { pictogram, family }
const H_CODE_TABLE = {
  H200: { pictogram: "GHS01", family: "불안정 폭발성 물질" },
  H201: { pictogram: "GHS01", family: "폭발성 물질" },
  H202: { pictogram: "GHS01", family: "폭발성 물질" },
  H203: { pictogram: "GHS01", family: "폭발성 물질" },
  H204: { pictogram: "GHS01", family: "폭발성 물질" },
  H205: { pictogram: "GHS01", family: "폭발성 물질" },
  H220: { pictogram: "GHS02", family: "인화성 가스" },
  H221: { pictogram: "GHS02", family: "인화성 가스" },
  H222: { pictogram: "GHS02", family: "인화성 에어로졸" },
  H223: { pictogram: "GHS02", family: "인화성 에어로졸" },
  H224: { pictogram: "GHS02", family: "인화성 액체" },
  H225: { pictogram: "GHS02", family: "인화성 액체" },
  H226: { pictogram: "GHS02", family: "인화성 액체" },
  H228: { pictogram: "GHS02", family: "인화성 고체" },
  H229: { pictogram: "GHS04", family: "에어로졸" },
  H230: { pictogram: "GHS01", family: "자기반응성 물질" },
  H231: { pictogram: "GHS01", family: "자기반응성 물질" },
  H240: { pictogram: "GHS01", family: "자기반응성 물질" },
  H241: { pictogram: "GHS02", family: "자기반응성 물질" },
  H242: { pictogram: "GHS02", family: "자기반응성 물질" },
  H250: { pictogram: "GHS02", family: "자연발화성 물질" },
  H251: { pictogram: "GHS02", family: "자기발열성 물질" },
  H252: { pictogram: "GHS02", family: "자기발열성 물질" },
  H260: { pictogram: "GHS02", family: "물반응성 물질" },
  H261: { pictogram: "GHS02", family: "물반응성 물질" },
  H270: { pictogram: "GHS03", family: "산화성 가스" },
  H271: { pictogram: "GHS03", family: "산화성 물질" },
  H272: { pictogram: "GHS03", family: "산화성 물질" },
  H280: { pictogram: "GHS04", family: "고압가스" },
  H281: { pictogram: "GHS04", family: "고압가스" },
  H290: { pictogram: "GHS05", family: "금속부식성 물질" },
  H300: { pictogram: "GHS06", family: "급성 독성(경구)" },
  H301: { pictogram: "GHS06", family: "급성 독성(경구)" },
  H302: { pictogram: "GHS07", family: "급성 독성(경구)" },
  H303: { pictogram: "GHS07", family: "급성 독성(경구)" },
  H304: { pictogram: "GHS08", family: "흡인 유해성" },
  H310: { pictogram: "GHS06", family: "급성 독성(경피)" },
  H311: { pictogram: "GHS06", family: "급성 독성(경피)" },
  H312: { pictogram: "GHS07", family: "급성 독성(경피)" },
  H313: { pictogram: "GHS07", family: "급성 독성(경피)" },
  H314: { pictogram: "GHS05", family: "피부 부식성/자극성" },
  H315: { pictogram: "GHS07", family: "피부 부식성/자극성" },
  H316: { pictogram: "GHS07", family: "피부 부식성/자극성" },
  H317: { pictogram: "GHS07", family: "피부과민성" },
  H318: { pictogram: "GHS05", family: "심한 눈 손상성/눈 자극성" },
  H319: { pictogram: "GHS07", family: "심한 눈 손상성/눈 자극성" },
  H320: { pictogram: "GHS07", family: "심한 눈 손상성/눈 자극성" },
  H330: { pictogram: "GHS06", family: "급성 독성(흡입)" },
  H331: { pictogram: "GHS06", family: "급성 독성(흡입)" },
  H332: { pictogram: "GHS07", family: "급성 독성(흡입)" },
  H333: { pictogram: "GHS07", family: "급성 독성(흡입)" },
  H334: { pictogram: "GHS08", family: "호흡기과민성" },
  H335: { pictogram: "GHS07", family: "특정표적장기독성(1회 노출)" },
  H336: { pictogram: "GHS07", family: "특정표적장기독성(1회 노출)" },
  H340: { pictogram: "GHS08", family: "생식세포변이원성" },
  H341: { pictogram: "GHS08", family: "생식세포변이원성" },
  H350: { pictogram: "GHS08", family: "발암성" },
  H351: { pictogram: "GHS08", family: "발암성" },
  H360: { pictogram: "GHS08", family: "생식독성" },
  H361: { pictogram: "GHS08", family: "생식독성" },
  H362: { pictogram: "GHS08", family: "생식독성(수유독성)" },
  H370: { pictogram: "GHS08", family: "특정표적장기독성(1회 노출)" },
  H371: { pictogram: "GHS08", family: "특정표적장기독성(1회 노출)" },
  H372: { pictogram: "GHS08", family: "특정표적장기독성(반복 노출)" },
  H373: { pictogram: "GHS08", family: "특정표적장기독성(반복 노출)" },
  H400: { pictogram: "GHS09", family: "급성 수생환경 유해성" },
  H410: { pictogram: "GHS09", family: "만성 수생환경 유해성" },
  H411: { pictogram: "GHS09", family: "만성 수생환경 유해성" },
  H412: { pictogram: "GHS09", family: "만성 수생환경 유해성" },
  H413: { pictogram: "GHS09", family: "만성 수생환경 유해성" },
};

function splitCombinedCode(raw) {
  return raw.replace(/\s+/g, "").split("+").filter(Boolean);
}

function pictogramsForHcodes(hcodes) {
  const needed = new Set();
  for (const raw of hcodes) {
    for (const code of splitCombinedCode(raw)) {
      const info = H_CODE_TABLE[code];
      if (info) needed.add(info.pictogram);
    }
  }
  return GHS_PICTOGRAM_ORDER.filter((p) => needed.has(p));
}

function familyForHcode(code) {
  const info = H_CODE_TABLE[code];
  return info ? info.family : null;
}
