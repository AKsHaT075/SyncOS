"""Measures the REAL model on this machine: load time, memory, latency, throughput, and multilingual retrieval smoke
quality. Usage: python scripts/benchmark_embeddings.py [--offline] [--threads N]. Prints numbers only (no document text)."""
import argparse
import json
import resource
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.embeddings.fastembed_provider import EmbeddingConfig, FastEmbedProvider  # noqa: E402


def rss_mb() -> float:
    # ru_maxrss is bytes on macOS, kilobytes on Linux
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return r / (1024 * 1024) if sys.platform == "darwin" else r / 1024


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--threads", type=int, default=None)
    args = ap.parse_args()

    before = rss_mb()
    t0 = time.perf_counter()
    cpu0 = time.process_time()
    p = FastEmbedProvider(config=EmbeddingConfig(offline=args.offline, threads=args.threads))
    load_s = time.perf_counter() - t0
    print(f"space={p.space_id} dims={p.dimensions} load_seconds={load_s:.2f} rss_after_load_mb={rss_mb():.0f} (before {before:.0f})")

    corpus = json.loads((Path(__file__).resolve().parents[1] / "tests/eval/multilingual_corpus.json").read_text())
    langs = corpus["languages"]
    passages = {l: [x["passage"] for x in rows] for l, rows in langs.items()}
    queries = {l: [x["query"] for x in rows] for l, rows in langs.items()}

    vecs = {l: p.embed_passages(v) for l, v in passages.items()}
    all_vecs = np.concatenate(list(vecs.values()))
    labels = [(l, i) for l in vecs for i in range(len(vecs[l]))]
    print("norms min/max:", float(np.linalg.norm(all_vecs, axis=1).min()), float(np.linalg.norm(all_vecs, axis=1).max()))

    def recall(qlang, plangs):
        hits = 0
        for i, q in enumerate(queries[qlang]):
            qv = p.embed_query(q)
            cand = [(l, j) for l, j in labels if l in plangs]
            scores = [float(qv @ vecs[l][j]) for l, j in cand]
            best = cand[int(np.argmax(scores))]
            hits += best[1] == i  # the right TOPIC, in any allowed language
            if best[1] != i:
                print(f"   miss: query={qlang} topic={corpus['topics'][i]} -> retrieved topic={corpus['topics'][best[1]]} ({best[0]})")
        return hits / len(queries[qlang])

    for ql in ("en", "hi", "pa"):
        print(f"query={ql}: same-language recall@1={recall(ql, [ql]):.2f} | any-language topic recall@1={recall(ql, ['en','hi','pa']):.2f}")
    # margin: how well separated the right passage is
    for ql in ("en", "hi", "pa"):
        margins = []
        for i, q in enumerate(queries[ql]):
            s = vecs[ql] @ p.embed_query(q)
            right = s[i]
            wrong = np.delete(s, i)
            margins.append(float(right - wrong.max()))
        print(f"query={ql}: mean margin right-vs-best-wrong={np.mean(margins):.3f} min={np.min(margins):.3f}")

    # latency / throughput on realistic chunks (≈ 350 tokens)
    base = passages["en"][0]
    for extra in passages["en"][1:] * 3:  # grow to ~350 tokens, the p2 chunk target
        if p.count_tokens([base + " " + extra])[0] > 350:
            break
        base += " " + extra
    toks = p.count_tokens([base])[0]
    batch = [base] * 16
    p.embed_passages(batch[:2])  # warm up
    for n in (1, 8, 16):
        c0, w0 = time.process_time(), time.perf_counter()
        p.embed_passages(batch[:n])
        w, c = time.perf_counter() - w0, time.process_time() - c0
        print(f"batch={n} tokens/text={toks} wall={w:.2f}s ({w / n * 1000:.0f} ms/chunk) cpu={c:.2f}s cpu/wall={c / w:.1f}")
    print(f"peak_rss_mb={rss_mb():.0f}")


if __name__ == "__main__":
    main()
