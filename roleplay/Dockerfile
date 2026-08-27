FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

ENV PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential \
  && uv sync --frozen --no-dev --no-install-project \
  && apt-get purge -y --auto-remove build-essential \
  && rm -rf /var/lib/apt/lists/*
COPY *.py ./

EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["/app/.venv/bin/python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:7860/', timeout=3)"]
CMD ["uv", "run", "python", "bot.py", "--host", "0.0.0.0", "--port", "7860", "-t", "webrtc"]
