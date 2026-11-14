import dataclasses
import io
import zipfile

import pytest

from app.ingestion.limits import Limits
from app.ingestion.pipeline import ChecksumMismatch, process_bytes
from app.ingestion.extractors import extract
from app.ingestion.reasons import Skip
from app.ingestion.sizer import WordSizer
from tests import fixtures as fx

L = Limits()


def run(fmt, data, limits=L):
    return process_bytes(fmt, data, limits, sizer=WordSizer())


def skipped(fmt, data, reason, limits=L):
    r = run(fmt, data, limits)
    assert r["status"] == "skipped" and r["reason"] == reason, r
    assert "chunks" not in r  # a skipped document never carries (or fakes) indexed content
    return r


def all_text(result):
    return "\n".join(c["text"] for c in result["chunks"])


# ---- successful extraction + structure ------------------------------------------------------

def test_txt():
    r = run("txt", fx.make_txt(3))
    assert r["status"] == "indexed" and r["format"] == "txt"
    loc = r["chunks"][0]["location"]
    assert loc["charStart"] == 0 and loc["charEnd"] > 0
    assert "company policy" in all_text(r)


def test_txt_decodes_utf8_bom_utf16_and_legacy():
    assert "naïve café" in all_text(run("txt", "naïve café".encode("utf-8-sig") * 3))
    assert "hello world from utf16" in all_text(run("txt", "hello world from utf16".encode("utf-16")))
    assert "café" in all_text(run("txt", "plain café text here".encode("cp1252")))


def test_csv_keeps_headers_and_row_numbers():
    r = run("csv", fx.make_csv(5))
    assert r["status"] == "indexed"
    text = all_text(r)
    assert "Columns: name | department | salary" in text
    assert "name: Person0 | department: Dept0 | salary: 50000" in text
    loc = r["chunks"][0]["location"]
    assert (loc["rowStart"], loc["rowEnd"]) == (2, 6)  # file rows; row 1 is the header


def test_csv_semicolon_delimiter_and_quoted_newlines():
    data = b'name;note\nAnn;"line one\nline two"\nBob;fine\n'
    text = all_text(run("csv", data))
    assert "name: Ann" in text and "name: Bob" in text and "line one" in text


def test_pdf_pages_and_paragraphs():
    r = run("pdf", fx.make_pdf([["Annual leave policy.", "Applies to all staff."], ["Second page content here."]]))
    assert r["status"] == "indexed" and r["stats"]["pages"] == 2
    locs = [c["location"] for c in r["chunks"]]
    assert locs[0]["pageStart"] == 1 and locs[-1]["pageEnd"] == 2
    assert "Annual leave policy. Applies to all staff." in all_text(r)  # lines re-flowed into a paragraph


def test_docx_heading_path_and_tables():
    r = run("docx", fx.make_docx())
    assert r["status"] == "indexed"
    text = all_text(r)
    assert "Engineer | 24" in text and "Role | Days" in text
    paths = [c["location"].get("headingPath") for c in r["chunks"]]
    assert ["Leave Policy"] in paths or any(p and p[0] == "Leave Policy" for p in paths)
    # The "Carry over" paragraph lives under Leave Policy > Carry over
    carry = [c for c in r["chunks"] if "carried into the next year" in c["text"]][0]
    assert carry["location"]["headingPath"] in (["Leave Policy", "Carry over"], ["Leave Policy"])


def test_docx_chunk_headingpath_follows_the_document():
    from app.ingestion.extractors import docx as dx

    ex = dx.extract(fx.make_docx(), L)
    by_text = {b.text: b.loc["headingPath"] for b in ex.blocks}
    assert by_text["Up to 5 unused days may be carried into the next year."] == ["Leave Policy", "Carry over"]
    assert by_text["Requests are approved by the line manager."] == ["Approval"]
    assert by_text["Engineer | 24"] == ["Leave Policy", "Carry over"]


def test_xlsx_sheets_rows_and_hidden_sheets():
    r = run("xlsx", fx.make_xlsx())
    assert r["status"] == "indexed" and r["stats"]["sheets"] == 2
    text = all_text(r)
    assert "Sheet: Budget" in text and "Department: Engineering | Q1: 1200 | Q2: 1350.5" in text
    assert "2026-01-05" in text
    assert "HIDDEN-SHEET-DATA" not in text  # hidden sheets are not indexed
    sheets = {c["location"]["sheet"]: c["location"] for c in r["chunks"]}
    assert set(sheets) == {"Budget", "Headcount"}
    assert (sheets["Budget"]["rowStart"], sheets["Budget"]["rowEnd"]) == (2, 3)


def test_pptx_slide_numbers_titles_and_tables():
    r = run("pptx", fx.make_pptx())
    assert r["status"] == "indexed" and r["stats"]["slides"] == 3 and r["stats"]["slidesWithText"] == 2
    text = all_text(r)
    assert "Roadmap 2027" in text and "Ship the AI assistant" in text and "Adoption | 80%" in text
    loc = r["chunks"][0]["location"]
    assert loc["slideStart"] == 1 and loc["slideEnd"] == 2  # two small slides share one chunk; the range says so


# ---- documents that must be SKIPPED with a reason ---------------------------------------------

