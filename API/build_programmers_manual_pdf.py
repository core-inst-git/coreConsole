#!/usr/bin/env python3
"""Build a styled PDF from COREDAQ_PROGRAMMERS_MANUAL.md using reportlab."""

from __future__ import annotations

import argparse
import os
import re
from typing import List
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, StyleSheet1, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Preformatted, SimpleDocTemplate, Paragraph, Spacer


def make_styles() -> StyleSheet1:
    base = getSampleStyleSheet()
    styles = StyleSheet1()
    styles.add(
        ParagraphStyle(
            name="Body",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=10.5,
            leading=14,
            textColor=colors.HexColor("#1f2937"),
            spaceAfter=6,
        )
    )
    styles.add(
        ParagraphStyle(
            name="H1",
            parent=base["Heading1"],
            fontName="Helvetica-Bold",
            fontSize=22,
            leading=26,
            textColor=colors.HexColor("#0b1f3a"),
            spaceBefore=10,
            spaceAfter=12,
        )
    )
    styles.add(
        ParagraphStyle(
            name="H2",
            parent=base["Heading2"],
            fontName="Helvetica-Bold",
            fontSize=15,
            leading=20,
            textColor=colors.HexColor("#0f2d55"),
            spaceBefore=10,
            spaceAfter=8,
        )
    )
    styles.add(
        ParagraphStyle(
            name="H3",
            parent=base["Heading3"],
            fontName="Helvetica-Bold",
            fontSize=12.5,
            leading=16,
            textColor=colors.HexColor("#12406f"),
            spaceBefore=8,
            spaceAfter=6,
        )
    )
    styles.add(
        ParagraphStyle(
            name="Bullet",
            parent=styles["Body"],
            leftIndent=14,
            bulletIndent=2,
            spaceAfter=2,
        )
    )
    styles.add(
        ParagraphStyle(
            name="Code",
            parent=base["Code"],
            fontName="Courier",
            fontSize=8.8,
            leading=11.2,
            leftIndent=7,
            rightIndent=7,
            textColor=colors.HexColor("#111827"),
            backColor=colors.HexColor("#eef2f7"),
            borderColor=colors.HexColor("#d6dee8"),
            borderPadding=5,
            borderWidth=0.5,
            borderRadius=3,
            spaceBefore=5,
            spaceAfter=8,
        )
    )
    return styles


def format_inline_code(text: str) -> str:
    parts = re.split(r"(`[^`]+`)", text)
    out: List[str] = []
    for p in parts:
        if p.startswith("`") and p.endswith("`") and len(p) >= 2:
            code = escape(p[1:-1])
            out.append(f'<font name="Courier">{code}</font>')
        else:
            out.append(escape(p))
    return "".join(out)


def markdown_to_story(text: str, styles: StyleSheet1):
    story = []
    lines = text.splitlines()
    in_code = False
    code_lines: List[str] = []
    para_lines: List[str] = []

    def flush_para() -> None:
        nonlocal para_lines
        if not para_lines:
            return
        paragraph = " ".join(x.strip() for x in para_lines if x.strip())
        if paragraph:
            story.append(Paragraph(format_inline_code(paragraph), styles["Body"]))
        para_lines = []

    for raw in lines:
        line = raw.rstrip("\n")
        stripped = line.strip()

        if stripped.startswith("```"):
            flush_para()
            if in_code:
                story.append(Preformatted("\n".join(code_lines), styles["Code"]))
                code_lines = []
                in_code = False
            else:
                in_code = True
            continue

        if in_code:
            code_lines.append(line)
            continue

        if not stripped:
            flush_para()
            story.append(Spacer(1, 2))
            continue

        if stripped.startswith("# "):
            flush_para()
            story.append(Paragraph(escape(stripped[2:].strip()), styles["H1"]))
            continue
        if stripped.startswith("## "):
            flush_para()
            story.append(Paragraph(escape(stripped[3:].strip()), styles["H2"]))
            continue
        if stripped.startswith("### "):
            flush_para()
            story.append(Paragraph(escape(stripped[4:].strip()), styles["H3"]))
            continue

        if stripped.startswith("- "):
            flush_para()
            bullet = stripped[2:].strip()
            story.append(Paragraph(format_inline_code(bullet), styles["Bullet"], bulletText="\u2022"))
            continue

        para_lines.append(stripped)

    flush_para()
    if code_lines:
        story.append(Preformatted("\n".join(code_lines), styles["Code"]))
    return story


def on_page(canvas, doc) -> None:
    w, h = A4
    canvas.saveState()

    # Top bar
    canvas.setFillColor(colors.HexColor("#0b1f3a"))
    canvas.rect(0, h - 16 * mm, w, 16 * mm, fill=1, stroke=0)
    canvas.setFillColor(colors.white)
    canvas.setFont("Helvetica-Bold", 10)
    canvas.drawString(12 * mm, h - 10.5 * mm, "coreDAQ Programmer's Manual")

    # Footer
    canvas.setFillColor(colors.HexColor("#6b7280"))
    canvas.setFont("Helvetica", 8)
    canvas.drawRightString(w - 12 * mm, 8 * mm, f"Page {doc.page}")
    canvas.drawString(12 * mm, 8 * mm, "Core - Instrumentation")

    canvas.restoreState()


def build_pdf(md_path: str, pdf_path: str) -> None:
    with open(md_path, "r", encoding="utf-8") as f:
        text = f.read()

    styles = make_styles()
    story = markdown_to_story(text, styles)

    doc = SimpleDocTemplate(
        pdf_path,
        pagesize=A4,
        leftMargin=14 * mm,
        rightMargin=14 * mm,
        topMargin=24 * mm,
        bottomMargin=14 * mm,
        title="coreDAQ Programmer's Manual",
        author="Core - Instrumentation",
    )
    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)


def main() -> int:
    script_dir = os.path.abspath(os.path.dirname(__file__))
    default_md = os.path.join(script_dir, "COREDAQ_PROGRAMMERS_MANUAL.md")
    default_pdf = os.path.join(script_dir, "coreDAQ_programmers_manual.pdf")

    parser = argparse.ArgumentParser(description="Build programmer manual PDF from markdown.")
    parser.add_argument("--input", default=default_md, help="Input markdown path.")
    parser.add_argument("--output", default=default_pdf, help="Output PDF path.")
    args = parser.parse_args()

    build_pdf(args.input, args.output)
    print(f"Wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
