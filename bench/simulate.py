"""Simulate published TrainerTwin scenarios with DeepEval and score trainer
fidelity against persona source material. All conversation goes through the
chat bridge (see bridge.py) — no imports from web/ or chat/, no DB writes.

  cd bench && uv sync && uv run python simulate.py
"""

from __future__ import annotations

import argparse
import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import httpx
from deepeval import evaluate
from deepeval.dataset import ConversationalGolden, Persona
from deepeval.models import DeepEvalBaseLLM
from deepeval.simulator import ConversationSimulator
from deepeval.simulator.controller import end, proceed
from deepeval.test_case import Turn
from pydantic import BaseModel

from bridge import DEFAULT_TOOLS, Bridge
from checks import conversation_likeness, conversation_quality_issues
from conf import API_URL, RESULTS_DIR
from learners import all_learners, build_synthetic_golden, document_grounded_learner
from metrics import conversation_metrics
from report import build_fidelity_report
import scenarios as scenarios_module
from scenarios import build_reference_context, load_scenarios

MAX_TURNS = int(os.getenv("BENCH_MAX_TURNS", "12"))
FIDELITY_THRESHOLD = float(os.getenv("BENCH_FIDELITY_THRESHOLD", "0.7"))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--turns", type=int, default=MAX_TURNS, help="max simulated learner turns (default BENCH_MAX_TURNS or 12)")
    parser.add_argument("--slugs", help="comma-separated published agent slugs (default BENCH_AGENT_SLUGS or fundamentals-depth)")
    parser.add_argument("--api-url", help="chat bridge base URL (default BENCH_API_URL or localhost:2001)")
    parser.add_argument("--learners", default=None, help="comma-separated learner names to run (default: all)")
    parser.add_argument("--file", type=Path, help="upload and attach a document before creating the session")
    parser.add_argument("--web-url", default=os.getenv("BENCH_WEB_URL", "http://localhost:3000"), help="TrainerTwin web URL used by --file")
    return parser.parse_args()


def report_path() -> Path:
    if os.getenv("BENCH_REPORT"):
        return Path(os.environ["BENCH_REPORT"])
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    return RESULTS_DIR / f"{stamp}.json"


def build_golden(scenario: dict, learner: dict | None = None) -> ConversationalGolden:
    return build_synthetic_golden(scenario, learner)


def knowledge_searches(tool_calls: list[dict]) -> list[dict]:
    return [call for call in tool_calls if call.get("name") == "search_knowledge"]


class DecisionRecord(BaseModel):
    turnIndex: int | None = None
    learnerState: str
    move: str
    reason: str


class DecisionEvaluation(BaseModel):
    decisions: list[DecisionRecord]


def evaluate_decisions(turns: list[dict], policy: dict, llm: "OpenRouterLLM") -> list[dict]:
    if not policy:
        return []
    pairs = [
        {"turnIndex": index, "learner": turn["content"], "trainer": turns[index + 1]["content"]}
        for index, turn in enumerate(turns[:-1])
        if turn["role"] == "user" and turns[index + 1]["role"] == "assistant"
    ]
    if not pairs:
        return []
    prompt = f"""Evaluate each transcript pair against this trainer decision policy.

Decision policy (learner state -> preferred move):
{json.dumps(policy, ensure_ascii=False)}

Transcript pairs:
{json.dumps(pairs, ensure_ascii=False)}

For every pair, return exactly one decision. learnerState must be the closest exact key from the policy. move must be the exact value from the policy's move vocabulary that best describes the trainer's observed response. Judge what the trainer actually did, not what the policy recommends. Include a brief evidence-based reason. Return JSON as {{"decisions": [...]}}."""
    evaluation = llm.generate(prompt, schema=DecisionEvaluation)
    return [
        {**decision.model_dump(), "turnIndex": decision.turnIndex if decision.turnIndex is not None else pairs[index]["turnIndex"]}
        for index, decision in enumerate(evaluation.decisions[:len(pairs)])
    ]


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

    def _request(self, prompt: str, schema=None) -> dict:
        return {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,
            **({"response_format": {"type": "json_object"}} if schema is not None else {}),
        }

    @staticmethod
    def _parse(response: httpx.Response, schema=None):
        response.raise_for_status()
        message = response.json()["choices"][0]["message"]
        content = message.get("content")
        if not isinstance(content, str) or not content.strip():
            raise ValueError(f"OpenRouter returned no content: {message}")
        return schema.model_validate_json(content) if schema is not None else content

    def generate(self, prompt: str, schema=None):
        error: ValueError | None = None
        with httpx.Client(timeout=120) as client:
            for attempt in range(3):
                response = client.post(
                    f"{self.base}/chat/completions",
                    headers={"authorization": f"Bearer {self.key}", "content-type": "application/json"},
                    json=self._request(prompt, schema),
                )
                try:
                    return self._parse(response, schema)
                except ValueError as exc:
                    error = exc
                    if attempt < 2:
                        print(f"OpenRouter learner response invalid; retrying ({attempt + 1}/3)", flush=True)
        raise RuntimeError("OpenRouter returned no valid learner response after 3 attempts") from error

    async def a_generate(self, prompt: str, schema=None):
        error: ValueError | None = None
        async with httpx.AsyncClient(timeout=120) as client:
            for attempt in range(3):
                response = await client.post(
                    f"{self.base}/chat/completions",
                    headers={"authorization": f"Bearer {self.key}", "content-type": "application/json"},
                    json=self._request(prompt, schema),
                )
                try:
                    return self._parse(response, schema)
                except ValueError as exc:
                    error = exc
                    if attempt < 2:
                        print(f"OpenRouter learner response invalid; retrying ({attempt + 1}/3)", flush=True)
        raise RuntimeError("OpenRouter returned no valid learner response after 3 attempts") from error


