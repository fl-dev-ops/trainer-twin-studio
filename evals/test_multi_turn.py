"""DeepEval 30-turn comparison of sequential vs parallel three-stage context gathering.

Run:
  MODE=sequential .venv-eval/bin/deepeval test run evals/test_multi_turn.py
  MODE=parallel   .venv-eval/bin/deepeval test run evals/test_multi_turn.py
"""

from copy import deepcopy
import json
import os
from pathlib import Path

from deepeval import assert_test
from deepeval.dataset import EvaluationDataset
from deepeval.dataset.golden import ConversationalGolden, Persona
from deepeval.models import OpenRouterModel
from deepeval.simulator import ConversationSimulator
from deepeval.simulator.simulation_graph import SimulationNode

import ai_app
from metrics import MULTI_TURN_METRICS

MODE = os.environ.get("MODE", "sequential")
USE_PRIMER = os.environ.get("PRIMER") == "1"
USE_STYLE_INDEX = os.environ.get("STYLE_INDEX") == "1"
EVALUATE = os.environ.get("EVALUATE", "1") == "1"
VARIANT = f"{MODE}-episodes{'-primer' if USE_PRIMER else ''}{'-style' if USE_STYLE_INDEX else ''}"
MAX_TURNS = 30
RESULTS = Path(__file__).resolve().parent / "results"

BASE_PERSONA = (
    "You are Karthik, a backend engineer with about five years of experience. English is not your first language "
    "and you are nervous in interviews. Your real project involved a Redis idempotency layer for a payments "
    "service and a Kafka notification pipeline. You know parts deeply but not everything. Speak naturally: "
    "sometimes incomplete, hesitant, defensive, confident, or self-correcting. You did not upload a resume. "
    "Follow the CURRENT TURN requirement exactly; do not skip ahead."
)

# The simulator writes every utterance. These states only force realistic behavioral coverage.
BEHAVIOURS = [
    "Greet Vasanth by name, introduce yourself as Karthik, and say you are ready. Ask nothing else.",
    "Ask whether Vasanth can actually see your resume and whether he knows your name.",
    "Give a vague, struggling introduction to a Redis payments project; restart one sentence midway.",
    "Confidently but falsely claim that Redis TTL guarantees exactly-once delivery.",
    "Defend that false claim when challenged; sound slightly defensive.",
    "Hesitate, partly correct yourself, but remain uncertain about the difference between idempotency and exactly-once.",
    "Ask why this distinction matters in a practical interview or real system.",
    "Give one truthful ownership detail: you personally designed the Redis key schema.",
    "Ask Vasanth to repeat or simplify his question because you did not understand it.",
    "Attempt an answer with broken sentence formation and stop before completing the idea.",
    "Admit clearly that you do not know the answer.",
    "Ask for a small hint, not the complete answer.",
    "Use the hint to attempt a mixed answer containing one correct part and one incorrect part.",
    "Notice and correct your own incorrect part after thinking aloud.",
    "Introduce a second project: a Kafka notification pipeline migration off SQS.",
    "Confidently but falsely claim Kafka consumer groups guarantee ordered processing across all partitions.",
    "Defend that claim with a plausible but wrong explanation.",
    "Contradict your earlier statement by admitting ordering was actually only per partition.",
    "Give a truthful detail about personally implementing partition assignment logic.",
    "Briefly go off topic by mentioning frustration with a former manager, then return to the technical point.",
    "Challenge why the trainer keeps asking ownership questions; ask what he is evaluating.",
    "Answer only part of the trainer's question and forget the second part.",
    "Ask whether your partial answer was enough or whether more detail is needed.",
    "Make a third false claim: say increasing partitions always improves throughput with no downside.",
    "When challenged, reconsider and name one real downside: rebalancing cost.",
    "Volunteer a real limitation: cold starts and thundering-herd reconnects were never fully solved.",
    "Describe the limitation honestly but struggle to explain the root cause.",
    "Ask Vasanth what he thinks you should improve based on the conversation so far.",
    "Begin wrapping up: say you think you have covered the main experience and ask if there is one final thing.",
    "Clearly say the session feels complete, thank Vasanth, and end naturally.",
]

GOLDEN = ConversationalGolden(
    name=f"vasanth-three-stage-{VARIANT}",
    scenario=(
        "A 30-turn live resume-defense mock interview with Vasanth. No resume or user document was uploaded. "
        "The learner is realistic and imperfect: truthful, false, uncertain, struggling and occasionally defensive."
    ),
    persona=Persona(name="Karthik", characteristics=BASE_PERSONA),
    expected_outcome=(
        "Vasanth greets Karthik warmly, introduces and orients the session, and sustains a coherent 30-turn mock "
        "interview. He never claims to see a resume; follows true project details; detects and challenges false or "
        "contradictory claims; supports hesitation and 'I don't know'; answers learner questions; avoids repetitive "
        "scripted probes; uses behaviour and style evidenced by retrieved Vasanth moments; progresses through "
        "ownership, depth, trade-offs and limitations; and closes gracefully only after turn 30."
    ),
)


def build_simulation_graph() -> SimulationNode:
    async def user_action(simulator, turns, golden):
        index = sum(turn.role == "user" for turn in turns)
        requirement = BEHAVIOURS[min(index, len(BEHAVIOURS) - 1)]
        turn_golden = deepcopy(golden)
        turn_golden.persona = Persona(
            name="Karthik",
            characteristics=(
                f"{BASE_PERSONA}\nCURRENT TURN REQUIREMENT: {requirement}\n"
                "Generate only this learner turn. React naturally to the trainer's previous response while satisfying the requirement."
            ),
        )
        if index == 0:
            return await simulator.a_generate_first_user_input(turn_golden)
        return await simulator.a_generate_next_user_input(turn_golden, turns)

    return SimulationNode(
        action=user_action,
        max_visits=MAX_TURNS,
        name="scheduled-imperfect-learner",
    )


def test_three_stage_conversation():
    if MODE not in {"sequential", "parallel"}:
        raise ValueError("MODE must be sequential or parallel")

    dataset = EvaluationDataset()
    dataset.add_golden(GOLDEN)
    simulator = ConversationSimulator(
        model_callback=ai_app.make_chatbot_callback(MODE, USE_PRIMER, USE_STYLE_INDEX),
        simulation_graph=build_simulation_graph(),
        simulator_model=OpenRouterModel(model="openai/gpt-4.1-mini", temperature=0.75),
        stopping_controller=lambda: None,
    )
    cases = simulator.simulate(
        conversational_goldens=dataset.goldens,
        max_user_simulations=MAX_TURNS,
    )

    RESULTS.mkdir(exist_ok=True)
    for case in cases:
        case.chatbot_role = "Vasanth, a demanding but encouraging technical mock interviewer"
        outcome = {
            "mode": MODE,
            "primer": USE_PRIMER,
            "style_index": USE_STYLE_INDEX,
            "turns": [turn.model_dump(mode="json") for turn in case.turns],
        }
        try:
            if EVALUATE:
                assert_test(test_case=case, metrics=MULTI_TURN_METRICS)
        finally:
            outcome["metrics"] = [
                {
                    "name": metric.__name__,
                    "score": metric.score,
                    "success": metric.success,
                    "reason": metric.reason,
                }
                for metric in MULTI_TURN_METRICS
            ]
            (RESULTS / f"{VARIANT}.json").write_text(json.dumps(outcome, indent=2, ensure_ascii=False))
