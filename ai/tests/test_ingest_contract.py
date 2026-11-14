import json
from pathlib import Path

from app.ingestion import PIPELINE_VERSION, reasons
from app.ingestion.extractors import SUPPORTED

C = json.loads((Path(__file__).resolve().parents[1] / "contracts" / "ingestion.json").read_text())


def test_contract_matches_python_constants():
    assert C["pipelineVersion"] == PIPELINE_VERSION
    assert sorted(C["formats"]) == sorted(SUPPORTED)
    assert sorted(C["skipReasons"]) == sorted(reasons.SKIP_REASONS)
    assert sorted(C["failReasons"]) == sorted(reasons.FAIL_REASONS)


def test_every_unsupported_extension_is_declined_with_a_reason():
    from app.ingestion.limits import Limits
    from app.ingestion.pipeline import process_bytes

    for ext in C["unsupportedExtensions"]:
        assert ext not in SUPPORTED
        assert process_bytes(ext, b"x", Limits())["reason"] == "UNSUPPORTED_FORMAT"
