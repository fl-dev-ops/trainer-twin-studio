"""Summarize structured [voice-latency] agent logs.

Usage:
  uv run python voice_latency_report.py agent.log --label baseline-v1
  docker service logs trainertwin-agent_agent 2>&1 | uv run python voice_latency_report.py -
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

MARKER = "[voice-latency] "
METRICS = (
    "transcriptionDelayMs",
    "endOfTurnDelayMs",
    "userTurnCallbackDelayMs",
    "llmTtftMs",
    "ttsTtfbMs",
    "playbackLatencyMs",
    "e2eLatencyMs",
)


def parse_events(lines) -> list[dict]:
    events = []
    decoder = json.JSONDecoder()
    for line in lines:
        if MARKER not in line:
            continue
        try:
            event, _ = decoder.raw_decode(line.split(MARKER, 1)[1])
        except (json.JSONDecodeError, IndexError):
            continue
        if isinstance(event, dict):
            events.append(event)
    return events


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def summarize(events: list[dict], *, label: str) -> dict:
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
    providers = sorted({
        f"{event[prefix + 'Provider']}/{event[prefix + 'Model']}"
        for event in events
        for prefix in ("stt", "llm", "tts")
        if event.get(prefix + "Provider") and event.get(prefix + "Model")
    })
    return {
        "schemaVersion": 1,
        "kind": "voice-latency-report",
        "label": label,
        "createdAt": datetime.now(UTC).isoformat(),
        "sessions": sessions,
        "sessionCount": len(sessions),
        "turnCount": len(turns),
        "eventCount": len(events),
        "providers": providers,
        "metricsMs": distributions,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="Agent log file, or - for stdin")
    parser.add_argument("--label", default="baseline-v1")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    if args.input == "-":
        events = parse_events(sys.stdin)
    else:
        with Path(args.input).open(encoding="utf-8") as source:
            events = parse_events(source)
    if not events:
        raise SystemExit("No [voice-latency] events found")

    rendered = json.dumps(summarize(events, label=args.label), indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")


if __name__ == "__main__":
    main()
