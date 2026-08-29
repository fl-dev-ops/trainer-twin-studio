"""Bridge between the TrainerTwin studio (Postgres) and the single-prompt LLM runtime.

Fetches dynamic config (persona style, agent stages/rubrics, candidate resume/context)
from the web app's /api/agent-config endpoint and manages a single-prompt conversation loop.
"""

import asyncio
import json
import os
import sqlite3
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

import httpx
from dotenv import load_dotenv
from loguru import logger

AGENT_ROOT = Path(__file__).parent.resolve()
load_dotenv(AGENT_ROOT / ".env")

WEB_URL = os.getenv("WEB_URL", "http://localhost:3000").rstrip("/")
DB_PATH = AGENT_ROOT / ".local" / "trainertwin.db"


def ensure_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as con:
        cur = con.cursor()
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY, user_id TEXT NOT NULL, persona_id TEXT NOT NULL,
                persona_version INTEGER NOT NULL, agent_id TEXT NOT NULL, agent_version INTEGER NOT NULL,
                domain_id TEXT NOT NULL, status TEXT NOT NULL, state_json TEXT NOT NULL,
                created_at TEXT NOT NULL, completed_at TEXT
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS turns (
                id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
                turn_index INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL
            )
        """)
        con.commit()


def deep_merge(base: dict, override: dict) -> dict:
    result = deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = deepcopy(value)
    return result


def fetch_config(persona_id: str, agent_id: str, context_id: str | None = None) -> dict:
    params = {"persona": persona_id, "agent": agent_id}
    if context_id:
        params["context"] = context_id
    response = httpx.get(f"{WEB_URL}/api/agent-config", params=params, timeout=30)
    response.raise_for_status()
    return response.json()


class ApiKnowledge:
    """Async hybrid knowledge search across studio knowledge bases."""

    def __init__(self, web_url: str):
        self.web_url = web_url.rstrip("/")

    async def query(self, knowledge_bases: list[str], query: str, limit: int = 2) -> list[dict]:
        if not knowledge_bases or not query.strip():
            return []

        async def search_kb(client: httpx.AsyncClient, kb: str):
            try:
                res = await client.get(
                    f"{self.web_url}/api/knowledge/{kb}/search",
                    params={"q": query, "k": limit},
                    timeout=5.0,
                )
                if res.status_code == 200:
                    return res.json().get("hits", [])
            except Exception as e:
                logger.warning("Knowledge search failed for {}: {}", kb, e)
            return []

        async with httpx.AsyncClient(timeout=6.0) as client:
            tasks = [search_kb(client, kb) for kb in knowledge_bases]
            results = await asyncio.gather(*tasks)

        all_hits = [hit for kb_hits in results for hit in kb_hits]
        ranked = sorted(all_hits, key=lambda x: float(x.get("score", 0)), reverse=True)[:limit]
        return ranked


def extract_context_text(context_info: dict | None) -> str:
    if not context_info or not context_info.get("content"):
        return ""
    content = context_info["content"]
    as_path = Path(content)
    if content.startswith("/") and as_path.is_file():
        if as_path.suffix.lower() == ".pdf":
            try:
                import fitz
                doc = fitz.open(as_path)
                return "\n\n".join([page.get_text().strip() for page in doc if page.get_text().strip()])
            except Exception:
                return ""
        return as_path.read_text(encoding="utf-8", errors="ignore")
    return str(content)


def build_system_prompt(config: dict, context_text: str = "") -> str:
    persona_data = config.get("persona", {}).get("data", {})
    agent_data = config.get("agent", {}).get("data", {})
    domain_data = config.get("domain", {}).get("data", {})
    persona_name = persona_data.get("name", "the Interviewer")

    style = persona_data.get("style", {})
    decision_prefs = persona_data.get("decision_preferences", {})

    stages = agent_data.get("stages", [])
    stages_text = ""
    for i, s in enumerate(stages, 1):
        ev_defs = s.get("config", {}).get("evidence", {}).get("definitions", {})
        ev_lines = "\n".join([f"    - {k}: {v}" for k, v in ev_defs.items()])
        stages_text += f"\n- Stage {i}: {s.get('name')}\n  Objective: {s.get('objective')}"
        if ev_lines:
            stages_text += f"\n  Evidence Rubric:\n{ev_lines}"

    resume_section = (
        f"## Candidate Context / Resume\n{context_text}\n"
        if context_text.strip()
        else "## Candidate Context / Resume\n(No resume supplied. Assess based purely on dialogue.)\n"
    )

    return f"""# Role & Identity
You are {persona_name}, an expert technical interviewer conducting a live voice technical interview for TrainerTwin.

## Personality & Voice Style
- Demeanor & Tone: {style.get('tone', 'direct, analytical, encouraging')}
- Pacing: {style.get('pacing', 'moderate')}
- Behavioral Preferences: {json.dumps(decision_prefs)}

