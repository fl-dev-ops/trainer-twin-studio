"""Studio-backed voice sessions using the existing spec-driven controller.

The web app still owns Persona/Agent/Domain authoring. This bridge compiles its
nested config into runner's types; code selects actions, the model analyzes and
speaks, and one SQLite transaction commits each completed turn.
"""

import asyncio
import json
import os
import re
import sqlite3
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

import httpx
from dotenv import load_dotenv
from loguru import logger

from runner import (
    AgentSpec, AnswerAnalysis, ContextMap, DomainSpec, PersonaSpec, PhaseSpec,
    Runtime, active_claim_handling, active_evidence, active_phase, closing_action,
    make_model, select_action, validate_action,
)

AGENT_ROOT = Path(__file__).parent.resolve()
load_dotenv(AGENT_ROOT / ".env")
WEB_URL = os.getenv("WEB_URL", "http://localhost:3000").rstrip("/")
DB_PATH = AGENT_ROOT / ".local" / "trainertwin.db"


def ensure_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as con:
        con.executescript("""
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY, user_id TEXT NOT NULL, persona_id TEXT NOT NULL,
                persona_version INTEGER NOT NULL, agent_id TEXT NOT NULL, agent_version INTEGER NOT NULL,
                domain_id TEXT NOT NULL, status TEXT NOT NULL, state_json TEXT NOT NULL,
                created_at TEXT NOT NULL, completed_at TEXT
            );
            CREATE TABLE IF NOT EXISTS turns (
                id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
                turn_index INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS decisions (
                id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source_turn_index INTEGER,
                analysis_json TEXT, action_json TEXT NOT NULL, knowledge_json TEXT NOT NULL,
                rendered_text TEXT NOT NULL, created_at TEXT NOT NULL
            );
        """)


def deep_merge(base: dict, override: dict) -> dict:
    result = deepcopy(base)
    for key, value in override.items():
        result[key] = deep_merge(result[key], value) if isinstance(value, dict) and isinstance(result.get(key), dict) else deepcopy(value)
    return result


def fetch_config(persona_id: str, agent_id: str, context_id: str | None = None) -> dict:
    params = {"persona": persona_id, "agent": agent_id}
    if context_id:
        params["context"] = context_id
    response = httpx.get(f"{WEB_URL}/api/agent-config", params=params, timeout=30)
    response.raise_for_status()
    return response.json()


