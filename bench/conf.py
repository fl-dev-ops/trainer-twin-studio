"""Shared bench configuration: env loading, auth, defaults.

All conversation goes through the chat bridge (chat/ agent) over HTTP —
never by importing web/ or chat/ code. `web/.env` supplies
DATABASE_URL (read-only fixture loading in scenarios.py) and
COPILOT_SERVICE_SECRET (bridge auth).
"""

from pathlib import Path

import base64
import os

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / "web" / ".env")
load_dotenv(Path(__file__).resolve().parent / ".env")  # bench/.env wins for bench-specific values

# Chat bridge base URL. Local eve dev runs on http://localhost:2001 (see chat/README.md).
API_URL = os.getenv("BENCH_API_URL", "http://localhost:2001").rstrip("/")

# "trainertwin-runtime" (or "trainertwin-brain") = "use the brain's default model"
MODEL = os.getenv("BENCH_MODEL", "trainertwin-runtime")

# Bridge credentials — required, no fallbacks. Set BENCH_ORG_ID (or copy
# bench/.env.example) before running anything that talks to the bridge.
ORG_ID = os.getenv("BENCH_ORG_ID", "")
SECRET = os.getenv("COPILOT_SERVICE_SECRET", "")


def require_bridge_env() -> None:
    """Fail fast when bridge credentials are missing."""
    missing = [name for name, value in (("BENCH_ORG_ID", ORG_ID), ("COPILOT_SERVICE_SECRET", SECRET)) if not value]
    if missing:
        raise RuntimeError(
            "Missing env for the chat bridge: " + ", ".join(missing)
            + " (set them in bench/.env or the shell; see bench/.env.example)"
        )

# Default scenario/persona the behaviour + perf scripts run against.
AGENT_SLUG = os.getenv("BENCH_AGENT_SLUG", "impact-quantification")
PERSONA_SLUG = os.getenv("BENCH_PERSONA_SLUG", "Vasanth")

# Local TLS CA for https://trainertwin.localhost style targets.
CA_FILE = os.path.expanduser("~/.portless/ca.pem")

RESULTS_DIR = Path(__file__).resolve().parent / "results"


def auth_headers(
    session_id: str,
    agent_slug: str | None = None,
    persona_slug: str | None = None,
    org_id: str | None = None,
    model: str | None = None,
) -> dict:
    """OpenAI-compat bridge headers (see chat/agent/channels/openai-compat.ts)."""
    require_bridge_env()
    b64 = base64.b64encode(f"{org_id or ORG_ID}:{SECRET}".encode()).decode()
    headers = {
        "Authorization": f"Basic {b64}",
        "x-trainertwin-org-id": org_id or ORG_ID,
        "x-trainertwin-session-id": session_id,
        "x-trainertwin-agent-slug": agent_slug or AGENT_SLUG,
        "x-trainertwin-persona-slug": persona_slug or PERSONA_SLUG,
        "x-trainertwin-mode": "voice",
        "content-type": "application/json",
    }
    if model:
        headers["x-trainertwin-model"] = model
    return headers


def ssl_verify():
    """Verify https targets against the local CA when present."""
    if "https://" in API_URL and Path(CA_FILE).exists():
        import ssl

        context = ssl.create_default_context()
        context.load_verify_locations(CA_FILE)
        return context
    return True
