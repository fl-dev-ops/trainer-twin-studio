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
        "openai/gpt-4.1-mini,google/gemini-3.8-flash,google/gemini-3.5-flash,"
        "deepseek/deepseek-v4-flash-0731,openai/gpt-5.6-luna,z-ai/glm-5.3-flash",
    ).split(",")
    if value.strip()
]

# 3 standardized candidate turns:
# Turn 1: Opening / greeting with candidate name intro
# Turn 2: Technical mechanism answer with metrics (triggers search_style)
# Turn 3: Edge case challenge / tool trigger
TEST_TURNS = [
    "Hi, I am ready to start. My name is Karthik.",
    "In my recent project, I redesigned our payments indexing layer in Postgres and reduced p99 query latency by 80 percent from 80ms to 16ms.",
    "Can you open the code editor so I can share our SQL schema and the index definition?",
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
    for turn_num, user_text in enumerate(TEST_TURNS, 1):
        try:
            response = bridge.send(user_text, tools=TOOLS_SCHEMA)
            text = response["text"]
            tool_names = [t["name"] for t in response["tools_called"]]
            print(f"  Turn {turn_num}: {response['wall_ms']}ms | words={len(text.split())} | tools={tool_names}")
            print(f"    Text: {text[:100]}...")
            results.append({
                "turn": turn_num,
                "wall_ms": response["wall_ms"],
                "words": len(text.split()),
                "tools": tool_names,
                "text": text,
                "usage": response["usage"],
            })
            time.sleep(1.0)
        except Exception as exc:
            print(f"  Turn {turn_num}: ERROR -> {exc}")
            results.append({"turn": turn_num, "error": str(exc), "wall_ms": 0, "words": 0, "tools": []})

    return {"model": model_name, "session_id": bridge.session_id, "turns": results}


def main():
    scoreboard = []
    for model_name in MODELS_TO_TEST:
        result = run_model_test(model_name)
        valid_turns = [t for t in result["turns"] if t.get("wall_ms", 0) > 0]
        avg_lat = sum(t["wall_ms"] for t in valid_turns) / len(valid_turns) if valid_turns else 0
        scoreboard.append({"model": model_name, "avg_latency_ms": int(avg_lat), "turns": result["turns"]})

    print("\n" + "=" * 80)
    print("MODEL RESPONSE TIME SCOREBOARD")
    print(f"{'Model Name':<35} | {'Avg Latency':<12} | {'Turn 1':<10} | {'Turn 2':<10} | {'Turn 3':<10}")
    print("-" * 80)
    for entry in scoreboard:
        lat = [f"{t.get('wall_ms', 0)}ms" if "error" not in t else "ERR" for t in entry["turns"]]
        while len(lat) < 3:
            lat.append("-")
        print(f"{entry['model']:<35} | {entry['avg_latency_ms']:>6} ms     | {lat[0]:<10} | {lat[1]:<10} | {lat[2]:<10}")
    print("=" * 80)

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    out_file = RESULTS_DIR / f"model-comparison-{int(time.time())}.json"
    out_file.write_text(json.dumps(scoreboard, indent=2) + "\n")
    print(f"Saved full comparison traces to: {out_file}")


if __name__ == "__main__":
    main()