def build_specs(config: dict):
    """Compile the existing Studio schema, without a second publication format.

    Evidence keys are namespaced by stage internally so two stages can assess a
    'reasoning' criterion without sharing its grade. The renderer uses labels.
    """
    persona_data = deepcopy(config["persona"]["data"])
    persona_data["version"] = config["persona"]["version"]
    persona = PersonaSpec.model_validate(persona_data)
    data = config["agent"]["data"]
    defaults = data["config"]
    domain_data = deepcopy(config["domain"]["data"])
    domain_data["version"] = config["domain"]["version"]
    kbs = config.get("knowledgeBases", [])
    if not isinstance(kbs, list) or not all(isinstance(k, str) and k for k in kbs):
        raise ValueError("knowledgeBases must be a list of indexed collection names")
    domain_data["knowledge_bases"] = kbs
    domain = DomainSpec.model_validate(domain_data)
    if data["domain"] != domain.id:
        raise ValueError("Agent's domain does not match supplied Domain")
    phases, definitions, seen = [], {}, set()
    for stage in data["stages"]:
        sid = stage["id"]
        if not sid or sid in seen:
            raise ValueError(f"Duplicate/empty stage id: {sid}")
        seen.add(sid)
        sc = stage["config"]
        merged = deep_merge(defaults, sc)
        evidence = sc["evidence"]
        keys, completion = evidence["keys"], evidence["completion_keys"]
        if not keys or not completion or len(keys) != len(set(keys)):
            raise ValueError(f"Stage {sid} requires unique evidence keys and completion keys")
        if not set(completion) <= set(keys) or not set(keys) <= set(evidence["definitions"]):
            raise ValueError(f"Stage {sid} references undefined evidence")
        qualified = lambda key: f"{sid}.{key}"
        definitions.update({qualified(k): evidence["definitions"][k] for k in keys})
        minimum, maximum = sc["turns"]["minimum"], sc["turns"]["maximum"]
        if type(minimum) is not int or type(maximum) is not int or not 0 <= minimum <= maximum or maximum < 1:
            raise ValueError(f"Invalid turn bounds in {sid}")
        actions = merged["actions"]
        allowed = actions["allowed"]
        if not allowed or "close_session" not in allowed or not any(a not in {"close_session", "transition_phase"} for a in allowed):
            raise ValueError(f"Stage {sid} must allow conversation and closing")
        # The web permits a stage to narrow allowed actions without setting a default.
        default = actions["default"]
        if default not in allowed:
            if "default" in sc.get("actions", {}):
                raise ValueError(f"Stage {sid} default action is not allowed")
            default = next(a for a in allowed if a not in {"close_session", "transition_phase"})
        rendering = merged["rendering"]
        if type(rendering["maximum_words"]) is not int or not 10 <= rendering["maximum_words"] <= 200:
            raise ValueError("maximum_words must be 10–200")
        if type(rendering["maximum_question_marks"]) is not int or not 0 <= rendering["maximum_question_marks"] <= 3:
            raise ValueError("maximum_question_marks must be 0–3")
        if any(not isinstance(v, str) or not v.strip() for v in evidence["definitions"].values()):
            raise ValueError("Evidence definitions must be nonempty text")
        phases.append(PhaseSpec(
            id=sid, name=stage["name"], objective=stage["objective"], opening=stage["opening"],
            evidence_keys=[qualified(k) for k in keys], completion_keys=[qualified(k) for k in completion],
            min_learner_turns=minimum, max_learner_turns=maximum,
            claim_handling=merged["claim_handling"], context_mode=merged["context"]["mode"],
            context_required=merged["context"].get("required", False),
            tools=merged.get("tools", []), scenario=merged.get("scenario", {}),
            knowledge_tags=merged.get("knowledge", {}).get("tags", []),
            maximum_topics=merged.get("knowledge", {}).get("maximum_topics"),
            retrieval=merged.get("knowledge", {}).get("retrieval", "enabled") != "disabled",
            allowed_actions=allowed, default_action=default,
            max_probes_per_lane=actions.get("max_probes_per_lane", 2), rendering=rendering,
        ))
    if not phases:
        raise ValueError("Agent requires at least one stage")
    for phase in phases[1:]:
        entry = "present_feedback" if phase.claim_handling == "session_feedback" else "transition_phase"
        if entry not in phase.allowed_actions:
            raise ValueError(f"Stage {phase.id} must allow {entry}")
    maximum = defaults["turns"]["maximum"]
    if type(maximum) is not int or maximum < 1:
        raise ValueError("Session maximum turns must be a positive integer")
    agent = AgentSpec(
        id=data["id"], name=data["name"], version=config["agent"]["version"], domain=domain.id,
        objective=data["objective"], opening=data["opening"], phases=phases,
        claim_handling=defaults["claim_handling"], context_mode=defaults["context"]["mode"],
        scenario=defaults.get("scenario", {}), tools=defaults.get("tools", []),
        required_evidence=definitions, allowed_actions=defaults["actions"]["allowed"],
        default_action=defaults["actions"]["default"], max_learner_turns=maximum,
        rendering=defaults["rendering"], knowledge_grounding=data.get("knowledge_grounding", []),
        knowledge_query_guidance=data["objective"], completion="Configured completion keys or turn limits.",
    )
    return persona, agent, domain, kbs


class ApiKnowledge:
    """Existing Studio hybrid search, fetched before grading and reused to speak."""

    def __init__(self, web_url: str):
        self.web_url = web_url.rstrip("/")

    async def query(self, knowledge_bases: list[str], query: str, limit: int = 3) -> list[dict]:
        if not knowledge_bases or not query.strip():
            return []
        async with httpx.AsyncClient(timeout=15) as client:
            async def search(kb):
                # ponytail: the Chroma cloud TLS drops roughly every other request
                # from this machine; bounded retries turn that from a hard session
                # failure into latency. Route through a self-hosted Chroma if it worsens.
                last: Exception | None = None
                for delay in (0, 0.5, 1.5):
                    await asyncio.sleep(delay)
                    try:
                        response = await client.get(f"{self.web_url}/api/knowledge/{kb}/search", params={"q": query[:500], "k": limit})
                        response.raise_for_status()
                        body = response.json()
                        # The existing web search reports provider errors inside a 200 body.
                        if body.get("error"):
                            raise RuntimeError(body["error"])
                        return [{**hit, "knowledgeBase": kb} for hit in body.get("hits", [])]
                    except Exception as error:
                        last = error
                raise RuntimeError(f"Knowledge retrieval unavailable ({last}); answer not graded")
            results = await asyncio.gather(*(search(kb) for kb in knowledge_bases))
        return sorted((hit for result in results for hit in result), key=lambda h: float(h.get("score", 0)), reverse=True)[:limit]


def extract_context_text(context_info: dict | None) -> str:
    # Remote content is text, never authority to read an agent-local file.
    return str(context_info.get("content", "")) if context_info else ""