@pytest.mark.parametrize("fmt", ["txt", "csv", "docx", "xlsx", "pptx"])
def test_empty_documents(fmt):
    empties = {"txt": b"   \n\n  ", "csv": b"\n\n", "docx": None, "xlsx": None, "pptx": None}
    if fmt == "docx":
        from docx import Document

        b = io.BytesIO(); Document().save(b); data = b.getvalue()
    elif fmt == "xlsx":
        from openpyxl import Workbook

        b = io.BytesIO(); Workbook().save(b); data = b.getvalue()
    elif fmt == "pptx":
        from pptx import Presentation

        b = io.BytesIO(); Presentation().save(b); data = b.getvalue()
    else:
        data = empties[fmt]
    skipped(fmt, data, "EMPTY")


def test_zero_byte_file():
    for fmt in ("txt", "csv"):
        skipped(fmt, b"", "EMPTY")
    for fmt in ("pdf", "docx", "xlsx", "pptx"):
        skipped(fmt, b"", "CORRUPT")


def test_scanned_pdf_is_skipped_for_ocr_not_indexed():
    skipped("pdf", fx.blank_pdf(3), "NO_EXTRACTABLE_TEXT")


def test_encrypted_pdf():
    skipped("pdf", fx.encrypt_pdf(fx.make_pdf([["Secret salary table", "for the board only"]])), "ENCRYPTED")


def test_password_protected_office_files_are_ole_containers():
    for fmt in ("docx", "xlsx", "pptx"):
        skipped(fmt, fx.ole_container(), "ENCRYPTED")


@pytest.mark.parametrize("fmt", ["pdf", "docx", "xlsx", "pptx"])
def test_garbage_and_truncated_files_are_corrupt(fmt):
    skipped(fmt, b"this is definitely not a document" * 50, "CORRUPT")
    good = {"pdf": fx.make_pdf([["hello there friend"]]), "docx": fx.make_docx(), "xlsx": fx.make_xlsx(), "pptx": fx.make_pptx()}[fmt]
    r = run(fmt, good[: len(good) // 2])
    assert r["status"] == "skipped" and r["reason"] == "CORRUPT"


def test_binary_data_named_txt_or_csv():
    skipped("txt", bytes(range(256)) * 40 + b"\x00" * 3000, "CORRUPT")
    skipped("csv", b"a,b\n" + b"\x00" * 5000, "CORRUPT")


def test_office_file_with_a_missing_main_part():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("word/other.xml", "<x/>")
    skipped("docx", buf.getvalue(), "CORRUPT")


@pytest.mark.parametrize("fmt", ["doc", "xls", "ppt", "zip", "png", "jpg", "exe", ""])
def test_unsupported_formats_never_pass_as_indexed(fmt):
    skipped(fmt, b"anything", "UNSUPPORTED_FORMAT")


def test_oversized_input():
    skipped("txt", b"x" * 2000, "FILE_TOO_LARGE", dataclasses.replace(L, max_file_bytes=1000))


def test_too_much_extracted_text():
    skipped("txt", ("word " * 500).encode(), "TOO_MUCH_TEXT", dataclasses.replace(L, max_text_chars=1000))
    skipped("csv", fx.make_csv(2000), "TOO_MUCH_TEXT", dataclasses.replace(L, max_text_chars=2000))


def test_too_many_chunks():
    skipped("txt", fx.make_txt(60), "TOO_MUCH_TEXT", dataclasses.replace(L, max_chunks=3))


def test_row_limit():
    skipped("csv", fx.make_csv(50), "TOO_MUCH_TEXT", dataclasses.replace(L, max_rows=10))


def test_pdf_page_limit():
    skipped("pdf", fx.make_pdf([["page text here"]] * 5), "ARCHIVE_LIMIT", dataclasses.replace(L, max_pdf_pages=3))


def test_checksum_mismatch_is_an_error_not_a_skip():
    with pytest.raises(ChecksumMismatch):
        process_bytes("txt", b"hello world hello world", L, expected_sha256="0" * 64)


# ---- archive / decompression attacks -----------------------------------------------------------------

def test_zip_bomb_is_rejected_before_any_parser_runs():
    bomb = fx.zip_bomb_xlsx(80)
    assert len(bomb) < 2 * 1024 * 1024  # tiny on disk, 80 MB inflated
    skipped("xlsx", bomb, "ARCHIVE_LIMIT")


def test_total_uncompressed_size_limit():
    data = fx.minimal_ooxml("word/document.xml", fill=("word/media/x.bin", 30))
    skipped("docx", data, "ARCHIVE_LIMIT", dataclasses.replace(L, max_zip_uncompressed=10 * 1024 * 1024, max_zip_ratio=10**9))


def test_single_entry_size_limit():
    data = fx.minimal_ooxml("ppt/presentation.xml", fill=("ppt/big.bin", 12))
    skipped("pptx", data, "ARCHIVE_LIMIT", dataclasses.replace(L, max_zip_entry=5 * 1024 * 1024, max_zip_ratio=10**9))


def test_entry_count_bomb():
    skipped("docx", fx.many_entries_docx(4000), "ARCHIVE_LIMIT")


def test_zip_path_traversal_names_are_refused():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("word/document.xml", "<x/>")
        z.writestr("../../evil", "x")
    skipped("docx", buf.getvalue(), "CORRUPT")


def test_bomb_checks_do_not_inflate_the_archive():
    # If inspection inflated entries this would take seconds and ~1 GB; it only reads the central directory.
    import time

    big = fx.zip_bomb_xlsx(200)
    start = time.monotonic()
    skipped("xlsx", big, "ARCHIVE_LIMIT")
    assert time.monotonic() - start < 1.0


def test_extract_registry_rejects_unknown_formats():
    with pytest.raises(Skip):
        extract("rtf", b"x", L)
