"""Simulate published TrainerTwin scenarios with DeepEval and score trainer
fidelity against persona source material. All conversation goes through the
chat bridge (see bridge.py) — no imports from web/ or chat/, no DB writes.

  cd bench && uv sync && uv run python simulate.py
"""

from __future__ import annotations

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

from bridge import DEFAULT_TOOLS, Bridge
from checks import conversation_likeness, conversation_quality_issues
from conf import API_URL, RESULTS_DIR
from learners import all_learners, build_synthetic_golden
from metrics import conversation_metrics
from scenarios import build_reference_context, load_scenarios

MAX_TURNS = int(os.getenv("BENCH_MAX_TURNS", "12"))
FIDELITY_THRESHOLD = float(os.getenv("BENCH_FIDELITY_THRESHOLD", "0.7"))


def report_path() -> Path:
    if os.getenv("BENCH_REPORT"):
        return Path(os.environ["BENCH_REPORT"])
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    return RESULTS_DIR / f"{stamp}.json"


def build_golden(scenario: dict, learner: dict | None = None) -> ConversationalGolden:
    return build_synthetic_golden(scenario, learner)


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
    """One durable bridge session per simulation; history lives server-side."""

    def __init__(self, scenario: dict):
        self.scenario = scenario
        self.session_id = f"bench-fidelity-{uuid4()}"
        self.bridge = Bridge(
            session_id=self.session_id,
            agent_slug=scenario["slug"],
            persona_slug=scenario["persona_slug"],
        )

    def open(self) -> str:
        return self.bridge.open_session()

    def complete(self, user_text: str) -> str:
        response = self.bridge.send(user_text, tools=DEFAULT_TOOLS)
        text = response["text"]
        if not text:
            raise RuntimeError(f"Unexpected completion: no content (tools={response['tools_called']})")
        return text


def stopping_controller(last_assistant_turn: Turn | None):
    text = (last_assistant_turn.content if last_assistant_turn else "").lower()
    if re.search(r"we.?ll stop here|conclude here|session ended", text):
        return end(reason="trainer closed the interview")
    return proceed()


def simulate_one(scenario: dict, llm: OpenRouterLLM, learner: dict | None = None):
    runtime = Runtime(scenario)
    try:
        opening = runtime.open()
        golden = build_golden(scenario, learner)
        label = golden.name
        print(f"\n[{label}] session {runtime.session_id}\nTRAINER: {opening}\n")
        golden.turns = [Turn(role="assistant", content=opening)]

        def model_callback(input: str, turns: list[Turn]) -> Turn:
            # The bridge keeps the durable history; send only the latest turn.
            text = runtime.complete(input)
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
            "session_id": runtime.session_id,
            "api_url": API_URL,
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
        pass  # bridge sessions are durable; no DB rows to clean up


def save_report(result, cases: list, llm: OpenRouterLLM, path: Path) -> None:
    report = result.model_dump(mode="json", by_alias=True)
    report["benchmark"] = {
        "created_at": datetime.now(UTC).isoformat(),
        "api_url": API_URL,
        "evaluation_model": llm.get_model_name(),
        "fidelity_threshold": FIDELITY_THRESHOLD,
        "max_turns": MAX_TURNS,
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
