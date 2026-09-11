"""Simulate published TrainerTwin scenarios and score them against trainer source data.

  cd bench && uv sync && uv run python simulate.py
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import ssl
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import httpx
import psycopg
from deepeval import evaluate
from deepeval.dataset import ConversationalGolden, Persona
from deepeval.models import DeepEvalBaseLLM
from deepeval.simulator import ConversationSimulator
from deepeval.simulator.controller import end, proceed
from deepeval.test_case import Turn
from dotenv import load_dotenv

from checks import conversation_likeness, conversation_quality_issues
from learner_persona import all_learners, build_synthetic_golden
from metrics import conversation_metrics

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / "web" / ".env")

API_URL = os.getenv("BENCH_API_URL", "https://trainertwin.localhost").rstrip("/")
AGENT_SLUGS = [
    value.strip()
    for value in os.getenv("BENCH_AGENT_SLUGS", os.getenv("BENCH_AGENT_SLUG", "fundamentals-depth")).split(",")
    if value.strip()
]
REFERENCE_PERSONA_SLUG = os.getenv("BENCH_REFERENCE_PERSONA_SLUG")
MAX_TURNS = int(os.getenv("BENCH_MAX_TURNS", "12"))
MAX_REFERENCE_SOURCES = int(os.getenv("BENCH_MAX_REFERENCE_SOURCES", "5"))
FIDELITY_THRESHOLD = float(os.getenv("BENCH_FIDELITY_THRESHOLD", "0.7"))
KEEP_SESSIONS = os.getenv("BENCH_KEEP_SESSIONS", "").lower() in {"1", "true", "yes"}
CA_FILE = os.path.expanduser("~/.portless/ca.pem")


def report_path() -> Path:
    if os.getenv("BENCH_REPORT"):
        return Path(os.environ["BENCH_REPORT"])
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    return ROOT / "bench" / "results" / f"{stamp}.json"


def _ssl() -> ssl.SSLContext | bool:
    if Path(CA_FILE).exists():
        context = ssl.create_default_context()
        context.load_verify_locations(CA_FILE)
        return context
    return True


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
                   p.id, p.slug, p.name, p.data, d.slug, d.version, m."userId"
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
                    "reference_persona_slug": reference_persona_slug,
                    "reference_persona_name": reference_persona_name,
                    "sources": sources,
                }
            )
        return scenarios


def build_golden(scenario: dict, learner: dict | None = None) -> ConversationalGolden:
    return build_synthetic_golden(scenario, learner)


def create_session(scenario: dict) -> dict:
    token = f"bench-{secrets.token_urlsafe(24)}"
    session_id = str(uuid4())
    with _db() as connection, connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO "InterviewSession" (
              id, "orgId", "userId", "agentId", "shareCode", "runtimeTokenHash",
              "personaSlug", "personaVersion", "agentSlug", "agentVersion",
              "domainSlug", "domainVersion", status
            )
            SELECT %s,%s,%s,a.id,%s,%s,p.slug,p.version,a.slug,a.version,d.slug,d.version,'active'
            FROM "Agent" a
            JOIN "Persona" p ON p.id = a."personaId"
            JOIN "Domain" d ON d.slug = a."domainSlug" AND d."orgId" = a."orgId"
            WHERE a.id = %s
            """,
            (
                session_id,
                scenario["org_id"],
                scenario["user_id"],
                secrets.token_urlsafe(9),
                hashlib.sha256(token.encode()).hexdigest(),
                scenario["agent_id"],
            ),
        )
        if cursor.rowcount != 1:
            raise RuntimeError(f'Could not create benchmark session for "{scenario["slug"]}"')
    return {"sessionId": session_id, "token": token}


def close_session(session_id: str) -> None:
    with _db() as connection, connection.cursor() as cursor:
        if KEEP_SESSIONS:
            cursor.execute(
                """
                UPDATE "InterviewSession"
                SET status = CASE WHEN status = 'active' THEN 'abandoned' ELSE status END,
                    "endedAt" = CASE WHEN status = 'active' THEN now() ELSE "endedAt" END,
                    "runtimeTokenHash" = NULL
                WHERE id = %s
                """,
                (session_id,),
            )
        else:
            cursor.execute('DELETE FROM "InterviewSession" WHERE id = %s', (session_id,))


class OpenRouterLLM(DeepEvalBaseLLM):
    def __init__(self, model: str | None = None):
        self.model = (
            model
            or os.getenv("BENCH_EVALUATION_MODEL")
            or os.getenv("BENCH_SIMULATOR_MODEL")
            or os.getenv("INTERVIEW_LLM_MODEL")
            or "openai/gpt-4.1-mini"
        )
        self.base = (os.getenv("OPENROUTER_BASE_URL") or "https://openrouter.ai/api/v1").rstrip("/")
        self.key = os.getenv("OPENROUTER_API_KEY") or os.getenv("LLM_API_KEY")
        if not self.key:
            raise RuntimeError("OPENROUTER_API_KEY is required")

    def load_model(self):
        return self.model

    def get_model_name(self):
        return self.model

    def generate(self, prompt: str, schema=None):
        with httpx.Client(timeout=120) as client:
            response = client.post(
                f"{self.base}/chat/completions",
                headers={"authorization": f"Bearer {self.key}", "content-type": "application/json"},
                json={
                    "model": self.model,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0,
                    **({"response_format": {"type": "json_object"}} if schema is not None else {}),
                },
            )
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
        return schema.model_validate_json(content) if schema is not None else content

    async def a_generate(self, prompt: str, schema=None):
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(
                f"{self.base}/chat/completions",
                headers={"authorization": f"Bearer {self.key}", "content-type": "application/json"},
                json={
                    "model": self.model,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0,
                    **({"response_format": {"type": "json_object"}} if schema is not None else {}),
                },
            )
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
        return schema.model_validate_json(content) if schema is not None else content


