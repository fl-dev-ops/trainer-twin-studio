"""Independent batch judge for post-style draft preservation."""

import json
import re
import statistics
from pathlib import Path

import ai_app

RESULTS = Path(__file__).resolve().parent / "results"
summary = {}
for label in ("control", "top3", "top5"):
    data = json.loads((RESULTS / f"post-style-{label}.json").read_text())
    assistants = [turn for turn in data["turns"] if turn["role"] == "assistant"]
    texts = [turn["content"] for turn in assistants]
    item = {
        "turns": len(texts),
        "learner_name_turns": sum("karthik" in text.lower() for text in texts),
        "thanks_starts": sum(text.lower().startswith(("thanks", "thank you")) for text in texts),
        "doubled_acknowledgements": sum(bool(re.search(r"\b(yes|yeah|correct|right|good|okay|sure|no)[,. ]+\1\b", text, re.I)) for text in texts),
        "average_words": round(statistics.mean(len(text.split()) for text in texts), 1),
        "questions": sum(text.count("?") for text in texts),
        "question_count_changed_turns": sum(text.count("?") != turn["metadata"]["content_draft"].count("?") for text, turn in zip(texts, assistants)),
    }
    if label != "control":
        judgments = []
        for offset in range(0, len(assistants), 10):
            batch = assistants[offset:offset + 10]
            raw = ai_app.llm([
                {
                    "role": "system",
                    "content": """Independently compare each content draft with its style rewrite. Be strict. Meaning is preserved only if technical claims, corrections, uncertainty, response purpose, and requested actions are unchanged. Question intent is preserved only if the rewrite asks for the same information without adding or removing a substantive request. Return JSON only.""",
                },
                {
                    "role": "user",
                    "content": json.dumps({"items": [
                        {"index": offset + index, "draft": turn["metadata"]["content_draft"], "rewrite": turn["content"]}
                        for index, turn in enumerate(batch)
                    ], "output_schema": {"results": [{"index": 0, "meaning_preserved": True, "question_intent_preserved": True, "added_or_removed_request": False, "reason": "short reason"}]}}, ensure_ascii=False),
                },
            ], json_mode=True, model=ai_app.GATE_MODEL)
            judgments.extend(json.loads(raw).get("results", []))
        item["independent_judge"] = {
            "meaning_preserved": sum(result.get("meaning_preserved") is True for result in judgments),
            "question_intent_preserved": sum(result.get("question_intent_preserved") is True for result in judgments),
            "added_or_removed_request": sum(result.get("added_or_removed_request") is True for result in judgments),
            "failures": [result for result in judgments if result.get("meaning_preserved") is not True or result.get("question_intent_preserved") is not True],
        }
    summary[label] = item

(RESULTS / "post-style-comparison.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False))
print(json.dumps(summary, indent=2, ensure_ascii=False))
