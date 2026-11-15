"""Phase 3: document extraction and chunking, run by the separate worker process (`python -m app.ingestion.worker`).

Python never reads MongoDB or the storage directory: it claims jobs from, downloads bytes from, and submits
results to Node's internal listener. See docs/ai/ai-service-contract.md §11.
"""
# p2: token-aware chunk sizing (target ~350 / max ~450 real tokens of the embedding model's tokenizer) so that every
# chunk fits the 512-token embedding window with room for the passage prefix. p1 chunks (chars/4 sizing) stay in place
# until a document's p2 job is indexed, then they are removed (see Node's dropObsoleteChunks).
PIPELINE_VERSION = "p2"
