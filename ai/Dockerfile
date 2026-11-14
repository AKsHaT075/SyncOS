# NOT yet build-tested: Docker was not available where this was written.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv/ai
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
RUN useradd --system --no-create-home ai && chown -R ai /srv/ai
USER ai
# Inside a container the service must listen on all interfaces; keep the PORT on a private network only.
ENV HOST=0.0.0.0 PORT=8001
EXPOSE 8001
CMD ["sh", "-c", "uvicorn app.main:build --factory --host $HOST --port $PORT --no-access-log"]

# The ingestion worker is a SEPARATE container/process from the API above, from the same image:
#   docker run ... <image> python -m app.ingestion.worker
# Give it AI_WORKER_SIGNING_KEY (or a mounted _FILE), AI_NODE_INTERNAL_URL and NO GROQ_API_KEY. Unbuilt/untested (no Docker here).

# The embedding worker is a THIRD process from the same image:  python -m app.embeddings.worker
# It needs AI_WORKER_SIGNING_KEY, AI_NODE_INTERNAL_URL, QDRANT_URL (https) + QDRANT_API_KEY, AI_ENVIRONMENT=production,
# a pre-populated model cache (AI_EMBEDDING_CACHE_DIR, AI_EMBEDDING_OFFLINE=true) and >= 2 GB RAM. No GROQ_API_KEY.
# Unbuilt/untested (no Docker here); the model weights are NOT baked in and must never be committed.
