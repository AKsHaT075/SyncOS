"""Self-hosted multilingual-e5-small through FastEmbed's ONNX runtime (CPU, no torch).

* Loaded ONCE per process (`get_provider`), never per request or per job.
* The exact model revision is pinned (huggingface_hub `revision=`) and files are verified before use.
* The model's tokenizer is used to measure every input; an input that would not fit the 512-token window is
  REFUSED (InputTooLong) because FastEmbed would otherwise truncate it silently.
* Outputs are validated: shape, finiteness and unit norm.
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import numpy as np

from .provider import BadOutput, InputTooLong, ModelUnavailable
from .spec import E5_SMALL, ModelSpec, space_id

log = logging.getLogger("ai.embeddings")


@dataclass(frozen=True)
class EmbeddingConfig:
    provider: str = "fastembed"  # "fastembed" | "fake"
    cache_dir: str | None = None  # Hugging Face cache; default ~/.cache/huggingface
    offline: bool = False  # True: never touch the network (air-gapped); the cache must already hold the model
    threads: int | None = None  # ONNX intra-op threads; None = library default
    batch_size: int = 16
    model_path: str | None = None  # a prepared local snapshot directory (skips Hugging Face entirely)


def snapshot_dir(spec: ModelSpec, config: EmbeddingConfig) -> Path:
    """Local directory holding the pinned revision. Downloads once (unless offline); verifies required files."""
    if config.model_path:
        root = Path(config.model_path)
    else:
        try:
            from huggingface_hub import snapshot_download

            root = Path(
                snapshot_download(
                    spec.repo,
                    revision=spec.revision,
                    allow_patterns=list(spec.files),
                    cache_dir=config.cache_dir,
                    local_files_only=config.offline,
                )
            )
        except Exception as error:  # network, auth, disk, missing cache while offline...
            log.error("model files unavailable: %s", type(error).__name__)
            raise ModelUnavailable() from None
    missing = [f for f in spec.files if not (root / f).is_file()]
    if missing:
        log.error("model snapshot incomplete (%d file(s) missing)", len(missing))
        raise ModelUnavailable()
    return root


class FastEmbedProvider:
    def __init__(self, spec: ModelSpec = E5_SMALL, config: EmbeddingConfig | None = None, ingestion_pipeline: str = "p2") -> None:
        self.spec = spec
        self.config = config or EmbeddingConfig()
        self.descriptor = spec.descriptor(ingestion_pipeline)
        self.space_id = space_id(self.descriptor)
        self.dimensions = spec.dimensions
        self.max_tokens = spec.max_tokens
        self._lock = threading.Lock()
        self._model = None
        self._tokenizer = None
        self._load()

    def _load(self) -> None:
        root = snapshot_dir(self.spec, self.config)
        try:
            import json

            hidden = json.loads((root / "config.json").read_text()).get("hidden_size")
            if hidden != self.spec.dimensions:  # the files on disk are not the model we think they are
                raise ModelUnavailable()
            from fastembed import TextEmbedding
            from fastembed.common.model_description import ModelSource, PoolingType
            from tokenizers import Tokenizer

            known = {m["model"] for m in TextEmbedding.list_supported_models()}
            if self.spec.repo not in known:
                TextEmbedding.add_custom_model(
                    model=self.spec.repo,
                    pooling=PoolingType.MEAN,
                    normalization=self.spec.normalize,
                    sources=ModelSource(hf=self.spec.repo),
                    dim=self.spec.dimensions,
                    model_file=self.spec.model_file,
                    description="multilingual-e5-small (pinned revision, local snapshot)",
                    license="mit",
                    size_in_gb=0.47,
                )
            self._tokenizer = Tokenizer.from_file(str(root / "tokenizer.json"))
            self._model = TextEmbedding(
                model_name=self.spec.repo,
                specific_model_path=str(root),
                threads=self.config.threads,
                cache_dir=self.config.cache_dir,
            )
        except ModelUnavailable:
            raise
        except Exception as error:
            log.error("model failed to initialize: %s", type(error).__name__)
            raise ModelUnavailable() from None
        log.info("embedding model ready space=%s dims=%d", self.space_id, self.dimensions)

    # ------------------------------------------------------------------ interface

    def count_tokens(self, texts: Sequence[str]) -> list[int]:
        encodings = self._tokenizer.encode_batch([self.spec.passage_prefix + t for t in texts])
        return [len(e.ids) for e in encodings]

    def tokenizer(self):
        return self._tokenizer

    def _embed(self, prefixed: list[str]) -> np.ndarray:
        counts = [len(e.ids) for e in self._tokenizer.encode_batch(prefixed)]
        if any(c > self.max_tokens for c in counts):
            raise InputTooLong()  # never let the model truncate content silently
        try:
            with self._lock:
                vectors = np.asarray(list(self._model.embed(prefixed, batch_size=self.config.batch_size)), dtype=np.float32)
        except Exception as error:
            log.error("embedding failed: %s", type(error).__name__)
            raise ModelUnavailable() from None
        return validate_output(vectors, len(prefixed), self.dimensions)

    def embed_passages(self, texts: Sequence[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dimensions), dtype=np.float32)
        return self._embed([self.spec.passage_prefix + t for t in texts])

    def embed_query(self, text: str) -> np.ndarray:
        return self._embed([self.spec.query_prefix + text])[0]

    def close(self) -> None:
        self._model = None
        self._tokenizer = None


def validate_output(vectors: np.ndarray, expected_rows: int, dimensions: int) -> np.ndarray:
    if vectors.ndim != 2 or vectors.shape != (expected_rows, dimensions):
        raise BadOutput()
    if not np.isfinite(vectors).all():
        raise BadOutput()
    norms = np.linalg.norm(vectors, axis=1)
    if not np.allclose(norms, 1.0, atol=1e-3):
        raise BadOutput()
    return vectors
