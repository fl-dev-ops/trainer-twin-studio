"""Bridge between the TrainerTwin studio (Postgres) and the POC runtime.

Fetches a compiled config (specs + knowledge + context) from the web app's
/api/agent-config endpoint, builds POC spec objects, and exposes async
start/step/close around the blocking pydantic-ai calls.
"""

import asyncio
import json
import os
import tempfile
from copy import deepcopy
from pathlib import Path

import httpx
from dotenv import load_dotenv
from loguru import logger

AGENT_ROOT = Path(__file__).parent.resolve()
load_dotenv(AGENT_ROOT / ".env")

WEB_URL = os.getenv("WEB_URL", "http://localhost:3000").rstrip("/")

from runner import (
    AgentSpec,
    ContextMap,
    DomainSpec,
    LocalStore,
    PersonaSpec,
    PhaseSpec,
    Runtime,
    compile_context,
    load_context,
    make_model,
    configured_model_name,
    permits_resume_context,
)

class ApiKnowledge:
    """Knowledge retrieval via the studio's hybrid search endpoint.

    The studio owns embeddings + hybrid ranking (vector + BM25 + RRF + rerank);
    this adapter just exposes the POC Runtime's `knowledge.query` interface.
    """

    def __init__(self, web_url: str):
        self.web_url = web_url.rstrip("/")

    def query(self, knowledge_bases: list[str], query: str, limit: int = 3):
        """Query the studio's hybrid search; adapt to the runtime's {text, source, distance} shape."""
        scored: list[dict] = []
        with httpx.Client(timeout=60) as client:
            for kb in knowledge_bases:
                try:
                    res = client.get(
                        f"{self.web_url}/api/knowledge/{kb}/search",
                        params={"q": query, "k": limit},
                    )
                    res.raise_for_status()
                    for hit in res.json().get("hits", []):
                        scored.append({
                            "text": hit.get("text", ""),
                            "source": hit.get("source", ""),
                            "score": float(hit.get("score", 0)),
                        })
                except Exception as error:
                    logger.warning("knowledge search failed for {}: {}", kb, error)
        # runtime expects ascending "distance"; our scores are higher-is-better, so use rank
        ranked = sorted(scored, key=lambda m: m["score"], reverse=True)[:limit]
        return [
            {"text": m["text"], "source": m["source"], "distance": rank}
            for rank, m in enumerate(ranked)
        ]


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


def build_specs(config: dict) -> tuple[PersonaSpec, AgentSpec, DomainSpec, list[str]]:
    persona_data = config["persona"]["data"]
    agent_data = config["agent"]["data"]
    domain_data = config["domain"]["data"]
    persona = PersonaSpec.model_validate(persona_data)
    knowledge_bases = list(config.get("knowledgeBases", []))
    domain = DomainSpec.model_validate({**domain_data, "knowledge_bases": knowledge_bases})

    global_config = agent_data["config"]
    required_evidence: dict[str, str] = {}
    phases = []
    all_actions = set(global_config["actions"]["allowed"])
    default_action = global_config["actions"]["default"]
    for stage in agent_data.get("stages", []):
        config_stage = deep_merge(global_config, stage.get("config", {}))
        evidence = config_stage["evidence"]
        required_evidence.update(evidence.get("definitions", {}))
        allowed = list(config_stage["actions"]["allowed"])
        for required_action in (default_action, "transition_phase", "close_session"):
            if required_action not in allowed:
                allowed.append(required_action)
        all_actions.update(allowed)
        phases.append(PhaseSpec(
            id=stage["id"],
            name=stage["name"],
            objective=stage["objective"],
            evidence_keys=list(evidence["keys"]),
            completion_keys=list(evidence.get("completion_keys") or []),
            min_learner_turns=config_stage["turns"].get("minimum", 0),
            max_learner_turns=config_stage["turns"]["maximum"],
            opening=stage["opening"],
            claim_handling=config_stage["claim_handling"],
            context_mode=config_stage.get("context", {}).get("mode"),
            knowledge_tags=config_stage.get("knowledge", {}).get("tags", []),
            tools=config_stage.get("tools", []),
            scenario=config_stage.get("scenario", {}),
            allowed_actions=allowed,
        ))

    if not phases:
        evidence = global_config["evidence"]
        required_evidence.update(evidence.get("definitions", {}))
        phases.append(PhaseSpec(
            id="main",
            name=agent_data["name"],
            objective=agent_data["objective"],
            evidence_keys=list(required_evidence.keys()),
            completion_keys=list(evidence.get("keys") or []),
            min_learner_turns=global_config["turns"].get("minimum", 0),
            max_learner_turns=global_config["turns"]["maximum"],
            opening=agent_data["opening"],
            claim_handling=global_config["claim_handling"],
            context_mode=global_config.get("context", {}).get("mode"),
            knowledge_tags=global_config.get("knowledge", {}).get("tags", []),
            tools=global_config.get("tools", []),
            scenario=global_config.get("scenario", {}),
            allowed_actions=sorted(all_actions | {default_action, "transition_phase", "close_session"}),
        ))

    agent = AgentSpec(
        id=agent_data["id"],
        name=agent_data["name"],
        version=config["agent"]["version"],
        domain=domain.id,
        objective=agent_data["objective"],
        opening=agent_data["opening"],
        phases=phases,
        claim_handling=global_config["claim_handling"],
        scenario=global_config.get("scenario", {}),
        required_evidence=required_evidence,
        allowed_actions=sorted(all_actions | {default_action, "transition_phase", "close_session"}),
        default_action=default_action,
        max_learner_turns=max(p.max_learner_turns for p in phases),
        knowledge_query_guidance="Use only active-stage knowledge as assessor reference; never supply the candidate's answer.",
        completion="Complete the selected stages or stop at the configured turn budget.",
    )
    return persona, agent, domain, knowledge_bases


