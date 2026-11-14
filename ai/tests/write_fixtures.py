"""`python -m tests.write_fixtures <dir>`: writes one file per scenario. Used by the Node cross-process test."""
import sys
from pathlib import Path

from tests import fixtures as fx


def main(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    files = {
        "sample.txt": fx.make_txt(4),
        "sample.csv": fx.make_csv(40),
        "sample.docx": fx.make_docx(),
        "sample.xlsx": fx.make_xlsx(),
        "sample.pptx": fx.make_pptx(),
        "sample.pdf": fx.make_pdf([["Annual leave policy.", "Applies to all staff."], ["Second page content here."]]),
        "scanned.pdf": fx.blank_pdf(2),
        "encrypted.pdf": fx.encrypt_pdf(fx.make_pdf([["Secret salary table", "for the board only"]])),
        "bomb.xlsx": fx.zip_bomb_xlsx(100),
        "corrupt.docx": b"PK\x03\x04 this is not really a zip" * 20,
        "empty.txt": b"  \n\n ",
    }
    for name, data in files.items():
        (out / name).write_bytes(data)


if __name__ == "__main__":
    main(Path(sys.argv[1]))
