"""Retrieval evaluation through the REAL pipeline (real E5 model, real vector store, the real retrieve/select logic), with Node's
authorization decisions simulated by SimAuthorizer. Measures ranking quality, context quality, cross-language retrieval,
no-answer behaviour, and that unauthorized / stale / duplicate documents never reach the context.

Relevance is by TOPIC: any document on the question's topic (in any language) is relevant. Metrics are over DOCUMENTS (a
document's score is its best chunk), computed on the AUTHORIZED candidates, i.e. what the user could ever be shown."""
from __future__ import annotations

import asyncio
import dataclasses
from collections import defaultdict

import numpy as np

from app.rag.config import RagSettings
from app.rag.retrieval import retrieve
from tests.rag_support import CORPUS, ORG, SimAuthorizer, build_index, doc_id, topic_of

DOCS_BY_TOPIC: dict = defaultdict(set)
for _d in CORPUS["documents"]:
    if _d["visibility"] == "organization" and _d.get("current_version", 1) == _d["version"]:
        DOCS_BY_TOPIC[_d["topic"]].add(doc_id(_d["id"]))
LANG_OF = {doc_id(d["id"]): d["lang"] for d in CORPUS["documents"]}
FORBIDDEN = {doc_id(d["id"]) for d in CORPUS["documents"] if d["visibility"] in {"private-other", "trashed"}}
STALE = {(doc_id("en-notice"), 1)}


async def _run(provider, store, space, cfg, question):
    auth = SimAuthorizer()
    vector = provider.embed_query(question["text"])
    result = await retrieve(vector=vector, store=store, authorizer=auth, organization=ORG, space_id=space, cfg=cfg)
    return result, auth


def ranked_documents(provider, store, space, question) -> list[tuple[str, float]]:
    """Authorized documents ranked by best chunk score (what the user could ever be shown), unaffected by the threshold."""
    hits = store.search(organization=ORG, space_id=space, vector=provider.embed_query(question["text"]), limit=60)
    auth = SimAuthorizer()
    best: dict[str, float] = {}
    for h in hits:
        d = auth.docs.get((h.document, h.version))
        if d is None or d["visibility"] in {"private-other", "trashed"} or auth.current[h.document] != h.version:
            continue
        best.setdefault(h.document, h.score)
    return sorted(best.items(), key=lambda kv: -kv[1])


