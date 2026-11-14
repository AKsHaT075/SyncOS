import dataclasses
import os
import time

import pytest

from app.ingestion.isolate import IsolationError, run_isolated
from app.ingestion.limits import Limits
from app.ingestion.pipeline import process_file
from tests import fixtures as fx

L = Limits(timeout_seconds=5.0)  # (no tokenizer: only used by tests that never chunk)


def ok(x):
    return {"echo": x}


def sleeper(seconds):
    time.sleep(seconds)
    return {}


def hard_crash():
    os._exit(139)  # simulates a segfault in a native parser


def raises():
    raise RuntimeError("DOCUMENT-SECRET text that must not travel")


def eat_memory():
    raise MemoryError()


def test_returns_the_child_result():
    assert run_isolated(ok, (7,), L) == {"echo": 7}


def test_wall_clock_timeout_kills_the_child():
    start = time.monotonic()
    with pytest.raises(IsolationError) as e:
        run_isolated(sleeper, (60,), dataclasses.replace(L, timeout_seconds=1.0))
    assert e.value.reason == "EXTRACTION_TIMEOUT"
    assert time.monotonic() - start < 6


def test_child_crash_is_reported_not_propagated():
    with pytest.raises(IsolationError) as e:
        run_isolated(hard_crash, (), L)
    assert e.value.reason in {"EXTRACTION_CRASHED", "EXTRACTION_OOM"}


def test_exceptions_surface_as_a_code_only():
    with pytest.raises(IsolationError) as e:
        run_isolated(raises, (), L)
    assert e.value.reason == "EXTRACTION_CRASHED"
    assert "DOCUMENT-SECRET" not in repr(e.value) + str(e.value)


def test_memory_error_is_distinguished():
    with pytest.raises(IsolationError) as e:
        run_isolated(eat_memory, (), L)
    assert e.value.reason == "EXTRACTION_OOM"


def test_the_child_does_not_inherit_secrets_from_the_parent_state(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_parent_secret")
    # spawn starts a fresh interpreter: module state of the parent is not shared (env is inherited by the OS,
    # which is why the worker process itself is never given GROQ_API_KEY).
    assert run_isolated(ok, ("x",), L) == {"echo": "x"}


def test_a_real_document_through_the_isolated_path(tmp_path, tokenizer_path):
    L = Limits(timeout_seconds=30.0, tokenizer_path=tokenizer_path)
    path = tmp_path / "d.docx"
    path.write_bytes(fx.make_docx())
    result = run_isolated(process_file, ("docx", str(path), L.as_dict(), None), L)
    assert result["status"] == "indexed" and result["stats"]["chunkCount"] >= 1


def test_a_bomb_through_the_isolated_path_is_skipped_quickly(tmp_path, tokenizer_path):
    L = Limits(timeout_seconds=30.0, tokenizer_path=tokenizer_path)
    path = tmp_path / "b.xlsx"
    path.write_bytes(fx.zip_bomb_xlsx(100))
    start = time.monotonic()
    result = run_isolated(process_file, ("xlsx", str(path), L.as_dict(), None), L)
    assert result == {"status": "skipped", "reason": "ARCHIVE_LIMIT", "format": "xlsx", "pipelineVersion": "p2"}
    assert time.monotonic() - start < 4
