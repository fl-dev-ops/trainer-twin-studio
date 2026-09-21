"""Model bake-off: run standardized turns against the bridge, one session per
model, and compare wall latency / word count / tool usage.

  cd bench && uv run python models_ab.py
  BENCH_MODELS="openai/gpt-4.1-mini,google/gemini-3.8-flash" uv run python models_ab.py
"""

import json
import os
import time

from bridge import Bridge
from conf import AGENT_SLUG, PERSONA_SLUG, RESULTS_DIR

MODELS_TO_TEST = [
    value.strip()
    for value in os.getenv(
        "BENCH_MODELS",
        "google/gemini-3.8-flash,alibaba/qwen3.8-27b,openai/gpt-4.1-mini,"
        "openai/gpt-5-nano,google/gemini-2.5-flash-lite,deepseek/deepseek-v4-flash-0731",
    ).split(",")
    if value.strip()
]

# Turn 0 is the opening — trainer speaks first ("session-start" → [OPENING]).
# Turns 1-9 are learner responses.
TEST_TURNS = [
    "session-start",
    "Hi, I am Karthik. I have about 5 years of backend experience, mostly Go and distributed systems.",
    "In my recent project, I redesigned our payments indexing layer in Postgres and reduced p99 query latency by 80 percent from 80ms to 16ms.",
    "We used a composite partial B-tree index on user_id and created_at where status equals completed.",
    "I'm not sure what a covering index is, can you explain?",
    "For cache invalidation we used a write-through pattern with a 60-second TTL as a safety net.",
    "When Redis went down the app fell back to the database, but the latency spiked to 200ms.",
    "We considered using Kafka for event-driven invalidation but decided TTL was simpler.",
    "Our SLO was 99.95 percent availability with p99 under 50ms across payment endpoints.",
    "I think that covers the architecture. What should I focus on next?",
]

TOOLS_SCHEMA = [
    {
        "type": "function",
        "function": {
            "name": "surface",
            "description": "Open or close workspace surface",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string"},
                    "payload": {"type": "object"},
                },
                "required": ["action"],
            },
        },
    },
]


def run_model_test(model_name: str) -> dict:
    bridge = Bridge(agent_slug=AGENT_SLUG, persona_slug=PERSONA_SLUG, model=model_name)

    print("\n" + "=" * 55)
    print(f"TESTING MODEL: {model_name}")
    print(f"Session: {bridge.session_id}")
    print("=" * 55)

    results = []
    for turn_num, user_text in enumerate(TEST_TURNS):
        is_opening = user_text == "session-start"
        label = "Opening" if is_opening else f"Turn {turn_num}"
        try:
            response = bridge.send(user_text, tools=TOOLS_SCHEMA)
            text = response["text"]
            tool_names = [t["name"] for t in response["tools_called"]]
            ttft = response["ttft_ms"]
            wall = response["wall_ms"]
            print(f"  {label}: wall={wall}ms ttft={ttft}ms | words={len(text.split())} | tools={tool_names}")
            print(f"    Text: {text[:120]}...")
            results.append({
                "turn": turn_num,
                "label": label,
                "wall_ms": wall,
                "ttft_ms": ttft,
                "words": len(text.split()),
                "tools": tool_names,
                "text": text,
                "usage": response["usage"],
            })
            time.sleep(1.0)
        except Exception as exc:
            print(f"  {label}: ERROR -> {exc}")
            results.append({"turn": turn_num, "label": label, "error": str(exc), "wall_ms": 0, "ttft_ms": 0, "words": 0, "tools": []})

    return {"model": model_name, "session_id": bridge.session_id, "turns": results}


def main():
    import statistics
    scoreboard = []
    for model_name in MODELS_TO_TEST:
        result = run_model_test(model_name)
        valid_turns = [t for t in result["turns"] if t.get("wall_ms", 0) > 0]
        avg_lat = sum(t["wall_ms"] for t in valid_turns) / len(valid_turns) if valid_turns else 0
        opening = [t for t in valid_turns if t["label"] == "Opening"]
        later = [t for t in valid_turns if t["label"] != "Opening"]
        scoreboard.append({
            "model": model_name,
            "avg_latency_ms": int(avg_lat),
            "opening_wall_ms": opening[0]["wall_ms"] if opening else 0,
            "opening_ttft_ms": opening[0]["ttft_ms"] if opening else 0,
            "opening_words": opening[0]["words"] if opening else 0,
            "later_median_wall_ms": int(statistics.median([t["wall_ms"] for t in later])) if later else 0,
            "later_median_ttft_ms": int(statistics.median([t["ttft_ms"] for t in later])) if later else 0,
            "turns": result["turns"],
        })

    print("\n" + "=" * 120)
    print("MODEL FIRST-MESSAGE LATENCY SCOREBOARD (sorted by opening TTFT — time until learner hears first word)")
    print(f"{'Model':<35} | {'Open TTFT':>10} | {'Open Wall':>10} | {'Open Words':>10} | {'Later TTFT':>10} | {'Later Wall':>10}")
    print("-" * 120)
    for entry in sorted(scoreboard, key=lambda e: e["opening_ttft_ms"] or 999999):
        print(
            f"{entry['model']:<35} | {entry['opening_ttft_ms']:>7} ms | {entry['opening_wall_ms']:>7} ms | {entry['opening_words']:>7} w  | {entry['later_median_ttft_ms']:>7} ms | {entry['later_median_wall_ms']:>7} ms"
        )
    print("=" * 120)

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    out_file = RESULTS_DIR / f"model-comparison-{int(time.time())}.json"
    out_file.write_text(json.dumps(scoreboard, indent=2) + "\n")
    print(f"Saved full comparison traces to: {out_file}")


if __name__ == "__main__":
    main()