def evaluate(provider, store, cfg: RagSettings | None = None, ks=(1, 3, 5)) -> dict:
    cfg = cfg or RagSettings(enabled=True)
    space = build_index(provider, store)
    out: dict = {"cfg": {"min_score": cfg.min_score, "score_window": cfg.score_window, "top_k": cfg.top_k}, "rank": {}, "context": {}, "cross": {}, "no_answer": {}, "security": {}}
    answerable = [q for q in CORPUS["questions"] if q["kind"] == "answerable"]

    # ---- ranking quality (threshold-independent) -----------------------------------------------------------------------
    per_lang: dict = defaultdict(lambda: defaultdict(list))
    cross_hits: list[int] = []
    for q in answerable:
        docs = ranked_documents(provider, store, space, q)
        relevant = DOCS_BY_TOPIC[q["topic"]]
        order = [d for d, _ in docs]
        rank = next((i + 1 for i, d in enumerate(order) if d in relevant), None)
        bucket = per_lang[q["lang"]]
        bucket["mrr"].append(0.0 if rank is None else 1.0 / rank)
        for k in ks:
            top = order[:k]
            bucket[f"hit@{k}"].append(1.0 if any(d in relevant for d in top) else 0.0)
            bucket[f"recall@{k}"].append(len(relevant & set(top)) / len(relevant))
            bucket[f"precision@{k}"].append(sum(1 for d in top if d in relevant) / k)
        if not any(LANG_OF[d] == q["lang"] for d in relevant):  # no document in the question's language: pure cross-language
            cross_hits.append(1 if any(d in relevant for d in order[:3]) else 0)
    out["rank"] = {lang: {m: round(float(np.mean(v)), 3) for m, v in b.items()} for lang, b in per_lang.items()}
    allq = defaultdict(list)
    for b in per_lang.values():
        for m, v in b.items():
            allq[m].extend(v)
    out["rank"]["all"] = {m: round(float(np.mean(v)), 3) for m, v in allq.items()}
    out["cross"] = {"questions": len(cross_hits), "hit@3": round(float(np.mean(cross_hits)), 3) if cross_hits else None}

    # ---- the real retrieve()/select() pipeline: what would actually be given to the model -------------------------------------
    ctx_prec, ctx_has, empty_answerable, budget_ok, dupes = [], [], 0, True, 0
    for q in answerable:
        r, _ = asyncio.run(_run(provider, store, space, cfg, q))
        relevant = DOCS_BY_TOPIC[q["topic"]]
        used = [s.document_id for s in r.sources]
        if not used:
            empty_answerable += 1
        else:
            ctx_prec.append(sum(1 for d in used if d in relevant) / len(used))
            ctx_has.append(1.0 if any(d in relevant for d in used) else 0.0)
        budget_ok &= sum(s.tokens for s in r.sources) <= cfg.context_tokens
        dupes += r.duplicates
        copy, original = doc_id("en-leave-copy"), doc_id("en-leave")
        if copy in used and original in used:
            out["security"]["near_duplicate_both_used"] = out["security"].get("near_duplicate_both_used", 0) + 1
    out["context"] = {"answerable": len(answerable), "context_precision": round(float(np.mean(ctx_prec)), 3), "answer_bearing_context_rate": round(sum(ctx_has) / len(answerable), 3), "false_no_answer": empty_answerable, "budget_respected": budget_ok, "near_duplicates_dropped": dupes}

    # ---- no answer -------------------------------------------------------------------------------------------------------------
    no = [q for q in CORPUS["questions"] if q["kind"] == "no_answer"]
    refused = 0
    for q in no:
        r, _ = asyncio.run(_run(provider, store, space, cfg, q))
        refused += 0 if r.sources else 1
    out["no_answer"] = {"questions": len(no), "correctly_refused": refused, "rate": round(refused / len(no), 3)}

    # ---- security: documents the user may not use never reach the context -----------------------------------------------------------
    leaked, stale_used, stale_current = 0, 0, 0
    probes = [q for q in CORPUS["questions"] if q["kind"] in {"unauthorized", "stale"}]
    for q in probes:
        r, auth = asyncio.run(_run(provider, store, space, cfg, q))
        leaked += sum(1 for s in r.sources if s.document_id in FORBIDDEN)
        stale_used += sum(1 for s in r.sources if (s.document_id, s.version) in STALE)
        if q["kind"] == "stale":
            stale_current += sum(1 for s in r.sources if s.document_id == doc_id("en-notice") and s.version == 2)
        asked = {k[0] for batch in auth.calls for k in batch}
    unauthorized_no_answer = sum(1 for q in probes if q["kind"] == "unauthorized" and not asyncio.run(_run(provider, store, space, cfg, q))[0].sources)
    out["security"].update({"forbidden_chunks_in_context": leaked, "stale_version_chunks_in_context": stale_used, "current_version_found_for_stale_question": stale_current, "unauthorized_questions_without_answer": f"{unauthorized_no_answer}/{sum(1 for q in probes if q['kind'] == 'unauthorized')}"})
    return out


def sweep(provider, store, thresholds=(0.76, 0.78, 0.80, 0.81, 0.82, 0.84, 0.86)) -> list[dict]:
    rows = []
    for t in thresholds:
        r = evaluate(provider, store, dataclasses.replace(RagSettings(enabled=True), min_score=t))
        rows.append({"min_score": t, "answerable_with_context": round(1 - r["context"]["false_no_answer"] / r["context"]["answerable"], 3), "no_answer_refused": r["no_answer"]["rate"], "context_precision": r["context"]["context_precision"]})
    return rows
