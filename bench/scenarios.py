"""Read-only fixture loading: published scenarios + persona source material.

The chat bridge grounds sessions via x-trainertwin-agent-slug/persona-slug
headers, but fidelity scoring needs the trainer's analyzed PersonaSource
material, which has no API — so bench reads it read-only from Postgres.
Bench never writes to the database.
"""

from __future__ import annotations

import json
import os
import re

import psycopg

AGENT_SLUGS = [
    value.strip()
    for value in os.getenv("BENCH_AGENT_SLUGS", os.getenv("BENCH_AGENT_SLUG", "fundamentals-depth")).split(",")
    if value.strip()
]
REFERENCE_PERSONA_SLUG = os.getenv("BENCH_REFERENCE_PERSONA_SLUG")
MAX_REFERENCE_SOURCES = int(os.getenv("BENCH_MAX_REFERENCE_SOURCES", "5"))


def _db() -> psycopg.Connection:
    url = os.environ["DATABASE_URL"].replace("postgresql://", "postgres://", 1)
    url = re.sub(r"[?&]schema=[^&]*", "", url).rstrip("?&")
    return psycopg.connect(url)


def _compact_analysis(analysis: object) -> dict:
    if not isinstance(analysis, dict):
        return {}
    keys = (
        "tone_description",
        "habits",
        "avoidances",
        "speaking_patterns",
        "behavioral_patterns",
        "conversation_moments",
        "verbatim_phrases",
    )
    compact = {key: analysis[key] for key in keys if key in analysis}
    if isinstance(compact.get("conversation_moments"), list):
        compact["conversation_moments"] = compact["conversation_moments"][:10]
    return compact


def build_reference_context(sources: list[dict]) -> list[str]:
    return [
        json.dumps(
            {
                "source": source["name"],
                "kind": source["kind"],
                "trainer_behavior": _compact_analysis(source["analysis"]),
            },
            ensure_ascii=False,
        )
        for source in sources
    ]


def load_scenarios() -> list[dict]:
    with _db() as connection, connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT a.id, a."orgId", a.slug, a.name, a.data,
                   p.id, p.slug, p.name, p.data, d.slug, d.version, m."userId",
                   a.version, p.version
            FROM "Agent" a
            JOIN "Persona" p ON p.id = a."personaId"
            JOIN "Domain" d ON d.slug = a."domainSlug" AND d."orgId" = a."orgId"
            JOIN LATERAL (
              SELECT "userId" FROM member WHERE "organizationId" = a."orgId" LIMIT 1
            ) m ON true
            WHERE a.slug = ANY(%s)
            ORDER BY array_position(%s, a.slug)
            """,
            (AGENT_SLUGS, AGENT_SLUGS),
        )
        rows = cursor.fetchall()
        found = {row[2] for row in rows}
        missing = [slug for slug in AGENT_SLUGS if slug not in found]
        if missing:
            raise RuntimeError(f"Published scenario(s) not found: {', '.join(missing)}")

        scenarios = []
        for row in rows:
            reference_persona_id = row[5]
            reference_persona_slug = row[6]
            reference_persona_name = row[7]
            if REFERENCE_PERSONA_SLUG:
                cursor.execute(
                    'SELECT id, slug, name FROM "Persona" WHERE "orgId" = %s AND slug = %s',
                    (row[1], REFERENCE_PERSONA_SLUG),
                )
                reference = cursor.fetchone()
                if not reference:
                    raise RuntimeError(
                        f'Reference persona "{REFERENCE_PERSONA_SLUG}" was not found for scenario "{row[2]}"'
                    )
                reference_persona_id, reference_persona_slug, reference_persona_name = reference

            cursor.execute(
                """
                SELECT name, kind, analysis
                FROM "PersonaSource"
                WHERE "personaId" = %s AND "orgId" = %s
                  AND status IN ('analyzed', 'compiling') AND analysis IS NOT NULL
                ORDER BY "createdAt"
                LIMIT %s
                """,
                (reference_persona_id, row[1], MAX_REFERENCE_SOURCES),
            )
            sources = [
                {"name": name, "kind": kind, "analysis": analysis}
                for name, kind, analysis in cursor.fetchall()
            ]
            if not sources:
                persona_data = row[8] if isinstance(row[8], dict) else {}
                style = persona_data.get("style") if isinstance(persona_data.get("style"), dict) else {}
                print(
                    f'Warning: persona "{reference_persona_slug}" has no analyzed sources; '
                    "using persona YAML as reference."
                )
                sources = [{
                    "name": "persona.yaml",
                    "kind": "persona_spec",
                    "analysis": {
                        "tone_description": style.get("tone"),
                        "habits": style.get("habits"),
                        "avoidances": style.get("avoid"),
                        "verbatim_phrases": persona_data.get("examples") or {},
                    },
                }]
            scenarios.append(
                {
                    "agent_id": row[0],
                    "org_id": row[1],
                    "slug": row[2],
                    "name": row[3],
                    "agent": row[4],
                    "persona_id": row[5],
                    "persona_slug": row[6],
                    "persona_name": row[7],
                    "persona": row[8],
                    "domain_slug": row[9],
                    "domain_version": row[10],
                    "user_id": row[11],
                    "agent_version": row[12],
                    "persona_version": row[13],
                    "reference_persona_slug": reference_persona_slug,
                    "reference_persona_name": reference_persona_name,
                    "sources": sources,
                }
            )
        return scenarios