class Runtime:
    """One durable bridge session per simulation; history lives server-side."""

    def __init__(self, scenario: dict, *, api_url: str | None = None, session: dict | None = None):
        self.scenario = scenario
        self.session_id = session["session_id"] if session else f"bench-fidelity-{uuid4()}"
        self.closed = False
        self.tool_calls: list[dict] = []
        self.retrieval_traces: list[dict] = []
        self.bridge = Bridge(
            session_id=self.session_id,
            agent_slug=session["agent_slug"] if session else scenario["slug"],
            persona_slug=session["persona_slug"] if session else scenario["persona_slug"],
            url=api_url,
        )

    def open(self) -> str:
        return self.bridge.open_session()

    def complete(self, user_text: str) -> str:
        response = self.bridge.send(user_text, tools=DEFAULT_TOOLS)
        self.tool_calls.extend(response["tools_called"])
        self.retrieval_traces.extend(response["retrieval_traces"])
        self.closed = any(
            call.get("name") == "finish_session" or call.get("function", {}).get("name") == "finish_session"
            for call in response["tools_called"]
        )
        text = response["text"]
        if not text:
            raise RuntimeError(f"Unexpected completion: no content (tools={response['tools_called']})")
        return text


CLOSING_RE = re.compile(
    r"we.?ll stop here|conclude here|session ended|have a great day|goodbye|take care|all the best",
    re.IGNORECASE,
)


def trainer_closed(text: str) -> bool:
    return bool(CLOSING_RE.search(text))


def stopping_controller(last_assistant_turn: Turn | None):
    if trainer_closed(last_assistant_turn.content if last_assistant_turn else ""):
        return end(reason="trainer closed the interview")
    return proceed()


def simulate_one(scenario: dict, llm: OpenRouterLLM, learner: dict | None = None, *, api_url: str | None = None, max_turns: int = MAX_TURNS, session: dict | None = None):
    runtime = Runtime(scenario, api_url=api_url, session=session)
    try:
        opening = runtime.open()
        golden = build_golden(scenario, learner)
        label = golden.name
        print(f"\n[{label}] session {runtime.session_id}\n\nTRAINER: {opening}\n", flush=True)
        golden.turns = [Turn(role="assistant", content=opening)]

        def model_callback(input: str, turns: list[Turn]) -> Turn:
            # Print the learner immediately; the trainer request may take seconds.
            print(f"LEARNER: {input}\n", flush=True)
            text = runtime.complete(input)
            print(f"TRAINER: {text}\n", flush=True)
            return Turn(role="assistant", content=text)

        def stop_when_closed(last_assistant_turn: Turn | None):
            if runtime.closed:
                return end(reason="trainer called finish_session")
            return stopping_controller(last_assistant_turn)

        case = ConversationSimulator(
            model_callback=model_callback,
            simulator_model=llm,
            async_mode=False,
            stopping_controller=stop_when_closed,
        ).simulate(conversational_goldens=[golden], max_user_simulations=max_turns)[0]
        reference_context = build_reference_context(scenario["sources"])
        for turn in case.turns:
            if turn.role == "assistant":
                turn.retrieval_context = reference_context
        case.name = label
        case.chatbot_role = f'{scenario["persona_name"]}, the trainer running {scenario["name"]}'
        turns = [{"role": turn.role, "content": turn.content} for turn in case.turns]
        persona = scenario.get("persona") if isinstance(scenario.get("persona"), dict) else {}
        policy = persona.get("decision_preferences") if isinstance(persona.get("decision_preferences"), dict) else {}
        decisions = evaluate_decisions(turns, policy, llm)
        likeness = conversation_likeness(turns)
        issues = conversation_quality_issues(turns)
        print(f"likeness {likeness}")
        if issues:
            print(f"quality issues {issues}")
        case.metadata = {
            "session_id": runtime.session_id,
            "grounded_session": session["session_id"] if session else None,
            "api_url": API_URL,
            "scenario": scenario["slug"],
            "learner": golden.additional_metadata.get("learner") if golden.additional_metadata else None,
            "learner_source": golden.additional_metadata.get("learner_source") if golden.additional_metadata else None,
            "reference_persona": scenario["reference_persona_slug"],
            "reference_sources": [source["name"] for source in scenario["sources"]],
            "likeness": likeness,
            "quality_issues": issues,
            "knowledge_retrieval_invoked": bool(knowledge_searches(runtime.tool_calls)),
            "knowledge_searches": knowledge_searches(runtime.tool_calls),
            "knowledge_retrievals": runtime.retrieval_traces,
            "decision_records": decisions,
        }
        return case
    finally:
        pass  # bridge sessions are durable; no DB rows to clean up


