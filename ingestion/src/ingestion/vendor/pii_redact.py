"""PII redaction for TrainerTwin transcripts: one LLM call per turn, then exact replacement in code.

How it works:
  1. qwen/qwen3.8-27b on OpenRouter reads ONE turn and returns the PII it sees as
     {"spans": [{"text": "<copied verbatim>", "label": "<type>"}]}.
  2. Code finds every exact occurrence of each span in the turn (longest first, no overlaps).
  3. Code replaces those character ranges with placeholders. The LLM never rewrites the transcript.

Lab result (synthetic held-out bench, 195 turns, 249 spans): end-to-end F1 0.99, 0.3% of PII
characters left visible, about $0.31 per 1,000 turns, about 0.4 s per turn.

Setup:  pip install requests      and set OPENROUTER_API_KEY in the environment (never log it).
"""
from __future__ import annotations

import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import requests

# ---------------------------------------------------------------- config (keep these as tested)
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
MODEL = "qwen/qwen3.8-27b"
PROVIDER = {"order": ["Cerebras"], "allow_fallbacks": False}  # the routing that was benchmarked
TEMPERATURE = 0.0
MAX_TOKENS = 2000  # local patch (was 600): a dense 114-word reference list (~30 names) hit the cap mid-JSON

LABELS = ["person", "organization", "location", "phone", "email", "url_handle", "money", "rate"]

# ---------------------------------------------------------------- the prompt (exactly as benchmarked)
SYSTEM_PROMPT = (
    "You find PII in one turn of a sales or fitness-trainer conversation. "
    "Speakers write Indian English, sometimes all lowercase.\n"
    "Entity types: person (a real person's name or nickname, also lowercase), "
    "organization (company, gym, brand, bank, app), location (city, country, area), "
    "phone (phone number as written, including brackets and country code), email, "
    "url_handle (social handle like @name or a web link), "
    "money (a currency amount as written, with symbol or unit words like rs, rupees, lakh, crore, dollars), "
    "rate (a percentage or interest rate, the number with its percent sign or unit words like per cent).\n"
    "Not PII: speaker role words (Customer, Rep, Coach, Trainer, Trainee, Owner, Caller), generic words, "
    "job titles, plain times and durations, plain numbers with no money or rate meaning."
    '\nReturn ONLY a JSON object, no other text: {"spans": [{"text": "exact text copied from the turn", '
    '"label": "type"}]}. Each distinct item once. Empty list if there is no PII.'
)


@dataclass
class Span:
    start: int
    end: int
    label: str
    text: str


class RedactionError(RuntimeError):
    """Raised when a turn could not be checked. Never store such a turn unredacted."""


# ---------------------------------------------------------------- step 1: detect (LLM)
def detect(turn: str, api_key: str | None = None, retries: int = 3, timeout: int = 60) -> list[dict]:
    """Ask the model for PII spans in one turn. Returns [{"text", "label"}]. Raises RedactionError."""
    key = api_key or os.environ["OPENROUTER_API_KEY"]
    body = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": "Turn:\n" + turn},
        ],
        "temperature": TEMPERATURE,
        "max_tokens": MAX_TOKENS,
        "reasoning": {"enabled": False},
        "provider": PROVIDER,
    }
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    last = None
    for attempt in range(retries):
        try:
            r = requests.post(OPENROUTER_URL, json=body, headers=headers, timeout=timeout)
            if r.status_code in (429, 500, 502, 503, 504):
                raise RuntimeError(f"HTTP {r.status_code}")
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"] or ""
            m = re.search(r"\{.*\}", content, re.S)
            obj = json.loads(m.group(0))
            # local patch: a bare {} (seen on heading-only document blocks) means no PII.
            spans = [] if obj == {} else obj["spans"]  # unparsable reply -> retry
            return [
                {"text": s["text"].strip(), "label": s["label"]}
                for s in spans
                if isinstance(s, dict) and s.get("label") in LABELS
                and isinstance(s.get("text"), str) and s["text"].strip()
            ]
        except Exception as e:  # network error, bad status, or unparsable JSON
            last = e
            time.sleep(2 * (attempt + 1))
    raise RedactionError(f"PII detection failed after {retries} tries: {type(last).__name__}")


# ---------------------------------------------------------------- step 2: locate (code)
def locate(turn: str, found: list[dict]) -> list[Span]:
    """Find every exact occurrence of each span text, longest first, skipping overlaps."""
    out: list[Span] = []
    for sp in sorted(found, key=lambda s: -len(s["text"])):
        for m in re.finditer(re.escape(sp["text"]), turn):
            if not any(c.start < m.end() and m.start() < c.end for c in out):
                out.append(Span(m.start(), m.end(), sp["label"], m.group(0)))
    return sorted(out, key=lambda s: s.start)


# ---------------------------------------------------------------- step 3: replace (code)
class Placeholders:
    """Same value -> same placeholder across a whole transcript, e.g. [PERSON_1], [PHONE_2]."""

    def __init__(self) -> None:
        self.map: dict[tuple[str, str], str] = {}
        self.count: dict[str, int] = {}

    def get(self, label: str, text: str) -> str:
        k = (label, text.lower())
        if k not in self.map:
            self.count[label] = self.count.get(label, 0) + 1
            self.map[k] = f"[{label.upper()}_{self.count[label]}]"
        return self.map[k]


def replace(turn: str, spans: list[Span], ph: Placeholders, keep: set[str] = frozenset()) -> str:
    """Swap spans for placeholders from right to left so offsets stay valid."""
    keep_l = {k.lower() for k in keep}
    out = turn
    for s in sorted(spans, key=lambda s: -s.start):
        if s.text.lower() in keep_l:
            continue
        out = out[: s.start] + ph.get(s.label, s.text) + out[s.end :]
    return out


# ---------------------------------------------------------------- public API
def redact_turn(turn: str, ph: Placeholders | None = None, keep: set[str] = frozenset()) -> tuple[str, list[Span]]:
    ph = ph or Placeholders()
    if not turn.strip():
        return turn, []
    spans = locate(turn, detect(turn))
    return replace(turn, spans, ph, keep), spans


def redact_transcript(turns: list[str], keep: set[str] = frozenset(), workers: int = 8):
    """Redact all turns of one transcript in parallel, with placeholders shared across turns.

    Returns (redacted_turns, spans_per_turn, mapping). The mapping holds real values,
    so store it encrypted and apart from the redacted text, or drop it.
    Raises RedactionError if any turn fails, so nothing unredacted gets through.
    """
    with ThreadPoolExecutor(workers) as ex:
        found = list(ex.map(lambda t: detect(t) if t.strip() else [], turns))
    ph = Placeholders()  # numbering done in turn order, so it is stable
    red, all_spans = [], []
    for t, f in zip(turns, found):
        spans = locate(t, f)
        red.append(replace(t, spans, ph, keep))
        all_spans.append(spans)
    return red, all_spans, dict(ph.map)


if __name__ == "__main__":
    demo = [
        "hi this is rahul from fitzone gym in pune, call me on +91 98765 43210",
        "Coach: the plan is rs 4,500 per month, or mail rahul.k@example.com, 12% off if yearly",
    ]
    red, spans, _ = redact_transcript(demo)
    for line in red:
        print(line)
