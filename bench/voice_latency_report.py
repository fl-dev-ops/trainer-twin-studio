"""Summarize structured [voice-latency] agent logs.

Usage:
  uv run python voice_latency_report.py agent.log --label baseline-v1
  docker service logs trainertwin-agent_agent 2>&1 | uv run python voice_latency_report.py -
  uv run python voice_latency_report.py agent.log eve.log --label eve-gemini-v1   # + Eve [brain-trace]
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

MARKER = "[voice-latency] "
RUNTIME_MARKER = "[runtime-latency] "
BRAIN_MARKER = "[brain-trace] "
METRICS = (
    "transcriptionDelayMs",
    "endOfTurnDelayMs",
    "userTurnCallbackDelayMs",
    "llmTtftMs",
    "ttsTtfbMs",
    "playbackLatencyMs",
    "e2eLatencyMs",
)
REQUIRED_TURN_METRICS = (
    "transcriptionDelayMs",
    "endOfTurnDelayMs",
    "llmTtftMs",
    "ttsTtfbMs",
    "e2eLatencyMs",
)


def unwrap_log_line(line: str) -> str:
    """Eve's own dev log (chat/.eve/logs/dev-*.log) stores stdout as JSON lines with the message
    escaped inside "detail"; unwrap those so markers parse the same as plain terminal output."""
    stripped = line.strip()
    if stripped.startswith("{") and '"detail"' in stripped:
        try:
            record = json.loads(stripped)
        except json.JSONDecodeError:
            return line
        if isinstance(record, dict) and isinstance(record.get("detail"), str):
            return record["detail"]
    return line


def parse_marked(lines, marker: str) -> list[dict]:
    events = []
    decoder = json.JSONDecoder()
    for line in lines:
        line = unwrap_log_line(line)
        if marker not in line:
            continue
        try:
            event, _ = decoder.raw_decode(line.split(marker, 1)[1])
        except (json.JSONDecodeError, IndexError):
            continue
        if isinstance(event, dict):
            events.append(event)
    return events


def parse_events(lines) -> list[dict]:
    # The agent's logging config prints each record through several handlers; keep one per message.
    events, seen = [], set()
    for event in parse_marked(lines, MARKER):
        key = (event.get("sessionId"), event.get("messageId")) if event.get("messageId") else None
        if key is not None and key in seen:
            continue
        if key is not None:
            seen.add(key)
        events.append(event)
    return events


def parse_runtime_events(lines) -> list[dict]:
    return parse_marked(lines, RUNTIME_MARKER)


def parse_brain_traces(lines) -> list[dict]:
    return parse_marked(lines, BRAIN_MARKER)


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def brain_stage_values(trace: dict) -> dict[str, float]:
    """Flattens one Eve [brain-trace] turn into named stages: Eve overhead, every LLM call
    (decision = model-only time, tools = tools Eve ran inside that step), and every tool."""
    stages: dict[str, float] = {}
    for key, name in (("first_token_ttft_ms", "first_token_ttft"), ("total_turn_ms", "total_turn")):
        if number(trace.get(key)):
            stages[name] = trace[key]
    for name, value in (trace.get("eve_overhead_ms") or {}).items():
        if number(value):
            stages[f"eve_{name}"] = value
    steps = [step for step in trace.get("llm_steps") or [] if isinstance(step, dict) and number(step.get("stepIndex"))]
    if steps and number(steps[0].get("start_ms")):
        stages["before_first_llm_call"] = steps[0]["start_ms"]
    spoken = [int(step["stepIndex"]) for step in steps if step.get("spoke") or number(step.get("ttft_ms"))]
    if spoken:
        stages["calls_before_first_word"] = min(spoken)
    for step in steps:
        prefix = f"llm_call_{int(step['stepIndex'])}"
        for key, suffix in (("ttft_ms", "ttft"), ("decision_ms", "decision"), ("tools_ms", "tools"), ("duration_ms", "duration")):
            if number(step.get(key)):
                stages[f"{prefix}_{suffix}"] = step[key]
    for tool in trace.get("tools_executed") or []:
        if isinstance(tool, dict) and isinstance(tool.get("name"), str) and number(tool.get("duration_ms")):
            stages[f"tool_{tool['name']}"] = stages.get(f"tool_{tool['name']}", 0) + tool["duration_ms"]
    return stages


def distribution(values: list[float]) -> dict:
    return {
        "count": len(values),
        "p50": round(percentile(values, 0.50), 1),
        "p95": round(percentile(values, 0.95), 1),
        "max": round(max(values), 1),
    }


VOICE_TURN_FIELDS = (
    "transcriptionDelayMs",
    "endOfTurnDelayMs",
    "llmTtftMs",
    "ttsTtfbMs",
    "playbackLatencyMs",
    "e2eLatencyMs",
)


JOIN_SLACK_MS = 1000


def join_turns(events: list[dict], brain_traces: list[dict]) -> list[dict]:
    """One row per spoken trainer reply: voice-agent metrics joined to the Eve brain turn that
    produced it. LiveKit stamps a reply's createdAtMs when it starts generating, and Eve's turn
    starts a few ms later (same machine), so a reply maps to the first unclaimed brain turn that
    started within JOIN_SLACK_MS before createdAtMs and before the reply was logged."""
    traces_by_session: dict[str, list[dict]] = {}
    for trace in brain_traces:
        if number(trace.get("started_at_ms")) and trace.get("input_kind") != "tool_result":
            traces_by_session.setdefault(trace.get("sessionId"), []).append(trace)
    for traces in traces_by_session.values():
        traces.sort(key=lambda trace: trace["started_at_ms"])

    user_events = {
        (event.get("sessionId"), event.get("turnIndex")): event
        for event in events
        if event.get("role") == "user"
    }
    replies = sorted(
        (event for event in events if event.get("role") == "assistant"),
        key=lambda event: (event.get("sessionId") or "", event.get("createdAtMs") or 0),
    )
    claimed: set[int] = set()
    rows = []
    for reply in replies:
        session_id = reply.get("sessionId")
        created_at = reply.get("createdAtMs")
        logged_at = reply.get("loggedAtMs") or created_at
        user = user_events.get((session_id, reply.get("turnIndex")), {})
        row: dict = {"sessionId": session_id, "turnIndex": reply.get("turnIndex"), "interrupted": bool(reply.get("interrupted"))}
        for field in VOICE_TURN_FIELDS:
            source = user if field in ("transcriptionDelayMs", "endOfTurnDelayMs") else reply
            if number(source.get(field)):
                row[field] = source[field]
        brain = None
        if number(created_at):
            candidates = [
                trace
                for trace in traces_by_session.get(session_id, [])
                if created_at - JOIN_SLACK_MS <= trace["started_at_ms"] <= logged_at and id(trace) not in claimed
            ]
            brain = candidates[0] if candidates else None
        if brain is not None:
            claimed.add(id(brain))
            row["brainInputKind"] = brain.get("input_kind")
            row["brainStatus"] = brain.get("status")
            row["brainModel"] = brain.get("llm_model") or brain.get("model")
            row["brainTokens"] = {"prompt": brain.get("prompt_tokens"), "completion": brain.get("completion_tokens")}
            row["brainStagesMs"] = brain_stage_values(brain)
            if number(row.get("llmTtftMs")) and number(brain.get("first_token_ttft_ms")):
                # Voice agent's LLM TTFT minus Eve's own TTFT = HTTP/SSE transport between them.
                row["transportOverheadMs"] = round(row["llmTtftMs"] - brain["first_token_ttft_ms"], 1)
        rows.append(row)
    return rows


def summarize(
    events: list[dict],
    *,
    label: str,
    runtime_events: list[dict] | None = None,
    brain_traces: list[dict] | None = None,
) -> dict:
    runtime_events = runtime_events or []
    brain_traces = brain_traces or []
    distributions = {}
    for metric in METRICS:
        values = [event[metric] for event in events if isinstance(event.get(metric), (int, float))]
        if values:
            distributions[metric] = {
                "count": len(values),
                "min": round(min(values), 1),
                "p50": round(percentile(values, 0.50), 1),
                "p90": round(percentile(values, 0.90), 1),
                "p95": round(percentile(values, 0.95), 1),
                "max": round(max(values), 1),
            }

    sessions = sorted({event.get("sessionId") for event in events if event.get("sessionId")})
    turns = {
        (event.get("sessionId"), event.get("turnIndex"))
        for event in events
        if event.get("sessionId") and isinstance(event.get("turnIndex"), int) and event["turnIndex"] > 0
    }
    turn_metrics: dict[tuple[str, int], set[str]] = {turn: set() for turn in turns}
    for event in events:
        turn = (event.get("sessionId"), event.get("turnIndex"))
        if turn in turn_metrics:
            turn_metrics[turn].update(metric for metric in METRICS if isinstance(event.get(metric), (int, float)))
    incomplete_turns = [
        {
            "sessionId": session_id,
            "turnIndex": turn_index,
            "missingMetrics": [metric for metric in REQUIRED_TURN_METRICS if metric not in turn_metrics[turn]],
        }
        for turn in sorted(turn_metrics)
        for session_id, turn_index in (turn,)
        if any(metric not in turn_metrics[turn] for metric in REQUIRED_TURN_METRICS)
    ]
    providers = sorted({
        f"{event[prefix + 'Provider']}/{event[prefix + 'Model']}"
        for event in events
        for prefix in ("stt", "llm", "tts")
        if event.get(prefix + "Provider") and event.get(prefix + "Model")
    })
    runtime_stage_values: dict[str, list[float]] = {}
    for event in runtime_events:
        for stage in event.get("stages", []):
            if isinstance(stage, dict) and isinstance(stage.get("stage"), str) and isinstance(stage.get("ms"), (int, float)):
                runtime_stage_values.setdefault(stage["stage"], []).append(stage["ms"])
    runtime_stages = {
        stage: {
            "count": len(values),
            "p50": round(percentile(values, 0.50), 1),
            "p95": round(percentile(values, 0.95), 1),
            "max": round(max(values), 1),
        }
        for stage, values in sorted(runtime_stage_values.items())
    }
    brain_turns = []
    brain_values: dict[str, list[float]] = {}
    brain_ordinals: dict[str, int] = {}
    for trace in brain_traces:
        session_id = trace.get("sessionId")
        brain_ordinals[session_id] = brain_ordinals.get(session_id, 0) + 1
        stages = brain_stage_values(trace)
        clean = trace.get("status") in (None, "session.waiting", "session.completed")
        if clean:
            for stage, value in stages.items():
                brain_values.setdefault(stage, []).append(value)
        brain_turns.append({
            "sessionId": session_id,
            "brainTurn": brain_ordinals[session_id],
            "inputKind": trace.get("input_kind"),
            "status": trace.get("status"),
            "model": trace.get("llm_model") or trace.get("model"),
            "promptTokens": trace.get("prompt_tokens"),
            "completionTokens": trace.get("completion_tokens"),
            "stagesMs": stages,
        })
    brain_stages = {stage: distribution(values) for stage, values in sorted(brain_values.items())}

    joined = join_turns(events, brain_traces) if brain_traces else []
    clean_values: dict[str, list[float]] = {}
    for row in joined:
        if row["interrupted"] or "brainStagesMs" not in row or row.get("brainStatus") not in ("session.waiting", "session.completed"):
            continue
        for field in (*VOICE_TURN_FIELDS, "transportOverheadMs"):
            if number(row.get(field)):
                clean_values.setdefault(field, []).append(row[field])
        for stage, value in row["brainStagesMs"].items():
            clean_values.setdefault(f"brain.{stage}", []).append(value)
    turn_breakdown = {stage: distribution(values) for stage, values in sorted(clean_values.items())}
    return {
        "schemaVersion": 1,
        "kind": "voice-latency-report",
        "label": label,
        "createdAt": datetime.now(UTC).isoformat(),
        "sessions": sessions,
        "sessionCount": len(sessions),
        "turnCount": len(turns),
        "completeTurnCount": len(turns) - len(incomplete_turns),
        "incompleteTurns": incomplete_turns,
        "eventCount": len(events),
        "providers": providers,
        "metricsMs": distributions,
        "runtimeStagesMs": runtime_stages,
        "runtimeCompletions": runtime_events,
        "brainModels": sorted({trace.get("llm_model") or trace["model"] for trace in brain_traces if isinstance(trace.get("llm_model") or trace.get("model"), str)}),
        "brainStagesMs": brain_stages,
        "brainTurns": brain_turns,
        "joinedTurnCount": len(joined),
        "cleanJoinedTurnCount": len(clean_values.get("e2eLatencyMs", [])),
        "turnBreakdownMs": turn_breakdown,
        "turns": joined,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="+", help="Agent/web log files, or - for stdin")
    parser.add_argument("--label", default="baseline-v1")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    lines = list(sys.stdin) if args.input == ["-"] else [
        line
        for input_path in args.input
        for line in Path(input_path).read_text(encoding="utf-8").splitlines()
    ]
    events = parse_events(lines)
    runtime_events = parse_runtime_events(lines)
    brain_traces = parse_brain_traces(lines)
    if not events and not runtime_events and not brain_traces:
        raise SystemExit("No latency events found")

    report = summarize(events, label=args.label, runtime_events=runtime_events, brain_traces=brain_traces)
    rendered = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")


if __name__ == "__main__":
    main()
