"""Builds representative documents in memory. Nothing binary is committed."""
import datetime as dt
import io
import zipfile

from docx import Document
from openpyxl import Workbook
from pptx import Presentation
from pptx.util import Inches
from pypdf import PdfWriter


def _esc(s):
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def make_pdf(pages):
    """A minimal valid text PDF. `pages` is a list of lists of lines."""
    objs = {}
    n_pages = len(pages)
    kids = [4 + 2 * i for i in range(n_pages)]
    objs[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objs[2] = ("<< /Type /Pages /Kids [%s] /Count %d >>" % (" ".join(f"{k} 0 R" for k in kids), n_pages)).encode()
    objs[3] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
    for i, lines in enumerate(pages):
        stream = "BT /F1 12 Tf 72 720 Td 14 TL " + " ".join(f"({_esc(l)}) Tj T*" for l in lines) + " ET"
        objs[4 + 2 * i] = (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {5 + 2 * i} 0 R /Resources << /Font << /F1 3 0 R >> >> >>").encode()
        objs[5 + 2 * i] = b"<< /Length %d >>\nstream\n" % len(stream) + stream.encode() + b"\nendstream"
    out = bytearray(b"%PDF-1.4\n")
    offsets = {}
    for num in sorted(objs):
        offsets[num] = len(out)
        out += b"%d 0 obj\n" % num + objs[num] + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for num in sorted(objs):
        out += b"%010d 00000 n \n" % offsets[num]
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    return bytes(out)


def encrypt_pdf(pdf: bytes) -> bytes:
    w = PdfWriter(clone_from=io.BytesIO(pdf))
    w.encrypt("s3cret")
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


def blank_pdf(pages=2) -> bytes:  # no text objects at all: what a scanned PDF looks like to a text extractor
    w = PdfWriter()
    for _ in range(pages):
        w.add_blank_page(612, 792)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


def make_docx():
    d = Document()
    d.add_heading("Leave Policy", level=1)
    d.add_paragraph("All employees accrue 24 days of paid leave per year.")
    d.add_heading("Carry over", level=2)
    d.add_paragraph("Up to 5 unused days may be carried into the next year.")
    t = d.add_table(rows=3, cols=2)
    for r, (a, b) in enumerate([("Role", "Days"), ("Engineer", "24"), ("Manager", "28")]):
        t.cell(r, 0).text, t.cell(r, 1).text = a, b
    d.add_heading("Approval", level=1)
    d.add_paragraph("Requests are approved by the line manager.")
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def make_xlsx():
    wb = Workbook()
    ws = wb.active
    ws.title = "Budget"
    ws.append(["Department", "Q1", "Q2"])
    ws.append(["Engineering", 1200, 1350.5])
    ws.append(["Sales", 800, dt.date(2026, 1, 5)])
    ws2 = wb.create_sheet("Headcount")
    ws2.append(["Team", "People"])
    ws2.append(["Platform", 12])
    hidden = wb.create_sheet("Secret")
    hidden.append(["x", "y"])
    hidden.append(["HIDDEN-SHEET-DATA", 1])
    hidden.sheet_state = "hidden"
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def make_pptx():
    prs = Presentation()
    s1 = prs.slides.add_slide(prs.slide_layouts[1])
    s1.shapes.title.text = "Roadmap 2027"
    s1.placeholders[1].text = "Ship the AI assistant\nImprove onboarding"
    s2 = prs.slides.add_slide(prs.slide_layouts[5])
    s2.shapes.title.text = "Targets"
    tbl = s2.shapes.add_table(2, 2, Inches(1), Inches(2), Inches(6), Inches(1.5)).table
    for r, row in enumerate([("Metric", "Goal"), ("Adoption", "80%")]):
        for c, v in enumerate(row):
            tbl.cell(r, c).text = v
    s3 = prs.slides.add_slide(prs.slide_layouts[6])  # blank: no text
    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue()


def make_csv(rows=3):
    lines = ["name,department,salary"] + [f"Person{i},Dept{i % 3},{50000 + i}" for i in range(rows)]
    return ("\n".join(lines) + "\n").encode()


def make_txt(paragraphs=3):
    return "\n\n".join(f"Paragraph {i}. " + "This sentence is about company policy. " * 5 for i in range(paragraphs)).encode()


# ---- hostile / broken inputs --------------------------------------------------------------

def minimal_ooxml(part, fill=None, extra_entries=0):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr(part, "<x/>")
        if fill:
            with z.open(fill[0], "w", force_zip64=True) as f:
                chunk = b"\x00" * (1024 * 1024)
                for _ in range(fill[1]):
                    f.write(chunk)
        for i in range(extra_entries):
            z.writestr(f"junk/{i}.xml", "")
    return buf.getvalue()


def zip_bomb_xlsx(megabytes=80):  # compresses roughly 1000:1
    return minimal_ooxml("xl/workbook.xml", fill=("xl/worksheets/sheet1.xml", megabytes))


def many_entries_docx(n=4000):
    return minimal_ooxml("word/document.xml", extra_entries=n)


def ole_container():  # what a password-protected .docx/.xlsx/.pptx really is
    return b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 600
