"""Deterministic, dependency-light stand-in for tests and CI. NOT a language model: texts that share words get
similar vectors (bag of hashed words), which is enough to test storage, search ordering, normalization and jobs.
Its own space id means its vectors can never be mixed with real ones."""
from __future__ import annotations

import hashlib
import re
from typing import Sequence

import numpy as np

from .provider import BadOutput, InputTooLong, ModelUnavailable
from .spec import FAKE, ModelSpec, space_id

_WORD = re.compile(r"\w+", re.UNICODE)


class FakeProvider:
    def __init__(self, spec: ModelSpec = FAKE, ingestion_pipeline: str = "p2", max_tokens: int | None = None, fail_init: bool = False) -> None:
        if fail_init:
            raise ModelUnavailable()
        self.spec = spec
        self.descriptor = spec.descriptor(ingestion_pipeline)
        self.space_id = space_id(self.descriptor)
        self.dimensions = spec.dimensions
        self.max_tokens = max_tokens or spec.max_tokens
        self.calls = 0
        self.fail_next: Exception | None = None
        self.corrupt_output: str | None = None  # "nan" | "shape" | "norm" (for failure-path tests)

    @staticmethod
    def _tokens(text: str) -> list[str]:
        return _WORD.findall(text.lower())

    def count_tokens(self, texts: Sequence[str]) -> list[int]:
        return [len(self._tokens(self.spec.passage_prefix + t)) + 2 for t in texts]  # +2 ~ <s> </s>

    def _vector(self, text: str) -> np.ndarray:
        v = np.zeros(self.dimensions, dtype=np.float64)
        for token in self._tokens(text):
            seed = int.from_bytes(hashlib.sha256(token.encode()).digest()[:8], "little")
            v += np.random.default_rng(seed).standard_normal(self.dimensions)
        norm = np.linalg.norm(v)
        return (v / norm if norm else np.eye(self.dimensions)[0]).astype(np.float32)

    def _run(self, prefixed: list[str]) -> np.ndarray:
        self.calls += 1
        if self.fail_next is not None:
            error, self.fail_next = self.fail_next, None
            raise error
        if any(n > self.max_tokens for n in self.count_tokens([p[len(self.spec.passage_prefix):] if p.startswith(self.spec.passage_prefix) else p for p in prefixed])):
            raise InputTooLong()
        out = np.stack([self._vector(p) for p in prefixed]) if prefixed else np.zeros((0, self.dimensions), dtype=np.float32)
        if self.corrupt_output == "nan":
            out[0, 0] = np.nan
        elif self.corrupt_output == "shape":
            out = out[:, :-1]
        elif self.corrupt_output == "norm":
            out = out * 2.0
        if self.corrupt_output:
            from .fastembed_provider import validate_output

            return validate_output(out, len(prefixed), self.dimensions)
        return out

    def embed_passages(self, texts: Sequence[str]) -> np.ndarray:
        return self._run([self.spec.passage_prefix + t for t in texts])

    def embed_query(self, text: str) -> np.ndarray:
        return self._run([self.spec.query_prefix + text])[0]

    def close(self) -> None:  # pragma: no cover
        return None
