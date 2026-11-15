# Sync OS AI service

Python (FastAPI) service that talks to Groq. It is **internal**: only the Node backend calls it, and it trusts nothing
from the browser. Read [docs/ai/ai-service-contract.md](../docs/ai/ai-service-contract.md) first — it defines who decides what, the
token model, the streaming frames, replay protection and settlement.

Status: generation + streaming + Groq adapter; **document ingestion** (`app/ingestion`); and **embeddings + vector store** (`app/embeddings`,
`app/vectorstore`) are built, the latter two as their own worker processes. RAG retrieval and tools are **reserved empty packages**
(`app/rag`, `app/tools`).

## Run locally
```bash
cd ai
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
node ../backend/scripts/generate-ai-keys.js     # writes keys/ (gitignored) and prints the Node env lines
cp .env.example .env                            # fill GROQ_API_KEY; AI_JWT_PUBLIC_KEY_FILE=./keys/ai-jwt-public.pem
set -a; . ./.env; set +a
.venv/bin/uvicorn app.main:build --factory --host 127.0.0.1 --port 8001 --no-access-log
```
Needs Redis (replay protection) unless you opt into `AI_REPLAY_STORE=memory` + `AI_SINGLE_INSTANCE=true`
(exactly one process, documented in the contract).

## Ingestion worker
```bash
# keys: node ../backend/scripts/generate-ai-keys.js   (creates the service pair AND the worker pair)
AI_WORKER_SIGNING_KEY_FILE=./keys/ai-worker-private.pem AI_NODE_INTERNAL_URL=http://127.0.0.1:5002 \
  .venv/bin/python -m app.ingestion.worker          # add --once to drain the queue and exit
```
It needs no Groq key and no database access; Node must have `AI_WORKER_PUBLIC_KEY_FILE` set. See `../docs/ai/ai-service-contract.md` §11.

## Embeddings and Qdrant

Three Python processes, all optional to run independently: the API (Groq), the ingestion worker, and the **embedding worker**
(`python -m app.embeddings.worker`). The embedding worker needs the worker key and a Qdrant, and **no Groq key**.

**Local development (no Docker, no server).** Embedded Qdrant is the default: with no `QDRANT_URL` the worker stores vectors in
`QDRANT_PATH` (default `.qdrant-data`, gitignored). It is **single-process only** (a second process on the same path is refused), which is
fine for one dev worker. The first run downloads the model (~470 MB, pinned revision) into the Hugging Face cache; afterwards set
`AI_EMBEDDING_OFFLINE=true` if you like.
```bash
cd ai && .venv/bin/python -m app.embeddings.worker        # add --once to drain the queue and exit
```
**A real Qdrant server locally** (needed to test several workers at once): `python scripts/install_qdrant.py` downloads the release binary into
`ai/.qdrant/` after verifying its SHA-256 against GitHub's published digest, then e.g.
```bash
cd ai/.qdrant && QDRANT__SERVICE__API_KEY=dev-key QDRANT__STORAGE__STORAGE_PATH=../.qdrant-data/server ./qdrant     # 127.0.0.1:6333
QDRANT_URL=http://127.0.0.1:6333 QDRANT_API_KEY=dev-key .venv/bin/python -m app.embeddings.worker
```
**Production.** Run Qdrant as a **private** service (no public route; reachable only from the embedding workers) with `QDRANT__SERVICE__API_KEY`
and TLS enabled (`QDRANT__SERVICE__ENABLE_TLS=true` + cert/key), persistent storage and regular snapshots. Set `AI_ENVIRONMENT=production`,
`QDRANT_URL=https://…`, `QDRANT_API_KEY`: the worker refuses to start otherwise. Mongo remains the source of truth - the index can be
rebuilt - so Qdrant snapshots are a convenience, not the only copy. Pre-populate the model cache (or bake it into the image) and run
with `AI_EMBEDDING_OFFLINE=true`. Budget **≥2 GB RAM per embedding worker**.

**Changing the model** is a migration, not an edit: see `../docs/ai/ai-overview.md`. `python scripts/benchmark_embeddings.py` measures
load time, memory, latency and the multilingual smoke test on your hardware.

## Test
```bash
.venv/bin/python -m pytest -q
```
No test uses a real Groq key. Groq is replaced by `httpx.MockTransport`. Embedding/vector tests use the REAL cached model and, when
`ai/.qdrant/qdrant` exists, a REAL Qdrant server; each skips (visibly) if its prerequisite is absent.

## Layout
`app/main.py` app factory · `api/` routes · `core/` config, ES256 verification, replay guard, errors ·
`providers/groq.py` the adapter · `orchestration/generate.py` events → wire frames · `schemas/` strict request model ·
`prompts/` reserved · `contracts/` the Node⇄Python contract and shared fixtures.

## Not verified
Real Groq behaviour (no key was available), the Dockerfile (Docker not installed where it was written).

## Live tools, configuration and operations
Setup, every environment variable (Node and Python), permissions, the emergency kill switch, the rollout/rollback checklist and the honest verification status are in [`../docs/ai/ai-operations.md`](../docs/ai/ai-operations.md). Live tools are OFF by default (`AI_LIVE_TOOLS_ENABLED=false` on the Node side). While a model call is in flight the service sends `: keepalive` SSE comments (`AI_TOOL_KEEPALIVE_MS`).

