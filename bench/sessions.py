"""Prepare or resolve document-grounded sessions for simulations."""

from __future__ import annotations

import mimetypes
import os
from pathlib import Path

import httpx

import conf
from scenarios import _db

ORG_ID = os.getenv("BENCH_ORG_ID", conf.ORG_ID)


def prepare_file_session(path: Path, agent_slug: str, web_url: str) -> dict:
    """Upload a document and activate a session through the same services as /talk."""
    if not path.is_file():
        raise RuntimeError(f'Document not found: "{path}"')
    conf.require_bridge_env()
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    with path.open("rb") as file:
        response = httpx.post(
            f'{web_url.rstrip("/")}/api/internal/bench/session',
            headers={
                "authorization": f"Bearer {conf.SECRET}",
                "x-trainertwin-org-id": ORG_ID,
            },
            data={"agentSlug": agent_slug},
            files={"file": (path.name, file, mime)},
            timeout=180,
        )
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    if response.is_error:
        raise RuntimeError(payload.get("error", f"Session preparation failed ({response.status_code})"))
    session = payload["session"]
    document = payload["document"]
    return {
        "session_id": session["id"],
        "agent_slug": session["agentSlug"],
        "persona_slug": session["personaSlug"],
        "domain_slug": session["domainSlug"],
        "status": session["status"],
        "learner_name": session["learnerName"],
        "document_id": document["id"],
        "document_name": document["name"],
        "document_text": document["text"],
    }


def load_acme_sessions(limit: int = 12) -> list[dict]:
    """Recent InterviewSession rows for the acme org, newest first."""
    with _db() as connection, connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT s.id, s."agentSlug", s."personaSlug", s."domainSlug", s.status, s."createdAt"
            FROM "InterviewSession" s
            WHERE s."orgId" = %s
            ORDER BY s."createdAt" DESC
            LIMIT %s
            """,
            (ORG_ID, limit),
        )
        return [
            {
                "session_id": row[0],
                "agent_slug": row[1],
                "persona_slug": row[2],
                "domain_slug": row[3],
                "status": row[4],
                "created_at": row[5].isoformat(),
            }
            for row in cursor.fetchall()
        ]


def resolve_session(session_id: str) -> dict:
    for session in load_acme_sessions(limit=50):
        if session["session_id"] == session_id:
            return session
    raise RuntimeError(
        f'Session "{session_id}" was not found in org "{ORG_ID}"; '
        "use --list-sessions to see available ids"
    )