def save_report(
    result,
    cases: list,
    scenarios: list[dict],
    llm: OpenRouterLLM,
    path: Path,
    max_turns: int = MAX_TURNS,
) -> Path:
    report = result.model_dump(mode="json", by_alias=True)
    report["benchmark"] = {
        "created_at": datetime.now(UTC).isoformat(),
        "api_url": API_URL,
        "evaluation_model": llm.get_model_name(),
        "fidelity_threshold": FIDELITY_THRESHOLD,
        "max_turns": max_turns,
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
    fidelity_path = path.with_suffix(".fidelity.json")
    fidelity = build_fidelity_report(
        report,
        cases,
        scenarios,
        org_id=os.environ["BENCH_ORG_ID"],
        evaluation_model=llm.get_model_name(),
        threshold=FIDELITY_THRESHOLD,
    )
    fidelity_path.write_text(json.dumps(fidelity, ensure_ascii=False, indent=2) + "\n")
    if os.getenv("BENCH_PUBLISH_FIDELITY") == "1":
        response = httpx.post(
            f'{os.getenv("BENCH_STUDIO_URL", "http://localhost:3000").rstrip("/")}/api/internal/fidelity',
            headers={
                "authorization": f'Bearer {os.environ["COPILOT_SERVICE_SECRET"]}',
                "content-type": "application/json",
                "x-trainertwin-org-id": os.environ["BENCH_ORG_ID"],
            },
            json=fidelity,
            timeout=120,
        )
        response.raise_for_status()
    return fidelity_path


def main() -> None:
    args = parse_args()
    session = None
    if args.file:
        import sessions
        slugs = [s.strip() for s in (args.slugs or "").split(",") if s.strip()]
        if len(slugs) != 1:
            raise SystemExit("--file requires exactly one --slugs value")
        session = sessions.prepare_file_session(args.file, slugs[0], args.web_url)
        scenarios_module.AGENT_SLUGS[:] = [session["agent_slug"]]
        print(f'Prepared session {session["session_id"]} with {session["document_name"]}\n', flush=True)
    elif args.slugs:
        scenarios_module.AGENT_SLUGS[:] = [s.strip() for s in args.slugs.split(",") if s.strip()]
    scenarios = load_scenarios()
    llm = OpenRouterLLM()
    learners = all_learners()
    if session:
        if args.learners:
            raise SystemExit("--learners cannot be combined with --file; the learner comes from the uploaded document")
        learners = [document_grounded_learner(
            session["learner_name"],
            session["document_name"],
            session["document_text"],
        )]
    elif args.learners:
        wanted = {s.strip() for s in args.learners.split(",") if s.strip()}
        learners = [l for l in learners if l["name"] in wanted]
    cases = [
        simulate_one(scenario, llm, learner, api_url=args.api_url, max_turns=args.turns, session=session)
        for scenario in scenarios
        for learner in learners
    ]
    result = evaluate(
        test_cases=cases,
        metrics=conversation_metrics(llm, FIDELITY_THRESHOLD),
        identifier="trainer-fidelity",
    )
    path = report_path()
    fidelity_path = save_report(result, cases, scenarios, llm, path, max_turns=args.turns)
    print(f"\nReport: {path}\nFidelity report: {fidelity_path}")


if __name__ == "__main__":
    main()
