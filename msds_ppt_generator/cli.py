"""MSDS PDF -> 현장경고표지/관리요령 PPTX 생성 CLI.

사용 예:
    python -m msds_ppt_generator input.pdf --seq 21 --out-dir ./output
"""

import argparse
import datetime
import os
import re
import sys

from .msds_parser import parse_msds, extract_product_name_from_filename
from .ppt_builder import build_label_slide, build_handling_slide


def _safe_filename_part(text):
    return re.sub(r'[\\/:*?"<>|]', "", text).strip()


def build_filenames(product_name, seq, rev_date):
    prefix = f"{seq}. " if seq else ""
    product = _safe_filename_part(product_name) or "제품명"
    label_name = f"{prefix}현장경고표지({product})_REV.{rev_date}.pptx"
    handling_name = f"{prefix}관리요령({product})_REV.{rev_date}.pptx"
    return label_name, handling_name


def main(argv=None):
    parser = argparse.ArgumentParser(description="MSDS PDF로부터 현장경고표지/관리요령 PPT를 생성합니다.")
    parser.add_argument("pdf_path", help="MSDS PDF 파일 경로")
    parser.add_argument("--out-dir", default=".", help="결과 PPTX를 저장할 폴더 (기본값: 현재 폴더)")
    parser.add_argument("--seq", default="", help="파일명 앞에 붙는 사내 관리번호 (예: 21)")
    parser.add_argument("--rev-date", default="", help="파일명에 쓸 개정일자 (기본값: 오늘 날짜, YYYY.MM.DD)")
    parser.add_argument("--only", choices=["label", "handling", "both"], default="both",
                         help="현장경고표지(label)만, 관리요령(handling)만, 또는 둘 다(both, 기본값) 생성")
    args = parser.parse_args(argv)

    rev_date = args.rev_date or datetime.date.today().strftime("%Y.%m.%d")

    msds = parse_msds(args.pdf_path)
    filename_product = extract_product_name_from_filename(os.path.basename(args.pdf_path))
    if filename_product:
        msds.product_name = filename_product
    if not msds.product_name:
        print("경고: 제품명을 추출하지 못했습니다. MSDS 서식이 예상과 다를 수 있습니다.", file=sys.stderr)

    os.makedirs(args.out_dir, exist_ok=True)
    label_name, handling_name = build_filenames(msds.product_name, args.seq, rev_date)

    if args.only in ("label", "both"):
        label_path = os.path.join(args.out_dir, label_name)
        build_label_slide(msds, label_path)
        print(f"생성됨: {label_path}")

    if args.only in ("handling", "both"):
        handling_path = os.path.join(args.out_dir, handling_name)
        build_handling_slide(msds, handling_path)
        print(f"생성됨: {handling_path}")


if __name__ == "__main__":
    main()
