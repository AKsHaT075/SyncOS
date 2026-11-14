"""Structure-aware, token-aware chunking (pipeline p2).

Sizes are REAL tokens of the embedding model's tokenizer (see sizer.py), never chars/4:
target ~350, soft minimum ~230, maximum ~450, overlap 12% of the target. Every chunk's content is guaranteed to fit
`limits.window_tokens` (500) so that, with the passage prefix and <s></s>, it fits the model's 512-token window and
NOTHING is ever truncated. Rules:

* Blocks (paragraph, table row, slide) are only split when a single block exceeds what a chunk may hold.
* A change of `hard` section (e.g. another worksheet) always starts a new chunk and carries no overlap.
* A change of `soft` section (heading path, slide) starts a new chunk once the current one reached the minimum.
* When a chunk is closed because it is full, the next one starts with the trailing WHOLE blocks of the previous
  one (up to the overlap budget); only when the last block alone exceeds the budget is its tail used instead.
* Chunks are deterministic: the same input and tokenizer always yield identical chunks (idempotent re-ingestion).
"""
from __future__ import annotations

from dataclasses import dataclass

from .limits import Limits
from .model import Block
from .reasons import TOO_MUCH_TEXT, Skip
from .sizer import Sizer
from .split import split_text
from .text import text_hash

MAX_CONTEXT_TOKENS = 110  # a pathological header line (hundreds of columns) is cut so content always has room


@dataclass
class Chunk:
    index: int
    text: str
    text_hash: str
    token_estimate: int  # exact token count (without the embedder's prefix) when sized by the real tokenizer
    location: dict

    def as_dict(self) -> dict:
        return {"index": self.index, "text": self.text, "textHash": self.text_hash, "tokenEstimate": self.token_estimate, "location": self.location}


def _merge_location(blocks: list[Block]) -> dict:
    loc: dict = {}
    first = blocks[0].loc
    if "sheet" in first:
        loc["sheet"] = first["sheet"]
    if first.get("headingPath"):
        loc["headingPath"] = list(first["headingPath"])

    def span(key: str, start: str, end: str, out_start: str, out_end: str) -> None:
        lows = [b.loc.get(start, b.loc.get(key)) for b in blocks if start in b.loc or key in b.loc]
        highs = [b.loc.get(end, b.loc.get(key)) for b in blocks if end in b.loc or key in b.loc]
        if lows:
            loc[out_start], loc[out_end] = min(lows), max(highs)

    span("page", "page", "page", "pageStart", "pageEnd")
    span("slide", "slide", "slide", "slideStart", "slideEnd")
    span("rowStart", "rowStart", "rowEnd", "rowStart", "rowEnd")
    span("charStart", "charStart", "charEnd", "charStart", "charEnd")
    return loc


class _Counter:
    """Token counts with a cache, so each distinct text is tokenized once."""

    def __init__(self, sizer: Sizer) -> None:
        self.sizer = sizer
        self.cache: dict[str, int] = {}

    def many(self, texts: list[str]) -> list[int]:
        missing = [t for t in dict.fromkeys(texts) if t not in self.cache]
        if missing:
            for t, n in zip(missing, self.sizer.count_many(missing)):
                self.cache[t] = n
        return [self.cache[t] for t in texts]

    def one(self, text: str) -> int:
        return self.many([text])[0]


def _split_to_budget(text: str, budget: int, base: int, counter: _Counter) -> list[tuple[str, int, int]]:
    """Pieces of at most `budget` tokens, cut at natural boundaries, tiling the text exactly (offsets relative to base)."""
    total = counter.one(text)
    if total <= budget:
        return [(text, base, base + len(text))]
    factor = 0.85
    for _ in range(12):
        chars = max(40, int(len(text) * budget / max(total, 1) * factor))
        pieces = split_text(text, chars, base)
        counts = counter.many([p for p, _, _ in pieces])
        if all(c <= budget for c in counts):
            return pieces
        factor *= 0.75
    # last resort (should be unreachable): hard cuts every few characters until every piece fits
    chars = 40
    return split_text(text, chars, base)


def _tail_by_tokens(text: str, budget: int, counter: _Counter) -> str:
    """The last <= budget tokens of text, starting at a word boundary."""
    if counter.one(text) <= budget:
        return text
    chars = max(20, int(len(text) * budget / max(counter.one(text), 1)))
    for _ in range(10):
        cut = text[-chars:]
        i = cut.find(" ")
        candidate = cut[i + 1 :] if 0 <= i < len(cut) - 1 else cut
        if counter.one(candidate) <= budget:
            return candidate
        chars = int(chars * 0.8)
    return text[-20:]


