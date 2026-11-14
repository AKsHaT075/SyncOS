"""The embedding SPACE: everything that decides what a vector means.

Two vectors are comparable only if they came from the same space. A space is identified by a hash of ALL of:
model, exact revision, ONNX file, dimensions, pooling, normalization, query/passage prefixes, max input tokens,
the embedding pipeline version and the ingestion (chunking) pipeline version. Change any of them and the
space id changes, which means: a different Qdrant collection, new jobs, and a validated migration - never a
silent mix. Node computes the SAME id from ai/contracts/embedding.json (a golden test pins it).
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

EMBEDDING_PIPELINE = "e1"  # bump when pooling/normalization/batching/pre-processing code changes the vectors


@dataclass(frozen=True)
class ModelSpec:
    key: str
    provider: str
    repo: str
    revision: str
    model_file: str
    dimensions: int
    pooling: str
    normalize: bool
    query_prefix: str
    passage_prefix: str
    max_tokens: int
    files: tuple[str, ...]  # what must be present locally (downloaded once, then cached)

    def descriptor(self, ingestion_pipeline: str) -> dict:
        return {
            "provider": self.provider,
            "model": self.repo,
            "revision": self.revision,
            "modelFile": self.model_file,
            "dimensions": self.dimensions,
            "pooling": self.pooling,
            "normalize": self.normalize,
            "queryPrefix": self.query_prefix,
            "passagePrefix": self.passage_prefix,
            "maxTokens": self.max_tokens,
            "distance": "cosine",
            "embeddingPipeline": EMBEDDING_PIPELINE,
            "ingestionPipeline": ingestion_pipeline,
        }


E5_SMALL = ModelSpec(
    key="multilingual-e5-small",
    provider="fastembed-onnx",
    repo="intfloat/multilingual-e5-small",
    revision="614241f622f53c4eeff9890bdc4f31cfecc418b3",
    model_file="onnx/model.onnx",
    dimensions=384,
    pooling="mean",
    normalize=True,
    query_prefix="query: ",
    passage_prefix="passage: ",
    max_tokens=512,
    files=(
        "onnx/model.onnx",
        "config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "special_tokens_map.json",
        "sentence_bert_config.json",
        "1_Pooling/config.json",
    ),
)

# Deterministic stand-in for tests and CI. Its own model name/revision give it its own space id, so its vectors
# can never be mistaken for (or mixed with) real ones.
FAKE = ModelSpec(
    key="fake-hash-384",
    provider="fake",
    repo="syncos/fake-hash",
    revision="test",
    model_file="none",
    dimensions=384,
    pooling="mean",
    normalize=True,
    query_prefix="query: ",
    passage_prefix="passage: ",
    max_tokens=512,
    files=(),
)

SPECS = {s.key: s for s in (E5_SMALL, FAKE)}


def canonical(descriptor: dict) -> str:
    return json.dumps(descriptor, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def space_id(descriptor: dict) -> str:
    return hashlib.sha256(canonical(descriptor).encode()).hexdigest()[:12]
