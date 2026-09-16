"""Run artifacts for bench simulations: crash-safe event log, readable
conversation transcript, and machine-readable summary.

Everything lands under bench/runs/<run_id>/ (gitignored):
  events.jsonl     one JSON object per line, chronological
  conversation.md  human-readable transcript with per-turn reviewer notes
  summary.json     run metadata, per-turn metrics, tool trace, flags
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path

import yaml

RUNS_DIR = Path(__file__).resolve().parent / "runs"
TOOL_OUTPUT_LIMIT = 2000

EVENT_TYPES = (
    "run.started",
    "turn.started",
    "learner.message",
    "tool.requested",
    "tool.completed",
    "tool.failed",
    "trainer.first_token",
    "trainer.response",
    "turn.completed",
    "run.completed",
)


def bound(value, limit: int = TOOL_OUTPUT_LIMIT):
    """Truncate oversized strings and mark the cut so logs stay bounded."""
    if isinstance(value, str) and len(value) > limit:
        return value[:limit] + "… [truncated]"
    return value


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


def run_id(prefix: str = "sim") -> str:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    token = hashlib.sha1(f"{stamp}{now_iso()}".encode()).hexdigest()[:6]
    return f"{stamp}-{prefix}-{token}"


def file_sha256(path: Path) -> str | None:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def git_commit() -> str | None:
    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, timeout=10, check=True
        ).stdout.strip()
    except Exception:
        return None


def git_dirty() -> bool | None:
    try:
        out = subprocess.run(
            ["git", "status", "--porcelain"], capture_output=True, text=True, timeout=10, check=True
        ).stdout
        return bool(out.strip())
    except Exception:
        return None


class RunTrace:
    """Collects one simulation run's events and writes the three artifacts."""

    def __init__(self, case: str, meta: dict, run_dir: Path | None = None, prefix: str = "sim"):
        self.run_id = run_id(prefix)
        self.run_dir = run_dir or (RUNS_DIR / self.run_id)
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.events_path = self.run_dir / "events.jsonl"
        self.meta = meta
        self.turns: list[dict] = []
        self.tool_calls: list[dict] = []
        self.started_at = now_iso()
        self.event("run.started", case=case, meta=self.meta)

    # ---- event log -------------------------------------------------------

    def event(self, event_type: str, **data) -> None:
        if event_type not in EVENT_TYPES:
            raise ValueError(f"unknown event type: {event_type}")
        record = {"ts": now_iso(), "type": event_type}
        record.update({key: bound(value) for key, value in data.items() if value is not None})
        with self.events_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    # ---- turn bookkeeping ------------------------------------------------

    def start_turn(self, index: int, learner_text: str) -> None:
        self.event("turn.started", turn=index)
        self.event("learner.message", turn=index, role="learner", text=learner_text)

    def tool_requested(self, index: int, call: dict) -> dict:
        execution = "transport" if call.get("transport") else "internal"
        record = {
            "turn": index,
            "call_id": call.get("callId"),
            "name": call.get("name"),
            "input": call.get("input"),
            "execution": execution,
            "status": "requested",
        }
        self.tool_calls.append(record)
        self.event(
            "tool.requested", turn=index, call_id=call.get("callId"), name=call.get("name"),
            input=call.get("input"), execution=execution,
        )
        return record

    def tool_completed(self, index: int, call_id: str, name: str, result: dict | None,
                       latency_ms: int | None, error: str | None = None, status: str | None = None) -> None:
        final_status = status or ("failed" if error else "completed")
        for record in self.tool_calls:
            if record.get("call_id") == call_id and record.get("status") == "requested":
                record["status"] = final_status
                record["latency_ms"] = latency_ms
                record["result"] = result
                record["error"] = error
        self.event(
            "tool.failed" if error else "tool.completed",
            turn=index, call_id=call_id, name=name,
            result=result, latency_ms=latency_ms, error=error,
        )

    def tool_unobserved(self, index: int, call_id: str, name: str, note: str) -> None:
        """Internal tools execute inside eve; their results are not observable from the OpenAI stream."""
        self.tool_completed(index, call_id, name, None, None, error=note, status="unobservable")

    def finish_turn(self, turn: dict) -> None:
        self.turns.append(turn)
        self.event("trainer.response", turn=turn["turn"], role="trainer", text=turn["trainer"])
        self.event(
            "turn.completed", turn=turn["turn"],
            wall_ms=turn["wall_ms"], ttft_ms=turn["ttft_ms"], words=turn["words"],
            tools=[call.get("name") for call in turn["tool_calls"]],
            flags=turn["flags"],
        )

    # ---- artifacts -------------------------------------------------------

    def conversation_yaml(self) -> dict:
        """Reference-transcript-style YAML (interviewer/candidate roles).

        Mirrors ../../vasanth/data/transcripts/clean/*.yaml: `turns` strictly
        alternate interviewer -> candidate and the interviewer always opens.
        Each recorded exchange contributes candidate text then interviewer
        text, except the opening turn where the agent speaks first.
        """
        started = datetime.fromisoformat(self.started_at)
        turns = []
        for turn in self.turns:
            elapsed = (datetime.fromisoformat(turn["ts"]) - started).total_seconds()
            stamp = f"{int(elapsed // 3600):02d}:{int(elapsed % 3600 // 60):02d}:{int(elapsed % 60):02d}"
            if turns:  # candidate replies to the previous interviewer turn
                turns.append({"t": stamp, "role": "candidate", "text": turn["learner"]})
            entry = {
                "t": stamp,
                "role": "interviewer",
                "text": turn["trainer"],
                "ttft_ms": turn["ttft_ms"],
                "wall_ms": turn["wall_ms"],
            }
            if turn["tool_calls"]:
                entry["tools"] = [
                    {
                        "name": call["name"],
                        "execution": call.get("execution"),
                        "status": call.get("status"),
                        "latency_ms": call.get("latency_ms"),
                        **({"result": _bound_result(call.get("result"))} if call.get("result") is not None else {}),
                    }
                    for call in turn["tool_calls"]
                ]
            if turn["flags"]:
                entry["flags"] = turn["flags"]
            turns.append(entry)
        if not turns:
            raise RuntimeError("agent must always take the first turn")
        return {
            "id": self.run_id,
            "started": self.started_at,
            "scenario": self.meta.get("case"),
            "session_id": self.meta.get("session_id"),
            "agent_slug": self.meta.get("agent_slug"),
            "persona": self.meta.get("persona_slug"),
            "candidate": self.meta.get("learner"),
            "model": self.meta.get("model"),
            "prompt_sha256": self.summary().get("prompt_sha256"),
            "git_commit": self.summary().get("git_commit"),
            "counts": {"turns": len(turns)},
            "invariants": [
                "Agent (interviewer) always takes the first turn.",
                "Turns strictly alternate interviewer -> candidate.",
            ],
            "turns": turns,
        }

    def conversation_markdown(self) -> str:
        lines = [
            f"# Conversation — {self.run_id}",
            "",
            f"Started: {self.started_at}",
            "",
            "Review each turn and write findings under **Notes**. Confirmed findings",
            "become deterministic assertions or DeepEval cases later.",
            "",
        ]
        for turn in self.turns:
            lines.append(f"## Turn {turn['turn']} — {turn['ts']}")
            lines.append("")
            lines.append("**Learner**")
            lines.append(turn["learner"])
            lines.append("")
            lines.append("**Tools**")
            if turn["tool_calls"]:
                for call in turn["tool_calls"]:
                    latency = f"{call.get('latency_ms')} ms" if call.get("latency_ms") is not None else "latency n/a"
                    lines.append(f"- `{call['name']}` — {latency} — {call.get('status')} — {call.get('execution')}")
            else:
                lines.append("- none")
            lines.append("")
            lines.append(
                f"**Trainer — TTFT {turn['ttft_ms']} ms · Total {turn['wall_ms']} ms · {turn['words']} words**"
            )
            lines.append(turn["trainer"])
            lines.append("")
            if turn["flags"]:
                lines.append(f"Mechanical flags: {', '.join(turn['flags'])}")
                lines.append("")
            lines.append("**Notes:**")
            lines.append("")
            lines.append("")
        return "\n".join(lines)

    def summary(self) -> dict:
        tool_counts: dict[str, int] = {}
        for call in self.tool_calls:
            tool_counts[call["name"]] = tool_counts.get(call["name"], 0) + 1
        return {
            "run_id": self.run_id,
            "created_at": self.started_at,
            "git_commit": git_commit(),
            "git_dirty": git_dirty(),
            "prompt_sha256": file_sha256(Path(__file__).resolve().parents[1] / "chat" / "agent" / "instructions.md"),
            **self.meta,
            "turns_completed": len(self.turns),
            "median_wall_ms": _median([turn["wall_ms"] for turn in self.turns]),
            "median_ttft_ms": _median([turn["ttft_ms"] for turn in self.turns]),
            "avg_words": _mean([turn["words"] for turn in self.turns]),
            "tool_counts": tool_counts,
            "tool_calls_completed": sum(1 for c in self.tool_calls if c.get("status") == "completed"),
            "tool_calls_failed": sum(1 for c in self.tool_calls if c.get("status") == "failed"),
            "tool_calls_unresolved": sum(1 for c in self.tool_calls if c.get("status") == "requested"),
            "token_usage": _sum_usage(self.turns),
            "flagged_turns": [turn["turn"] for turn in self.turns if turn["flags"]],
        }

    def finish(self) -> Path:
        self.event("run.completed", turns=len(self.turns))
        yaml_text = yaml.safe_dump(
            self.conversation_yaml(), allow_unicode=True, sort_keys=False, width=100
        )
        (self.run_dir / "conversation.yaml").write_text(yaml_text, encoding="utf-8")
        (self.run_dir / "conversation.md").write_text(self.conversation_markdown(), encoding="utf-8")
        (self.run_dir / "summary.json").write_text(
            json.dumps(self.summary(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        return self.run_dir


RESULT_CHAR_LIMIT = 500


def _bound_result(result) -> str:
    """Compact one-line tool result so transcripts stay readable."""
    try:
        text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)
    except TypeError:
        text = str(result)
    text = " ".join(text.split())
    return text if len(text) <= RESULT_CHAR_LIMIT else text[:RESULT_CHAR_LIMIT] + "… [truncated]"


def _median(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    middle = len(ordered) // 2
    return ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2


def _mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _sum_usage(turns: list[dict]) -> dict:
    total = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    for turn in turns:
        usage = turn.get("usage") or {}
        for key in total:
            total[key] += usage.get(key) or 0
    return total
