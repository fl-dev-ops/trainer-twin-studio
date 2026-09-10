import re
from statistics import median

FILLERS = re.compile(
    r"\b(got it|good, good|correct\?|okay\?|ok\?|wonderful|no problem|sure, sure|true, true)\b",
    re.I,
)
LABEL_LEAK = re.compile(r"explain [a-z]+(?: [a-z]+)? in your own words", re.I)


def conversation_likeness(turns: list[dict]) -> dict:
    assistant = [turn.get("content") or "" for turn in turns if turn.get("role") == "assistant"]
    learner = [turn.get("content") or "" for turn in turns if turn.get("role") == "user"]
    if not assistant:
        return {"filler_rate": 0, "median_words": 0, "restate_rate": 0, "label_leaks": 0}
    filler_rate = sum(1 for text in assistant if FILLERS.search(text)) / len(assistant)
    median_words = median(len(text.split()) for text in assistant)
    restated = 0
    for index, text in enumerate(assistant):
        if index == 0 or index > len(learner):
            continue
        prev = learner[index - 1].lower()
        tokens = [word for word in re.findall(r"[a-z]{4,}", prev) if word not in {"that", "this", "with", "have", "from"}]
        if tokens and any(token in text.lower() for token in tokens[:8]):
            restated += 1
    restate_rate = restated / max(1, len(assistant) - 1)
    label_leaks = sum(1 for text in assistant if LABEL_LEAK.search(text) or re.search(r"\b[a-z]+_[a-z]+\b", text))
    return {
        "filler_rate": filler_rate,
        "median_words": median_words,
        "restate_rate": restate_rate,
        "label_leaks": label_leaks,
    }


def conversation_quality_issues(turns: list[dict]) -> list[str]:
    issues: list[str] = []
    learner = "\n".join(turn["content"] for turn in turns if turn.get("role") == "user")
    assistant = [turn for turn in turns if turn.get("role") == "assistant"]
    pending = assistant[0]["content"] if assistant else ""
    for index, turn in enumerate(assistant):
        text = turn.get("content") or ""
        if text.count("?") > 1:
            issues.append("multiple questions")
        if re.search(r"\b(?:and|including)\b[^?]{0,80}\b(?:how|what|why|which)\b", text, re.I) and "?" in text:
            issues.append("stacked questions")
        for match in re.finditer(r"you mentioned ([^?.!]{3,80})", text, re.I):
            claimed = match.group(1).strip().lower()
            if claimed and claimed not in learner.lower():
                issues.append("invented mention")
        if index > 0:
            previous_user = next(
                (item.get("content") or "" for item in reversed(turns[: turns.index(turn)]) if item.get("role") == "user"),
                "",
            )
            if re.search(r"repeat|speak slower|are you there", previous_user, re.I):
                if pending and pending.split("?")[0] not in text:
                    issues.append("repeat lost the pending question")
            elif text.strip() == pending.strip() and previous_user:
                issues.append("duplicate question after an answer")
    if assistant and not re.search(r"we.?ll stop here|conclude here", assistant[-1]["content"], re.I) and len(assistant) > 20:
        issues.append("did not close")
    return list(dict.fromkeys(issues))
