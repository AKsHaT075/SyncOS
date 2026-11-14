"""Prints the RAG retrieval evaluation (real model, real vector store, real retrieval logic) and a threshold sweep.
    python scripts/evaluate_retrieval.py [--offline]          (needs the cached multilingual-e5-small; see benchmark_embeddings.py)
Output contains metrics only - no document text."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.embeddings.factory import get_provider  # noqa: E402
from app.embeddings.fastembed_provider import EmbeddingConfig  # noqa: E402
from app.vectorstore.config import VectorStoreConfig  # noqa: E402
from app.vectorstore.qdrant_store import QdrantStore  # noqa: E402
from tests.rag_eval import evaluate, sweep  # noqa: E402

provider = get_provider(EmbeddingConfig(offline="--offline" in sys.argv))
store = QdrantStore(VectorStoreConfig(collection_prefix="eval"))
print(json.dumps(evaluate(provider, store), indent=1))
print("\nthreshold sweep (answerable questions that still get context / no-answer questions correctly refused):")
for row in sweep(provider, QdrantStore(VectorStoreConfig(collection_prefix="sweep"))):
    print("  ", row)
