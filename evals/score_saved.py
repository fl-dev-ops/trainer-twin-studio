"""Score a preserved 30-turn conversation with the two useful DeepEval GEval judges."""

import json
import os
from pathlib import Path

from dotenv import load_dotenv
from deepeval.test_case import ConversationalTestCase, Turn

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / "web/.env")

from metrics import MULTI_TURN_METRICS
from test_multi_turn import GOLDEN

VARIANT = os.environ["VARIANT"]
RESULTS = Path(__file__).resolve().parent / "results"
data = json.loads((RESULTS / f"{VARIANT}.json").read_text())
case = ConversationalTestCase(
    name=f"vasanth-three-stage-{VARIANT}",
    turns=[Turn.model_validate(turn) for turn in data["turns"]],
    scenario=GOLDEN.scenario,
    expected_outcome=GOLDEN.expected_outcome,
    chatbot_role="Vasanth, a demanding but encouraging technical mock interviewer",
)

scores = []
for metric in MULTI_TURN_METRICS[-2:]:
    result = {"name": metric.__name__}
    try:
        metric.measure(case)
        result.update(score=metric.score, success=metric.success, reason=metric.reason)
    except Exception as exc:
        result["error"] = str(exc)
    print(result, flush=True)
    scores.append(result)

(RESULTS / f"{VARIANT}-scores.json").write_text(json.dumps(scores, indent=2, ensure_ascii=False))