## Conversational Voice Rules
1. **Spoken Brevity**: You are speaking over live voice. Keep each response concise (1 to 2 sentences maximum).
2. **Single Ask**: Ask exactly ONE clear, focused question or follow-up at a time. Never bundle multiple questions.
3. **No Fluff/Filler**: Do NOT use generic evaluative filler praise like "That's solid", "Great job", "That makes total sense", or "Understood". Dive directly into the technical probe or acknowledgment.
4. **Active Technical Probing**: Listen to the candidate's answers, challenge vague statements, and probe for internal mechanisms, execution flows, trade-offs, and concrete examples.
5. **Phase Progression**: Move naturally through the interview stages as the candidate provides adequate explanations.

## Interview Domain & Objective
- Domain: {domain_data.get('name', 'Software Engineering')}
- Overall Objective: {agent_data.get('objective', 'Assess technical depth and problem-solving skills.')}

## Interview Stages & Rubrics
{stages_text}

{resume_section}
## Immediate Goal
Conduct the interview in persona. Probe technical depth and verify conceptual mastery step-by-step."""


KNOWLEDGE_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "query_knowledge",
            "description": (
                "Search technical reference documents and domain knowledge bases to verify candidate statements, "
                "look up architectural details, or check exact technical facts when needed."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Specific technical topic or search phrase.",
                    }
                },
                "required": ["query"],
            },
        },
    }
]


class InterviewSession:
    """Live voice interview session powered by a single dynamic system prompt."""

    def __init__(self):
        ensure_db()
        self.session_id: str | None = None
        self.state: dict = {"phase_index": 0, "learner_turns": 0, "coverage": {}}
        self.closed = False
        self.voice_id = ""
        self.messages: list[dict] = []
        self._persona_id: str = ""
        self._agent_id: str = ""
        self._domain_id: str = ""
        self._versions: dict = {}
        self._stages: list[dict] = []
        self._knowledge_bases: list[str] = []
        self._knowledge = ApiKnowledge(WEB_URL)
        self._started = False

    @property
    def started(self) -> bool:
        return self._started

    @property
    def _domain(self):
        class DummyDomain:
            id = self._domain_id
        return DummyDomain()

    async def start(self, persona_id: str, agent_id: str, context_id: str | None = None) -> str:
        """Fetch config, build the unified system prompt, and return the opening statement."""
        config = await asyncio.to_thread(fetch_config, persona_id, agent_id, context_id)
        self._versions = {
            "persona": config.get("persona", {}).get("version", 1),
            "agent": config.get("agent", {}).get("version", 1),
            "domain": config.get("domain", {}).get("version", 1),
        }
        self._persona_id = persona_id
        self._agent_id = agent_id
        self._domain_id = config.get("domain", {}).get("data", {}).get("id", "")
        self._stages = config.get("agent", {}).get("data", {}).get("stages", [])
        self._knowledge_bases = list(config.get("knowledgeBases", []))

        voice_id = config.get("agent", {}).get("data", {}).get("voiceId")
        if isinstance(voice_id, str) and voice_id:
            self.voice_id = voice_id

        context_info = config.get("context")
        context_text = extract_context_text(context_info)

        system_prompt = build_system_prompt(config, context_text)
        opening = config.get("agent", {}).get("data", {}).get("opening") or "Welcome to your interview. Let's get started."

        self.session_id = uuid.uuid4().hex
        self.state = {"phase_index": 0, "learner_turns": 0, "coverage": {}}
        self.messages = [
            {"role": "system", "content": system_prompt},
            {"role": "assistant", "content": opening},
        ]
        self._started = True

        # Persist session to local SQLite DB
        now = datetime.now(timezone.utc).isoformat()
        with sqlite3.connect(DB_PATH) as con:
            cur = con.cursor()
            cur.execute("""
                INSERT INTO sessions (id, user_id, persona_id, persona_version, agent_id, agent_version, domain_id, status, state_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                self.session_id, "studio-user", self._persona_id, self._versions.get("persona", 1),
                self._agent_id, self._versions.get("agent", 1), self._domain_id, "active",
                json.dumps(self.state), now,
            ))
            cur.execute("""
                INSERT INTO turns (session_id, turn_index, role, text, created_at)
                VALUES (?, ?, ?, ?, ?)
            """, (self.session_id, 0, "trainer", opening, now))
            con.commit()

        logger.info("Interview session {} started with single system prompt ({}/{})", self.session_id, persona_id, agent_id)
        return opening

    async def step(self, learner_text: str) -> str:
        """Run one learner turn against the LLM chat completion endpoint."""
        if not self._started or self.closed:
            raise RuntimeError("Session not started or already closed")

        self.state["learner_turns"] += 1
        turn_index = len(self.messages)
        now = datetime.now(timezone.utc).isoformat()

        self.messages.append({"role": "user", "content": learner_text})

        # Save learner turn in SQLite
        with sqlite3.connect(DB_PATH) as con:
            con.cursor().execute("""
                INSERT INTO turns (session_id, turn_index, role, text, created_at)
                VALUES (?, ?, ?, ?, ?)
            """, (self.session_id, turn_index, "learner", learner_text, now))
            con.commit()

        base_url = os.getenv("LLM_BASE_URL", "https://openrouter.ai/api/v1").rstrip("/")
        api_key = os.getenv("LLM_API_KEY") or os.getenv("OPENROUTER_API_KEY")
        model = os.getenv("LLM_MODEL", "google/gemini-2.5-flash:nitro")

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": model,
            "messages": self.messages,
            "max_tokens": 150,
            "temperature": 0.7,
        }
        if self._knowledge_bases:
            payload["tools"] = KNOWLEDGE_TOOLS
            payload["tool_choice"] = "auto"

        async with httpx.AsyncClient(timeout=30) as client:
            res = await client.post(f"{base_url}/chat/completions", headers=headers, json=payload)
            res.raise_for_status()
            data = res.json()
            choice = data.get("choices", [{}])[0]
            message = choice.get("message", {})

            tool_calls = message.get("tool_calls")
            if tool_calls and self._knowledge_bases:
                self.messages.append(message)
                for tool_call in tool_calls:
                    call_id = tool_call.get("id")
                    func = tool_call.get("function", {})
                    if func.get("name") == "query_knowledge":
                        try:
                            args = json.loads(func.get("arguments", "{}"))
                        except Exception:
                            args = {}
                        query_str = args.get("query", learner_text)
                        hits = await self._knowledge.query(self._knowledge_bases, query_str, limit=3)
                        content_str = json.dumps({"hits": hits})
                        self.messages.append({
                            "role": "tool",
                            "tool_call_id": call_id,
                            "content": content_str,
                        })

                # Follow-up generation after tool response
                follow_payload = {
                    "model": model,
                    "messages": self.messages,
                    "max_tokens": 150,
                    "temperature": 0.7,
                }
                res2 = await client.post(f"{base_url}/chat/completions", headers=headers, json=follow_payload)
                res2.raise_for_status()
                reply = res2.json().get("choices", [{}])[0].get("message", {}).get("content", "").strip()
            else:
                reply = message.get("content", "").strip()

        if not reply:
            reply = "Could you elaborate on that further?"

        self.messages.append({"role": "assistant", "content": reply})

        # Save assistant turn in SQLite
        reply_now = datetime.now(timezone.utc).isoformat()
        with sqlite3.connect(DB_PATH) as con:
            con.cursor().execute("""
                INSERT INTO turns (session_id, turn_index, role, text, created_at)
                VALUES (?, ?, ?, ?, ?)
            """, (self.session_id, turn_index + 1, "trainer", reply, reply_now))
            con.commit()

        return reply

    def snapshot(self) -> dict:
        phase_index = self.state.get("phase_index", 0)
        phase_name = ""
        if self._stages and phase_index < len(self._stages):
            phase_name = self._stages[phase_index].get("name", "")
        return {
            "coverage": self.state.get("coverage", {}),
            "phase_index": phase_index,
            "phase_name": phase_name,
            "learner_turns": self.state.get("learner_turns", 0),
            "session_id": self.session_id,
            "versions": self._versions,
        }

    def surface_for_phase(self, index: int) -> dict | None:
        """Workspace surface the client should show for a phase, from its spec config."""
        if not self._stages or index >= len(self._stages):
            return None
        phase = self._stages[index]
        tools = phase.get("tools") or []
        for tool in tools:
            if tool == "coding_sandbox" or (isinstance(tool, dict) and tool.get("id") == "coding_sandbox"):
                language = tool.get("language", "python") if isinstance(tool, dict) else "python"
                return {"action": "open_code_editor", "payload": {"language": language}}
        scenario = phase.get("scenario") or {}
        if scenario.get("surface") == "whiteboard":
            return {"action": "open_whiteboard", "payload": {}}
        if isinstance(scenario.get("pdf_url"), str) and scenario["pdf_url"]:
            return {"action": "open_pdf", "payload": {"sourceUrl": scenario["pdf_url"]}}
        if isinstance(scenario.get("presentation_url"), str) and scenario["presentation_url"]:
            return {"action": "open_presentation", "payload": {"sourceUrl": scenario["presentation_url"]}}
        return None

    async def finish(self):
        if self.closed or not self.session_id:
            return
        self.closed = True
        now = datetime.now(timezone.utc).isoformat()
        with sqlite3.connect(DB_PATH) as con:
            con.cursor().execute("""
                UPDATE sessions SET status = 'completed', completed_at = ? WHERE id = ?
            """, (now, self.session_id))
            con.commit()
        logger.info("Interview session {} completed", self.session_id)

    async def abandon(self, reason: str):
        if not self.session_id or self.closed:
            return
        self.closed = True
        now = datetime.now(timezone.utc).isoformat()
        with sqlite3.connect(DB_PATH) as con:
            con.cursor().execute("""
                UPDATE sessions SET status = 'abandoned', completed_at = ? WHERE id = ?
            """, (now, self.session_id))
            con.commit()
        logger.info("Interview session {} abandoned: {}", self.session_id, reason)