def chunk_blocks(blocks: list[Block], limits: Limits, sizer: Sizer) -> list[Chunk]:
    target, minimum, maximum, window = limits.target_tokens, limits.min_tokens, limits.max_tokens, limits.window_tokens
    overlap = int(target * limits.overlap_ratio)
    counter = _Counter(sizer)

    # --- contexts (header lines repeated at the top of every chunk of a section) must leave room for content
    fitted: dict[str, str] = {}
    for b in blocks:
        if b.context and b.context not in fitted:
            ctx = b.context
            if counter.one(ctx) > MAX_CONTEXT_TOKENS:
                ctx = _split_to_budget(ctx, MAX_CONTEXT_TOKENS, 0, counter)[0][0]
            fitted[b.context] = ctx
    blocks = [Block(text=b.text, loc=b.loc, hard=b.hard, soft=b.soft, context=fitted.get(b.context, ""), sep=b.sep) for b in blocks]

    # --- split oversized blocks (room leaves space for the overlap carried in front and the context header)
    expanded: list[Block] = []
    for b in blocks:
        room = max(30, maximum - overlap - (counter.one(b.context) if b.context else 0))
        if counter.one(b.text) <= room:
            expanded.append(b)
            continue
        base = b.loc.get("charStart")
        for piece, start, end in _split_to_budget(b.text, room, base or 0, counter):
            loc = dict(b.loc)
            if base is not None:
                loc["charStart"], loc["charEnd"] = start, end
            expanded.append(Block(text=piece, loc=loc, hard=b.hard, soft=b.soft, context=b.context, sep=b.sep))
    blocks = expanded
    tokens = counter.many([b.text for b in blocks])
    tok_of = {id(b): n for b, n in zip(blocks, tokens)}

    def tok(b: Block) -> int:
        n = tok_of.get(id(b))
        return n if n is not None else counter.one(b.text)  # carried-over tails are short-lived: cached by TEXT, never by id

    def ctx_tok(items: list[Block]) -> int:
        return counter.one(items[0].context) if items[0].context else 0

    def size(items: list[Block]) -> int:
        return ctx_tok(items) + sum(tok(b) for b in items)

    def render(items: list[Block]) -> str:
        body = items[0].text + "".join(b.sep + b.text for b in items[1:])
        return f"{items[0].context}\n{body}" if items[0].context else body

    raw: list[tuple[str, list[Block]]] = []  # (text, blocks) before the final window guarantee

    def emit(items: list[Block]) -> None:
        text = render(items)
        if counter.one(text) <= window or len(items) == 1:
            raw.append((text, items))
            return
        mid = len(items) // 2  # boundary effects pushed a chunk over the window: halve it (rare)
        emit(items[:mid])
        emit(items[mid:])

    cur: list[Block] = []
    new_blocks = 0  # blocks in `cur` that are not carried-over overlap

    def flush(carry: bool) -> None:
        nonlocal cur, new_blocks
        if new_blocks == 0:
            cur, new_blocks = [], 0
            return
        emit(cur)
        if len(raw) > limits.max_chunks * 2:
            raise Skip(TOO_MUCH_TEXT)
        kept: list[Block] = []
        if carry and overlap > 0:
            used = 0
            for b in reversed(cur):
                if used + tok(b) > overlap:
                    break
                kept.insert(0, b)
                used += tok(b)
            if not kept and cur:  # last block is bigger than the budget: carry its tail, never the whole thing
                last = cur[-1]
                piece = _tail_by_tokens(last.text, overlap, counter)
                loc = dict(last.loc)
                if "charEnd" in loc:
                    loc["charStart"] = loc["charEnd"] - len(piece)
                kept = [Block(text=piece, loc=loc, hard=last.hard, soft=last.soft, context=last.context, sep=last.sep)]
        cur, new_blocks = kept, 0

    for b in blocks:
        if cur:
            current = size(cur)
            add = tok(b)
            if b.hard != cur[-1].hard:
                flush(carry=False)
                cur = []
            elif b.soft != cur[-1].soft and current >= minimum:
                flush(carry=False)
                cur = []
            elif current + add > maximum or (current + add > target and current >= minimum):
                flush(carry=True)
        cur.append(b)
        new_blocks += 1
    flush(carry=False)

    chunks: list[Chunk] = []
    for text, items in raw:
        chunks.append(Chunk(len(chunks), text, text_hash(text), counter.one(text), _merge_location(items)))
    if len(chunks) > limits.max_chunks:
        raise Skip(TOO_MUCH_TEXT)
    return chunks
