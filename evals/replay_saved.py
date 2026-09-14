"""Replay identical DeepEval learner turns through one post-style variant."""

import json
import os
import time
from pathlib import Path

from deepeval.test_case import Turn

import ai_app

ROOT = Path(__file__).resolve().parent
SOURCE_PATH = Path(os.environ.get("SOURCE_PATH", ROOT / "results/parallel-episodes-primer.json"))
OUTPUT_PATH = Path(os.environ.get("OUTPUT_PATH", ROOT / "results/post-style.json"))
TOP_K = int(os.environ.get("POST_STYLE_TOP_K", "0"))
MAX_TURNS = int(os.environ.get("MAX_TURNS", "30"))
source = json.loads(SOURCE_PATH.read_text())
learner_turns = [Turn.model_validate(turn) for turn in source["turns"] if turn["role"] == "user"][:MAX_TURNS]
callback = ai_app.make_chatbot_callback(
    "parallel",
    use_primer=True,
    use_style_index=TOP_K > 0,
    post_style_top_k=TOP_K,
)
history: list[Turn] = []

for index, learner in enumerate(learner_turns, 1):
    for attempt in range(3):
        try:
            assistant = callback(learner.content, history)
            break
        except Exception as exc:
            if "402" not in str(exc) or attempt == 2:
                raise
            time.sleep(125)
    history.extend([Turn(role="user", content=learner.content), assistant])
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps({
        "post_style_top_k": TOP_K,
        "source": str(SOURCE_PATH),
        "completed_learner_turns": index,
        "turns": [turn.model_dump(mode="json") for turn in history],
    }, indent=2, ensure_ascii=False))
    print(f"{index:02d}: {assistant.content}", flush=True)