class Runtime:
    def __init__(self, scenario: dict):
        self.scenario = scenario
        self.client = httpx.Client(verify=_ssl(), timeout=120)
        self.session: dict | None = None

    def complete(self, messages: list[dict]) -> str:
        assert self.session
        response = self.client.post(
            f"{API_URL}/api/v1/chat/completions",
            headers={
                "authorization": f"Bearer {self.session['token']}",
                "content-type": "application/json",
            },
            json={"model": "trainertwin-runtime", "messages": messages, "stream": False},
        )
        response.raise_for_status()
        text = response.json()["choices"][0]["message"]["content"]
        if not isinstance(text, str):
            raise RuntimeError(f"Unexpected completion: {response.text[:300]}")
        return text

    def open(self) -> str:
        self.session = create_session(self.scenario)
        return self.complete([{"role": "developer", "content": "session-start"}])

    def close(self) -> None:
        if self.session:
            close_session(self.session["sessionId"])
        self.client.close()


def stopping_controller(last_assistant_turn: Turn | None):
    text = (last_assistant_turn.content if last_assistant_turn else "").lower()
    if re.search(r"we.?ll stop here|conclude here|session ended", text):
        return end(reason="trainer closed the interview")
    return proceed()


def simulate_one(scenario: dict, llm: OpenRouterLLM, learner: dict | None = None):
    runtime = Runtime(scenario)
    try:
        opening = runtime.open()
        session_id = runtime.session["sessionId"]
        golden = build_golden(scenario, learner)
        label = golden.name
        print(f"\n[{label}] session {session_id}\nTRAINER: {opening}\n")
        golden.turns = [Turn(role="assistant", content=opening)]

        def model_callback(input: str, turns: list[Turn]) -> Turn:
            messages = [{"role": "developer", "content": "session-start"}]
            messages.extend(
                {"role": "assistant" if turn.role == "assistant" else "user", "content": turn.content}
                for turn in turns
            )
            if not turns or turns[-1].role != "user" or turns[-1].content != input:
                messages.append({"role": "user", "content": input})
            text = runtime.complete(messages)
            print(f"LEARNER: {input}\nTRAINER: {text}\n")
            return Turn(role="assistant", content=text)

        case = ConversationSimulator(
            model_callback=model_callback,
            simulator_model=llm,
            async_mode=False,
            stopping_controller=stopping_controller,
        ).simulate(conversational_goldens=[golden], max_user_simulations=MAX_TURNS)[0]
        reference_context = build_reference_context(scenario["sources"])
        for turn in case.turns:
            if turn.role == "assistant":
                turn.retrieval_context = reference_context
        case.name = label
        case.chatbot_role = f'{scenario["persona_name"]}, the trainer running {scenario["name"]}'
        turns = [{"role": turn.role, "content": turn.content} for turn in case.turns]
        likeness = conversation_likeness(turns)
        issues = conversation_quality_issues(turns)
        print(f"likeness {likeness}")
        if issues:
            print(f"quality issues {issues}")
        case.metadata = {
            "session_id": session_id,
            "scenario": scenario["slug"],
            "learner": golden.additional_metadata.get("learner") if golden.additional_metadata else None,
            "learner_source": golden.additional_metadata.get("learner_source") if golden.additional_metadata else None,
            "reference_persona": scenario["reference_persona_slug"],
            "reference_sources": [source["name"] for source in scenario["sources"]],
            "likeness": likeness,
            "quality_issues": issues,
        }
        return case
    finally:
        runtime.close()


def save_report(result, cases: list, llm: OpenRouterLLM, path: Path) -> None:
    report = result.model_dump(mode="json", by_alias=True)
    report["benchmark"] = {
        "created_at": datetime.now(UTC).isoformat(),
        "api_url": API_URL,
        "evaluation_model": llm.get_model_name(),
        "fidelity_threshold": FIDELITY_THRESHOLD,
        "max_turns": MAX_TURNS,
        "sessions_kept": KEEP_SESSIONS,
        "conversations": [
            {
                "name": case.name,
                "metadata": case.metadata,
                "turns": [{"role": turn.role, "content": turn.content} for turn in case.turns],
            }
            for case in cases
        ],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")


def main() -> None:
    scenarios = load_scenarios()
    llm = OpenRouterLLM()
    learners = all_learners()
    cases = [
        simulate_one(scenario, llm, learner)
        for scenario in scenarios
        for learner in learners
    ]
    result = evaluate(
        test_cases=cases,
        metrics=conversation_metrics(llm, FIDELITY_THRESHOLD),
        identifier="trainer-fidelity",
    )
    path = report_path()
    save_report(result, cases, llm, path)
    print(f"\nReport: {path}")


if __name__ == "__main__":
    main()