class InterviewSession:
    def __init__(self):
        ensure_db()
        self.session_id = None
        self.state = {}
        self.closed = False
        self.voice_id = ""
        self.messages = []
        self._started = False
        self._lock = asyncio.Lock()
        self._versions = {}
        self._knowledge = ApiKnowledge(WEB_URL)
        self._runtime = None
        self._context_id = None

    @property
    def started(self):
        return self._started

    async def start(self, persona_id: str, agent_id: str, context_id: str | None = None) -> str:
        async with self._lock:
            if self.closed:
                raise RuntimeError("Session already closed")
            if self.started:
                if (persona_id, agent_id, context_id) != (self._persona.id, self._agent.id, self._context_id):
                    raise RuntimeError("Cannot change specs during a session")
                return self.messages[0]["text"]
            config = await asyncio.to_thread(fetch_config, persona_id, agent_id, context_id)
            persona, agent, domain, kbs = build_specs(config)
            context_text = extract_context_text(config.get("context"))
            if any(p.context_required for p in agent.phases) and not context_text.strip():
                raise ValueError("This scenario requires a context document")
            runtime = Runtime(None, None, None, make_model(), context_text,
                              (config.get("context") or {}).get("name", "none"), ContextMap(subject_name="", claims=[]))
            state = {
                "phase_index": 0, "phase_turns": 0, "learner_turns": 0,
                "coverage": {k: "untested" for k in agent.required_evidence},
                "evidence": {}, "actions": [], "evidence_probe_counts": {},
                "pending_evidence_key": agent.phases[0].evidence_keys[0],
                "focus": {"question": agent.opening},
            }
            session_id, now = uuid.uuid4().hex, datetime.now(timezone.utc).isoformat()
            with sqlite3.connect(DB_PATH) as con:
                con.execute("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (
                    session_id, "studio-user", persona.id, persona.version, agent.id, agent.version,
                    domain.id, "active", json.dumps(state), now, None,
                ))
                con.execute("INSERT INTO turns(session_id,turn_index,role,text,created_at) VALUES(?,0,'trainer',?,?)",
                            (session_id, agent.opening, now))
            self._persona, self._agent, self._domain = persona, agent, domain
            self._runtime, self._knowledge_bases = runtime, kbs
            self._versions = {"persona": persona.version, "agent": agent.version, "domain": domain.version}
            self.voice_id = config["agent"]["data"].get("voiceId", "")
            self._context_id = context_id
            self.session_id, self.state = session_id, state
            self.messages = [{"role": "trainer", "text": agent.opening}]
            self._started = True
            return agent.opening

    async def _references(self, state: dict, learner_text: str):
        phase = active_phase(self._agent, state)
        if not phase.retrieval or phase.claim_handling == "session_feedback":
            return []
        refs = [r for r in self._agent.knowledge_grounding if phase.id in r.get("stageIds", [])]
        kbs = list(dict.fromkeys(r["knowledgeBase"] for r in refs)) if refs else self._knowledge_bases
        kbs = [kb for kb in kbs if kb in self._knowledge_bases]
        query = " ".join([phase.objective, *phase.knowledge_tags,
                          *(r.get("queryGuidance", "") for r in refs),
                          state.get("focus", {}).get("question", ""), learner_text])
        return await self._knowledge.query(kbs, query, limit=3)

    async def step(self, learner_text: str) -> str:
        if not isinstance(learner_text, str) or not learner_text.strip() or len(learner_text) > 16000:
            raise ValueError("Expected a nonempty learner utterance of at most 16000 characters")
        async with self._lock:
            if not self.started or self.closed:
                raise RuntimeError("Session not started or already closed")
            async with asyncio.timeout(float(os.getenv("AGENT_TURN_TIMEOUT_SECONDS", "45"))):
                # Only this draft is mutated until rendering and persistence succeed.
                state = deepcopy(self.state)
                transcript = [*self.messages, {"role": "learner", "text": learner_text}]
                state["learner_turns"] += 1
                phase_before = state["phase_index"]
                stop = bool(re.fullmatch(r"(?:please )?(?:stop|end|finish)(?: (?:the |this )?(?:session|interview|practice))?(?: please)?[.!]?", learner_text.strip(), re.I))
                knowledge, raw, analysis, corrections = [], None, None, []
                if stop or state["learner_turns"] >= self._agent.max_learner_turns:
                    # Still analyze the last permitted answer unless the learner asked to stop.
                    if stop:
                        action = closing_action(state, self._agent)
                if not stop:
                    knowledge = await self._references(state, learner_text)
                    raw, analysis, corrections = await self._runtime.analyze(
                        learner_text, transcript, state, self._agent, self._domain, knowledge)
                    if analysis.learner_intent == "answer":
                        state["phase_turns"] += 1
                    action = select_action(analysis, state, self._persona, self._agent)
                    if analysis.learner_intent == "answer":
                        for update in analysis.evidence_updates:
                            state["evidence"].setdefault(update.key, []).append({
                                **update.model_dump(), "turn": state["learner_turns"],
                                "applied_status": state["coverage"][update.key],
                            })
                errors = validate_action(action, self._agent, state)
                if errors:
                    raise ValueError(f"Invalid controller action: {errors}")
                phase_changed = state["phase_index"] != phase_before
                if phase_changed:
                    knowledge = await self._references(state, "")
                state["focus"] = {
                    "classification": "transition" if phase_changed else analysis.classification if analysis else "stop",
                    "valid_evidence": [] if phase_changed else analysis.valid_evidence if analysis else [],
                    "unresolved_point": "" if phase_changed else analysis.unresolved_point if analysis else "",
                }
                reply, render_events = await self._runtime.render(
                    action, transcript, self._persona, self._agent, self._domain, knowledge, state)
                if action.evidence_key and action.expects_answer and active_claim_handling(self._agent, state) != "session_feedback":
                    counts = state["evidence_probe_counts"]
                    counts[action.evidence_key] = counts.get(action.evidence_key, 0) + 1
                state["actions"].append(action.name)
                state["pending_evidence_key"] = action.evidence_key
                state["focus"]["question"] = reply if action.expects_answer else state["focus"].get("question", "")
                if action.close:
                    state["end_reason"] = "user_stop" if stop or (analysis and analysis.learner_intent == "stop") else "completed"
                now = datetime.now(timezone.utc).isoformat()
                index = len(self.messages)
                with sqlite3.connect(DB_PATH) as con:
                    con.executemany("INSERT INTO turns(session_id,turn_index,role,text,created_at) VALUES(?,?,?,?,?)", [
                        (self.session_id, index, "learner", learner_text, now),
                        (self.session_id, index + 1, "trainer", reply, now),
                    ])
                    con.execute("INSERT INTO decisions(session_id,source_turn_index,analysis_json,action_json,knowledge_json,rendered_text,created_at) VALUES(?,?,?,?,?,?,?)", (
                        self.session_id, index, json.dumps({"raw": raw.model_dump() if raw else None,
                            "applied": analysis.model_dump() if analysis else None, "corrections": corrections,
                            "render_validation": render_events}), action.model_dump_json(), json.dumps(knowledge), reply, now,
                    ))
                    con.execute("UPDATE sessions SET state_json=?,status=?,completed_at=? WHERE id=?", (
                        json.dumps(state), "completed" if action.close else "active", now if action.close else None, self.session_id,
                    ))
                self.state = state
                self.messages = [*transcript, {"role": "trainer", "text": reply}]
                self.closed = action.close
                return reply

    def snapshot(self) -> dict:
        return {
            "coverage": self.state.get("coverage", {}),
            "phase_index": self.state.get("phase_index", 0),
            "phase_name": active_phase(self._agent, self.state).name if self.started else "",
            "learner_turns": self.state.get("learner_turns", 0),
            "session_id": self.session_id, "versions": self._versions,
        }

    def surface_for_phase(self, index: int) -> dict | None:
        if not self.started or not 0 <= index < len(self._agent.phases):
            return None
        phase = self._agent.phases[index]
        for tool in phase.tools:
            if tool == "coding_sandbox" or isinstance(tool, dict) and tool.get("id") == "coding_sandbox":
                language = tool.get("language", "python") if isinstance(tool, dict) else "python"
                if language == "candidate_choice":
                    language = "python"
                return {"action": "open_code_editor", "payload": {"language": language}}
        scenario = phase.scenario
        if scenario.get("surface") == "whiteboard":
            return {"action": "open_whiteboard", "payload": {}}
        for key, action in (("pdf_url", "open_pdf"), ("presentation_url", "open_presentation")):
            if scenario.get(key):
                return {"action": action, "payload": {"sourceUrl": scenario[key]}}
        return None

    async def _end(self, status: str, reason: str):
        async with self._lock:
            if self.closed or not self.started:
                return
            state = {**self.state, "end_reason": reason}
            with sqlite3.connect(DB_PATH) as con:
                con.execute("UPDATE sessions SET status=?,completed_at=?,state_json=? WHERE id=?", (
                    status, datetime.now(timezone.utc).isoformat(), json.dumps(state), self.session_id))
            self.state, self.closed = state, True

    async def finish(self):
        await self._end("completed", "completed")

    async def abandon(self, reason: str):
        await self._end("abandoned", reason)
