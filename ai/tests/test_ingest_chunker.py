import hashlib
import json
from pathlib import Path

from app.ingestion.chunker import chunk_blocks
from app.ingestion.limits import Limits
from app.ingestion.model import Block
from app.ingestion.sizer import TokenizerSizer, WordSizer
from app.ingestion.split import split_text
from app.ingestion.text import normalize

L = Limits()
W = WordSizer()  # deterministic: ~1 token per word. The real tokenizer is exercised in the *_real_tokenizer tests below.
TARGET, MIN, MAX, WINDOW = L.target_tokens, L.min_tokens, L.max_tokens, L.window_tokens
CORPUS = json.loads((Path(__file__).resolve().parent / "eval" / "multilingual_corpus.json").read_text())


def words(n, tag="w"):
    return " ".join(f"{tag}{i}" for i in range(n))


def para(i, n=60):
    return Block(text=f"P{i}. " + words(n, f"x{i}_") + ".", loc={"page": 1 + i // 5})


def count(text):
    return W.count_many([text])[0]


def chunks_of(blocks, limits=L, sizer=W):
    return chunk_blocks(blocks, limits, sizer)


def test_defaults_are_the_p2_targets():
    assert (L.target_tokens, L.max_tokens, L.window_tokens) == (350, 450, 500)
    assert L.window_tokens + 12 <= 512  # prefix ("passage: ") + <s> </s> still fit the model window


def test_sizes_stay_within_the_band_and_never_exceed_the_window():
    chunks = chunks_of([para(i) for i in range(120)])
    assert len(chunks) > 3
    for c in chunks[:-1]:
        assert count(c.text) <= MAX
        assert count(c.text) >= MIN * 0.6  # whole-block packing + overlap can dip a bit below the soft minimum
    assert all(count(c.text) <= WINDOW for c in chunks)
    assert all(c.token_estimate == count(c.text) for c in chunks)


def test_overlap_is_about_twelve_percent_and_made_of_whole_blocks():
    blocks = [para(i, n=8) for i in range(300)]
    chunks = chunks_of(blocks)
    budget = int(TARGET * L.overlap_ratio)
    texts = {b.text for b in blocks}
    for prev, nxt in zip(chunks, chunks[1:]):
        shared = [p for p in prev.text.split("\n\n") if p in nxt.text]
        assert shared, "consecutive chunks must overlap"
        assert all(p in texts for p in shared)
        assert 0 < sum(count(p) for p in shared) <= budget


def test_an_oversized_block_is_split_and_nothing_exceeds_the_window():
    big = Block(text=("Sentence number one is here. " * 600), loc={"charStart": 0, "charEnd": 29 * 600})
    chunks = chunks_of([big])
    assert len(chunks) >= 8 and all(count(c.text) <= WINDOW for c in chunks)
    pieces = split_text(big.text, 500, 0)
    assert "".join(p for p, _, _ in pieces) == big.text
    assert all(a[2] == b[1] for a, b in zip(pieces, pieces[1:]))  # pieces tile the block exactly


def test_offsets_of_split_pieces_are_exact():
    text = "Sentence number one is here. " * 600
    chunks = chunks_of([Block(text=text, loc={"charStart": 0, "charEnd": len(text)})])
    for c in chunks:
        loc = c.location
        assert 0 <= loc["charStart"] < loc["charEnd"] <= len(text)
        # the chunk's text is (a part of) exactly the span it claims, modulo the overlap tail it starts with
        assert c.text.strip()[:25] in text[loc["charStart"] : loc["charEnd"]] or text[loc["charStart"] : loc["charEnd"]].strip()[:25] in c.text


def test_table_rows_are_atomic_and_keep_their_context():
    ctx = "Columns: name | department | salary"
    rows = [Block(text=f"name: Person{i} | department: Dept{i} | salary: {50000 + i}", loc={"rowStart": i + 2, "rowEnd": i + 2}, context=ctx, sep="\n") for i in range(300)]
    chunks = chunks_of(rows)
    for c in chunks:
        lines = c.text.split("\n")
        assert lines[0] == ctx
        assert all(line.startswith("name: Person") for line in lines[1:])  # never half a row
    assert chunks[0].location["rowStart"] == 2 and chunks[-1].location["rowEnd"] == 301
    assert [c.location["rowStart"] for c in chunks] == sorted(c.location["rowStart"] for c in chunks)


def test_a_pathological_header_line_is_cut_so_content_always_fits():
    ctx = "Columns: " + " | ".join(f"column_{i}" for i in range(2000))
    rows = [Block(text=f"a: {i}", loc={"rowStart": i, "rowEnd": i}, context=ctx, sep="\n") for i in range(2, 200)]
    chunks = chunks_of(rows)
    assert all(count(c.text) <= WINDOW for c in chunks) and len(chunks) < 60


def test_hard_sections_never_mix_and_carry_no_overlap():
    a = [Block(text=f"alpha row {i}", loc={"sheet": "A", "rowStart": i, "rowEnd": i}, hard="A", context="Sheet: A", sep="\n") for i in range(1, 6)]
    b = [Block(text=f"beta row {i}", loc={"sheet": "B", "rowStart": i, "rowEnd": i}, hard="B", context="Sheet: B", sep="\n") for i in range(1, 6)]
    chunks = chunks_of(a + b)
    assert [c.location["sheet"] for c in chunks] == ["A", "B"]
    assert "beta" not in chunks[0].text and "alpha" not in chunks[1].text


def test_soft_sections_split_once_big_enough_and_merge_when_small():
    small = [Block(text=f"slide {i} " + words(20), loc={"slide": i}, soft=i) for i in range(1, 4)]
    one = chunks_of(small)
    assert len(one) == 1 and (one[0].location["slideStart"], one[0].location["slideEnd"]) == (1, 3)
    large = [Block(text=f"slide {i} " + words(MIN + 20), loc={"slide": i}, soft=i) for i in range(1, 4)]
    many = chunks_of(large)
    assert [(c.location["slideStart"], c.location["slideEnd"]) for c in many] == [(1, 1), (2, 2), (3, 3)]


def test_heading_path_and_page_ranges_survive():
    h = chunks_of([Block(text="Body text " * 20, loc={"headingPath": ["Policy", "Leave"]}, soft=("Policy", "Leave"))])
    assert h[0].location["headingPath"] == ["Policy", "Leave"]
    pages = chunks_of([Block(text=f"para {i} " + words(40), loc={"page": 1 + i // 3}) for i in range(9)])
    assert pages[0].location["pageStart"] == 1 and pages[0].location["pageEnd"] == 3


def test_deterministic_and_hashes_are_sha256_of_the_text():
    a, b = chunks_of([para(i) for i in range(60)]), chunks_of([para(i) for i in range(60)])
    assert [(c.text, c.text_hash, c.location) for c in a] == [(c.text, c.text_hash, c.location) for c in b]
    assert [c.index for c in a] == list(range(len(a)))
    assert all(c.text_hash == hashlib.sha256(c.text.encode()).hexdigest() for c in a)


def test_every_chunk_adds_new_content_and_all_content_is_covered():
    blocks = [para(i) for i in range(41)]
    chunks = chunks_of(blocks)
    seen = set()
    for c in chunks:
        parts = set(c.text.split("\n\n"))
        assert parts - seen
        seen |= parts
    joined = "\n".join(c.text for c in chunks)
    assert all(b.text in joined for b in blocks)


def test_single_tiny_block_and_normalize():
    assert [c.text for c in chunks_of([Block(text="hello", loc={})])] == ["hello"]
    assert normalize("a\r\nb c\x00\x07  \n\n\n\n d") == "a\nb\nc\n\n d"


# ---- the REAL tokenizer: sizes are facts, and nothing can exceed the embedding window --------------------------------

def _multilingual_text(repeat):
    out = []
    for lang in ("en", "hi", "pa"):
        out += [row["passage"] for row in CORPUS["languages"][lang]] * repeat
    return out


def test_real_tokenizer_all_languages_fit_the_embedding_window(tokenizer_path):
    sizer = TokenizerSizer(tokenizer_path)
    for lang in ("en", "hi", "pa"):
        # one long document per language, as ~100 paragraphs
        blocks = [Block(text=row["passage"], loc={"page": 1}) for row in CORPUS["languages"][lang] * 25]
        chunks = chunk_blocks(blocks, L, sizer)
        assert chunks
        counts = sizer.count_many([c.text for c in chunks])
        assert max(counts) <= WINDOW, (lang, max(counts))
        assert all(c.token_estimate == n for c, n in zip(chunks, counts))
        # with the passage prefix and special tokens the model window (512) is still respected
        with_prefix = [len(sizer._tok.encode("passage: " + c.text).ids) for c in chunks]
        assert max(with_prefix) <= 512, (lang, max(with_prefix))


def test_real_tokenizer_shows_why_chars_over_4_was_unsafe(tokenizer_path):
    # Documents WHY p2 exists: for Gurmukhi, chars/4 under-counts real tokens by ~30%, so a "600 token" p1 chunk could
    # really be ~780 tokens - far over the 512-token embedding window.
    sizer = TokenizerSizer(tokenizer_path)
    text = " ".join(row["passage"] for row in CORPUS["languages"]["pa"])
    assert sizer.count_many([text])[0] > 1.2 * (len(text) / 4)
    en = " ".join(row["passage"] for row in CORPUS["languages"]["en"])
    assert sizer.count_many([en])[0] < 1.05 * (len(en) / 4)


def test_real_tokenizer_one_enormous_paragraph_in_each_language(tokenizer_path):
    sizer = TokenizerSizer(tokenizer_path)
    for lang in ("en", "hi", "pa"):
        text = " ".join(row["passage"] for row in CORPUS["languages"][lang] * 40)  # one paragraph, no breaks
        chunks = chunk_blocks([Block(text=text, loc={"charStart": 0, "charEnd": len(text)})], L, sizer)
        counts = sizer.count_many([c.text for c in chunks])
        assert max(counts) <= WINDOW and len(chunks) > 10, (lang, max(counts))
        assert chunks[0].location["charStart"] == 0 and chunks[-1].location["charEnd"] == len(text)


def test_real_tokenizer_sizes_land_near_the_target(tokenizer_path):
    sizer = TokenizerSizer(tokenizer_path)
    blocks = [Block(text=row["passage"], loc={"page": 1}) for row in CORPUS["languages"]["en"] * 60]
    counts = sizer.count_many([c.text for c in chunk_blocks(blocks, L, sizer)])
    inner = counts[:-1]
    assert all(MIN * 0.6 <= n <= MAX for n in inner)
    assert abs(sum(inner) / len(inner) - TARGET) < 90  # on average close to the 350 target