class InterviewSession:
    """One voice session backed by a POC Runtime + LocalStore."""

    def __init__(self):
        self.store = LocalStore(AGENT_ROOT / ".local" / "trainertwin.db")
        self.session_id: str | None = None
        self.state: dict | None = None
        self.closed = False
        self.voice_id = ""
        self._runtime: Runtime | None = None
        self._persona: PersonaSpec | None = None
        self._agent: AgentSpec | None = None
        self._domain: DomainSpec | None = None
        self._versions: dict = {}

    @property
    def started(self) -> bool:
        return self._runtime is not None

    async def start(self, persona_id: str, agent_id: str, context_id: str | None = None) -> str:
        """Build specs, compile context, index knowledge. Returns the opening line."""

        def build():
            config = fetch_config(persona_id, agent_id, context_id)
            persona, agent, domain, knowledge_bases = build_specs(config)
            self._versions = {
                "persona": config["persona"]["version"],
                "agent": config["agent"]["version"],
                "domain": config["domain"]["version"],
            }
            voice_id = config["agent"]["data"].get("voiceId")
            if isinstance(voice_id, str) and voice_id:
                self.voice_id = voice_id
            model_name = configured_model_name()
            model = make_model()
            if permits_resume_context(agent):
                context_info = config.get("context")
                if context_info and context_info.get("content"):
                    content = context_info["content"]
                    # PDFs arrive as a materialized temp-file path; text arrives inline
                    as_path = Path(content)
                    if content.startswith("/") and as_path.is_file():
                        context_text = load_context(as_path)
                    else:
                        tmp = Path(tempfile.mkdtemp(prefix="tt-context-")) / context_info["name"]
                        tmp.write_text(content)
                        context_text = load_context(tmp)
                    context_source = context_info["name"]
                else:
                    context_text, context_source = "", "none"
                context_map = compile_context(model, context_text, context_source, model_name)
            else:
                context_text, context_source = "", "none"
                context_map = ContextMap(subject_name="", claims=[])
            knowledge = ApiKnowledge(WEB_URL)
            runtime = Runtime({}, self.store, knowledge, model, context_text, context_source, context_map)
            session_id, state = self.store.create_session("studio-user", persona, agent, domain)
            self.store.event(session_id, "runtime_configured", {
                "persona": f"{persona.id}:v{persona.version}",
                "agent": f"{agent.id}:v{agent.version}",
                "domain": f"{domain.id}:v{domain.version}",
                "model": model_name,
                "context_source": context_source,
            })
            self.store.add_turn(session_id, "trainer", agent.opening)
            self.store.db.commit()
            return runtime, session_id, state, persona, agent, domain, agent.opening

        (
            self._runtime, self.session_id, self.state,
            self._persona, self._agent, self._domain, opening,
        ) = await asyncio.to_thread(build)
        logger.info("Interview session {} started ({}/{})", self.session_id, persona_id, agent_id)
        return opening

    async def step(self, learner_text: str) -> str:
        """One learner turn through analyze → policy → render. Returns trainer speech."""
        if not self._runtime or self.closed:
            raise RuntimeError("Session not started or already closed")
        response, action = await asyncio.to_thread(
            self._runtime.step,
            self.session_id, learner_text, self.state, self._persona, self._agent, self._domain,
        )
        if action.close:
            await self.finish()
        return response

    def snapshot(self) -> dict:
        if not self.state:
            return {}
        phase_index = self.state.get("phase_index", 0)
        phase_name = ""
        if self._agent and phase_index < len(self._agent.phases):
            phase_name = self._agent.phases[phase_index].name
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
        if not self._agent or index >= len(self._agent.phases):
            return None
        phase = self._agent.phases[index]
        for tool in phase.tools or []:
            if tool == "coding_sandbox" or (isinstance(tool, dict) and tool.get("id") == "coding_sandbox"):
                language = tool.get("language", "python") if isinstance(tool, dict) else "python"
                return {"action": "open_code_editor", "payload": {"language": language}}
        scenario = phase.scenario or {}
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
        await asyncio.to_thread(
            lambda: self.store.finish(self.session_id, "studio-user", self._domain.id,
                                      self.state, agent_ref=f"{self._agent.id}:v{self._agent.version}")
        )
        logger.info("Interview session {} completed", self.session_id)

    async def abandon(self, reason: str):
        if not self.session_id or self.closed:
            return
        self.closed = True
        await asyncio.to_thread(lambda: self.store.abandon(self.session_id, self.state, reason))


async def available_specs() -> tuple[list[str], list[str]]:
    async with httpx.AsyncClient(timeout=15) as client:
        personas = (await client.get(f"{WEB_URL}/api/spec/personas")).json()["specs"]
        agents = (await client.get(f"{WEB_URL}/api/spec/agents")).json()["specs"]
    return personas, agents


if __name__ == "__main__":
    personas, agents = asyncio.run(available_specs())
    print(json.dumps({"personas": personas, "agents": agents}, indent=2))
