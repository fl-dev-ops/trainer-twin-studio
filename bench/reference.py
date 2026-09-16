"""Reference transcripts: the trainer's real recorded sessions.

bench/reference/vasanth/*.yaml (copied from the cleaned transcript corpus)
ground both sides of the simulation:

- the learner side: real candidates' answers serve as reference/ground for
  how the synthetic learner responds to Vasanth (learners.py),
- later fidelity scoring compares simulated interviews against these.

Read-only; no DB, no bridge.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import yaml

REFERENCE_DIR = Path(__file__).resolve().parent / "reference" / "vasanth"
MAX_REFERENCE_EXCHANGES = 4
EXCHANGE_CHAR_LIMIT = 700


@lru_cache(maxsize=1)
def load_reference_transcripts() -> dict[str, dict]:
    """Parse every reference YAML once; keyed by filename (e.g. "01.yaml")."""
    transcripts: dict[str, dict] = {}
    for path in sorted(REFERENCE_DIR.glob("*.yaml")):
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except Exception as error:  # keep the bench alive if one file is malformed
            print(f"Warning: skipping unreadable reference {path.name}: {error}")
            continue
        participants = data.get("participants") if isinstance(data.get("participants"), dict) else {}
        turns = []
        for turn in data.get("turns") or []:
            if isinstance(turn, dict) and isinstance(turn.get("text"), str) and turn.get("role") in ("interviewer", "candidate"):
                turns.append({"role": turn["role"], "text": turn["text"].strip()})
        transcripts[path.name] = {
            "id": data.get("id") or path.stem,
            "title": data.get("title") or path.stem,
            "interviewer": participants.get("interviewer") or "Vasanth",
            "candidate": participants.get("candidate") or "candidate",
            "seniority": data.get("seniority"),
            "topics": data.get("topics") or [],
            "turns": turns,
        }
    return transcripts


def candidate_reference_exchanges(source: str) -> list[tuple[str, str]]:
    """Real interviewer -> candidate exchanges from one reference transcript.

    Returns at most MAX_REFERENCE_EXCHANGES pairs; each side is bounded so the
    learner prompt stays small. The candidate text is verbatim — this is the
    reference/ground for how real candidates answer Vasanth.
    """
    transcript = load_reference_transcripts().get(source)
    if not transcript:
        return []
    pairs: list[tuple[str, str]] = []
    interviewer_text: str | None = None
    for turn in transcript["turns"]:
        if turn["role"] == "interviewer":
            interviewer_text = turn["text"]
        elif turn["role"] == "candidate" and interviewer_text:
            candidate_text = _bound(turn["text"], EXCHANGE_CHAR_LIMIT // 2)
            pairs.append((_bound(interviewer_text, EXCHANGE_CHAR_LIMIT // 2), candidate_text))
            interviewer_text = None
            if len(pairs) >= MAX_REFERENCE_EXCHANGES:
                break
    return pairs


def _bound(text: str, limit: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit] + "… [truncated]"


def reference_block(source: str) -> str:
    """Bounded learner-grounding block for one reference transcript."""
    transcript = load_reference_transcripts().get(source)
    if not transcript:
        return ""
    pairs = candidate_reference_exchanges(source)
    if not pairs:
        return ""
    lines = [
        "REFERENCE EXCHANGES — how the real candidate historically responded to this",
        "trainer. Match the register, length, and confidence; do not copy wording.",
    ]
    for interviewer_text, candidate_text in pairs:
        lines.append(f"Trainer: {interviewer_text}")
        lines.append(f"Candidate: {candidate_text}")
    return "\n".join(lines)
