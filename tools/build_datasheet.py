#!/usr/bin/env python3
"""
Build a polished two-page coreDAQ datasheet PDF.
"""

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph, Table, TableStyle


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / ".tmp_datasheet_assets"
OUTPUT = ROOT / "device_datasheet_updated.pdf"


def draw_background(c: canvas.Canvas, w: float, h: float) -> None:
    c.setFillColor(colors.Color(0.95, 0.97, 0.99))
    c.rect(0, 0, w, h, fill=1, stroke=0)
    c.setFillColor(colors.Color(0.90, 0.93, 0.96))
    for x, y, r in [
        (90, 740, 100),
        (230, 710, 80),
        (400, 740, 95),
        (520, 700, 90),
        (80, 430, 120),
        (300, 420, 95),
        (490, 430, 110),
        (150, 120, 130),
        (430, 120, 120),
    ]:
        c.circle(x, y, r, fill=1, stroke=0)


def draw_header(c: canvas.Canvas, w: float, title: str) -> None:
    c.setFillColor(colors.Color(0.06, 0.13, 0.23))
    c.rect(0, 770, w, 22, fill=1, stroke=0)
    c.setFillColor(colors.white)
    c.setFont("Helvetica-Bold", 9)
    c.drawString(18, 778, title)
    c.drawRightString(w - 18, 778, "Core - Instrumentation")


def draw_footer(c: canvas.Canvas, w: float, page_num: int) -> None:
    c.setFillColor(colors.Color(0.06, 0.13, 0.23))
    c.rect(0, 0, w, 14, fill=1, stroke=0)
    c.setFillColor(colors.white)
    c.setFont("Helvetica", 7)
    c.drawRightString(w - 12, 4, f"coreDAQ Datasheet v2 • Page {page_num}")


def draw_para(c: canvas.Canvas, text: str, style: ParagraphStyle, x: float, y: float, w: float, h: float) -> None:
    p = Paragraph(text, style)
    p.wrapOn(c, w, h)
    p.drawOn(c, x, y)


def page_1(c: canvas.Canvas, w: float, h: float, styles) -> None:
    draw_background(c, w, h)
    draw_header(c, w, "coreDAQ Product Brief")

    c.setFillColor(colors.Color(0.10, 0.15, 0.23))
    c.setFont("Helvetica-Bold", 38)
    c.drawString(52, 650, "coreDAQ")
    c.setFont("Helvetica-Bold", 20)
    c.setFillColor(colors.Color(0.18, 0.24, 0.33))
    c.drawString(52, 620, "Multi-channel Optical Power Meter")

    c.drawImage(str(ASSETS / "front_device_clean.png"), 45, 468, width=300, height=112, mask="auto")

    c.setFillColor(colors.Color(0.95, 0.97, 1.0))
    c.setStrokeColor(colors.Color(0.77, 0.81, 0.86))
    c.roundRect(360, 430, 205, 180, 12, fill=1, stroke=1)
    c.setFillColor(colors.Color(0.13, 0.17, 0.22))
    c.setFont("Helvetica-Bold", 17)
    c.drawString(378, 578, "Features")
    c.setFont("Helvetica", 13)
    feature_lines = [
        "• 4-channel acquisition architecture",
        "• InGaAs / Si detector compatibility",
        "• Linear and logarithmic frontends",
        "• True simultaneous channel sampling",
        "• Deep SDRAM capture buffer",
        "• USB bus-powered operation",
    ]
    y = 555
    for line in feature_lines:
        c.drawString(376, y, line)
        y -= 24

    c.setFillColor(colors.Color(0.98, 0.99, 1.0))
    c.roundRect(50, 340, 325, 88, 12, fill=1, stroke=1)
    c.setFillColor(colors.Color(0.13, 0.17, 0.22))
    c.setFont("Helvetica-Bold", 17)
    c.drawString(66, 403, "Applications")
    c.setFont("Helvetica", 14)
    c.drawString(66, 380, "• Optical power monitoring")
    c.drawString(66, 358, "• Photonic IC characterization")
    c.drawString(66, 336, "• High-speed capture and logging")

    c.setFillColor(colors.Color(0.87, 0.91, 0.95))
    c.setStrokeColor(colors.Color(0.77, 0.81, 0.86))
    c.roundRect(50, 96, 512, 230, 10, fill=1, stroke=1)
    c.setFillColor(colors.Color(0.13, 0.17, 0.22))
    c.setFont("Helvetica-Bold", 18)
    c.drawString(62, 304, "Product Overview")
    overview = (
        "coreDAQ is a compact multi-channel optical data-acquisition instrument for lab and production workflows. "
        "It provides deterministic, simultaneous sampling across four channels for power monitoring and capture workflows. "
        "The platform is USB bus-powered and communicates over USB 2.0 high-speed. "
        "Software stack includes coreConsole desktop GUI plus documented Python and C++ APIs for automation. "
        "Analog trigger I/O is provided via two analog ports for synchronized measurement integration. "
        "Two hardware frontend variants are supported: LINEAR (multi-gain TIA path) and LOG (logarithmic path). "
        "Designed for photonics workflows including swept-source measurements, logging, and instrument control integration."
    )
    draw_para(c, overview, styles["body"], 62, 116, 490, 180)

    draw_footer(c, w, 1)


