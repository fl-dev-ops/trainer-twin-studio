"""Acme interview sessions to simulate against (read-only DB access).

A bench run pointed at a real InterviewSession id inherits that session's
full grounding (documents/résumé, learner name, agent/persona/domain
versions) because the bridge forwards x-trainertwin-session-id and the
studio resolves getSessionContext from it.
"""

from __future__ import annotations

import os

import conf
from scenarios import _db

ORG_ID = os.getenv("BENCH_ORG_ID", conf.ORG_ID)


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
