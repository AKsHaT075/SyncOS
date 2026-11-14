import json

import pytest

from app.core.errors import ProviderError
from app.orchestration.generate import encode_frame
from tests.conftest import load_contract

CASES = load_contract("frames.json")["cases"]


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["name"])
def test_encoding_matches_the_shared_wire_fixture(case):
    assert b"".join(encode_frame(e) for e in case["events"]).decode() == case["wire"]


def test_error_frames_have_exactly_the_contract_fields():
    frame = ProviderError("AI_PROVIDER_UNAVAILABLE", retryable=True, upstream_status=503, stream_started=True).frame()
    assert set(frame) == {"type", "code", "retryable", "streamStarted", "upstreamStatus"}


def test_frames_are_parseable_back():
    for case in CASES:
        for block in case["wire"].strip().split("\n\n"):
            event_line, data_line = block.split("\n")
            payload = json.loads(data_line.removeprefix("data: "))
            assert event_line == f"event: {payload['type']}"
