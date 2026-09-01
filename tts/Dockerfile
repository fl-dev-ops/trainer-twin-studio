# TrainerTwin TTS proxy — resolves voice IDs and forwards to vLLM-Omni.
# The GPU model itself runs in the vllm/vllm-omni container (see docker-compose.yml).

FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /srv/tts
COPY pyproject.toml ./
RUN uv sync --no-install-project --frozen || uv sync --no-install-project

COPY app ./app
RUN uv sync --frozen || uv sync

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD curl -fsS http://localhost:8000/healthz || exit 1
CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
