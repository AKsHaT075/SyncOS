"""Token sizing for chunking (pipeline p2).

p1 estimated tokens as chars/4, which is wrong by a wide margin for non-Latin scripts (Hindi/Punjabi take far
more tokens per character) and let chunks exceed the embedding window. p2 measures with the SAME tokenizer the
embedding model uses, so a chunk's size is a fact, not a guess.
"""
from __future__ import annotations

import re
from typing import Protocol, Sequence


class SizerUnavailable(Exception):
    """No tokenizer could be loaded. Chunking refuses to fall back to an approximation silently."""


class Sizer(Protocol):
    name: str

    def count_many(self, texts: Sequence[str]) -> list[int]: ...


class TokenizerSizer:
    name = "tokenizer"

    def __init__(self, tokenizer_path: str) -> None:
        try:
            from tokenizers import Tokenizer

            self._tok = Tokenizer.from_file(tokenizer_path)
        except Exception:
            raise SizerUnavailable() from None

    def count_many(self, texts: Sequence[str]) -> list[int]:
        # add_special_tokens=False: the chunk's own content. The embedder adds the passage prefix and <s>/</s>
        # on top, which the chunker's window already reserves room for (see limits.window_tokens).
        return [len(e.ids) for e in self._tok.encode_batch(list(texts), add_special_tokens=False)]


class WordSizer:
    """Deterministic test double: one token per word-ish run. NEVER used in production paths."""

    name = "words"
    _RUN = re.compile(r"\w+|[^\w\s]", re.UNICODE)

    def count_many(self, texts: Sequence[str]) -> list[int]:
        return [len(self._RUN.findall(t)) for t in texts]


def build_sizer(tokenizer_path: str | None) -> Sizer:
    if not tokenizer_path:
        raise SizerUnavailable()
    return TokenizerSizer(tokenizer_path)