def page_2(c: canvas.Canvas, w: float, h: float, styles) -> None:
    draw_background(c, w, h)
    draw_header(c, w, "coreDAQ Specifications")

    c.drawImage(str(ASSETS / "front_device_clean.png"), 472, 728, width=95, height=35, mask="auto")

    c.setFillColor(colors.Color(0.13, 0.17, 0.22))
    c.setFont("Helvetica-Bold", 22)
    c.drawString(52, 662, "General Specifications")

    table1 = Table(
        [
            ["Parameter", "Unit", "Specification", "Notes"],
            ["Number of channels", "-", "4 simultaneous channels", "Optical channels"],
            ["Host interface", "-", "USB 2.0 HS, USB-C", "Bus-powered operation"],
            ["Software", "-", "coreConsole GUI", "Cross-platform desktop"],
            ["APIs", "-", "Python API + C++ API", "Automation ready"],
            ["Analog ports", "-", "2 ports", "Trigger / analog integration"],
            ["Supply", "V", "5V from USB bus", "No external supply required"],
            ["Operating temperature", "°C", "10 to 40", "Lab environment"],
            ["Operating humidity", "%RH", "< 80", "Non-condensing"],
            ["ADC resolution", "bit", "16", "Bipolar conversion path"],
        ],
        colWidths=[165, 55, 170, 130],
        rowHeights=23,
    )
    table1.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.Color(0.06, 0.13, 0.23)),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
                ("FONTSIZE", (0, 0), (-1, -1), 10),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.Color(0.70, 0.73, 0.77)),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.Color(0.96, 0.97, 0.98), colors.Color(0.92, 0.94, 0.96)]),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]
        )
    )
    table1.wrapOn(c, w, h)
    table1.drawOn(c, 52, 438)

    c.setFont("Helvetica-Bold", 22)
    c.setFillColor(colors.Color(0.13, 0.17, 0.22))
    c.drawString(52, 346, "Sensor / Frontend Specifications")

    table2 = Table(
        [
            ["Parameter", "Unit", "Specification", "Notes"],
            ["Photodiode compatibility", "-", "InGaAs / Silicon", "Device configuration dependent"],
            ["LINEAR frontend gains", "-", "8 gain stages", "Per-channel gain control"],
            ["LINEAR model", "-", "mV = slope*P + intercept", "Per gain/channel coefficients"],
            ["LOG frontend model", "-", "Parametric log model", "LUT fallback if required"],
            ["Sample rate", "ksps", "Up to 100 (all channels)", "Mode dependent"],
            ["Capture memory", "-", "Deep SDRAM buffer", "High-density acquisition"],
            ["Calibration approach", "-", "Reference PM based", "NIST-traceable workflow"],
        ],
        colWidths=[165, 55, 170, 130],
        rowHeights=23,
    )
    table2.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.Color(0.06, 0.13, 0.23)),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
                ("FONTSIZE", (0, 0), (-1, -1), 10),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.Color(0.70, 0.73, 0.77)),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.Color(0.96, 0.97, 0.98), colors.Color(0.92, 0.94, 0.96)]),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]
        )
    )
    table2.wrapOn(c, w, h)
    table2.drawOn(c, 52, 159)

    c.setFillColor(colors.Color(0.20, 0.24, 0.29))
    c.setFont("Helvetica-Bold", 10)
    c.drawString(52, 141, "Notes:")
    note_lines = [
        "1) Specifications vary by frontend and detector selection.",
        "2) Calibration is typically referenced at 1550 nm for InGaAs workflows.",
        "3) For silicon detectors, responsivity-curve methods may be used depending on setup.",
        "4) coreConsole controls streaming, capture, calibration, and console command workflows.",
    ]
    y = 126
    c.setFont("Helvetica", 8.5)
    for line in note_lines:
        c.drawString(58, y, line)
        y -= 14

    c.drawImage(str(ASSETS / "iso_device.png"), 448, 44, width=120, height=68, mask="auto")
    draw_footer(c, w, 2)


def main() -> None:
    styles = getSampleStyleSheet()
    styles.add(
        ParagraphStyle(
            name="body",
            parent=styles["BodyText"],
            fontName="Helvetica",
            fontSize=11.5,
            leading=16,
            textColor=colors.Color(0.15, 0.18, 0.22),
        )
    )

    c = canvas.Canvas(str(OUTPUT), pagesize=letter)
    w, h = letter
    page_1(c, w, h, styles)
    c.showPage()
    page_2(c, w, h, styles)
    c.showPage()
    c.save()


if __name__ == "__main__":
    main()
