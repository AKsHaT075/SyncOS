"""TEST TOOLING ONLY. `python -m tests.query_probe <organization> <query>` embeds the query with the configured provider and
searches the vector store (VectorStore.search is an internal API; no route in Phase 4 exposes retrieval). Prints JSON hits
(document ids and scores, never text). Configuration comes from the same environment variables as the embedding worker."""
import json
import os
import sys

from app.embeddings.config import load_embedding_worker_settings
from app.embeddings.factory import get_provider
from app.vectorstore.config import build_store


def main() -> None:
    org, query = sys.argv[1], sys.argv[2]
    documents = sys.argv[3].split(",") if len(sys.argv) > 3 and sys.argv[3] else None
    settings = load_embedding_worker_settings()
    provider = get_provider(settings.embedding, settings.ingestion_pipeline)
    store = build_store(settings.vectorstore)
    hits = store.search(organization=org, space_id=provider.space_id, vector=provider.embed_query(query), limit=5, document_ids=documents)
    print(json.dumps([{"document": h.document, "version": h.version, "chunk": h.chunk_index, "score": round(h.score, 4)} for h in hits]))


if __name__ == "__main__":
    main()
