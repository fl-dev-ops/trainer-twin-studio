#!/usr/bin/env python3
"""
Model Bake-off Benchmark for Eve Autonomous Brain.
Compares the models requested by the user:
- google/gemini-3.8-flash
- google/gemini-3.5-flash
- deepseek/deepseek-v4-flash-0731
- openai/gpt-5.6-luna
- z-ai/glm-5.3-flash
- openai/gpt-4.1-mini (baseline)

Measures:
1. Wall clock latency (ms) per turn
2. Tool calling execution (e.g. search_style)
3. Spoken word count (target < 50)
4. Persona output and quality
"""

import json
import os
import time
import urllib.request

STUDIO_URL = "http://localhost:2001/v1/chat/completions"
ORG_ID = "699ffaba-70fa-4fd1-a4ed-d80da8f06bff"
COPILOT_SECRET = "c67a0c2219ca04a134b1ff23e4b813d3a30f3c2600f695a327b64a30cd29ee9b"

import base64
B64_AUTH = base64.b64encode(f"{ORG_ID}:{COPILOT_SECRET}".encode()).decode()

MODELS_TO_TEST = [
    "openai/gpt-4.1-mini",
    "google/gemini-3.8-flash",
    "google/gemini-3.5-flash",
    "deepseek/deepseek-v4-flash-0731",
    "openai/gpt-5.6-luna",
    "z-ai/glm-5.3-flash",
]

# 3 standardized candidate turns to evaluate:
# Turn 1: Opening / greeting with candidate name intro
# Turn 2: Technical mechanism answer with metrics (triggers search_style)
# Turn 3: Edge case challenge / tool trigger
TEST_TURNS = [
    "Hi, I am ready to start. My name is Karthik.",
    "In my recent project, I redesigned our payments indexing layer in Postgres and reduced p99 query latency by 80 percent from 80ms to 16ms.",
    "Can you open the code editor so I can share our SQL schema and the index definition?"
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
                    "payload": {"type": "object"}
                },
                "required": ["action"]
            }
        }
    }
]

def run_model_test(model_name):
    session_id = f"model-test-{model_name.replace('/', '-')}-{int(time.time())}"
    headers = {
        "Authorization": f"Basic {B64_AUTH}",
        "x-trainertwin-org-id": ORG_ID,
        "x-trainertwin-session-id": session_id,
        "x-trainertwin-agent-slug": "impact-quantification",
        "x-trainertwin-persona-slug": "Vasanth",
        "x-trainertwin-mode": "voice",
        "content-type": "application/json"
    }

    print(f"\n=======================================================")
    print(f"TESTING MODEL: {model_name}")
    print(f"Session: {session_id}")
    print(f"=======================================================")

    history = []
    results = []

    for turn_num, user_text in enumerate(TEST_TURNS, 1):
        history.append({"role": "user", "content": user_text})
        payload = {
            "model": model_name,
            "stream": True,
            "tools": TOOLS_SCHEMA,
            "messages": history
        }

        req = urllib.request.Request(STUDIO_URL, data=json.dumps(payload).encode(), headers=headers)
        t0 = time.time()
        text = ""
        tools_called = []
        wall_ms = 0
        usage = {}

        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                for line in resp:
                    l = line.decode().strip()
                    if not l.startswith("data: ") or l == "data: [DONE]":
                        continue
                    chunk = json.loads(l[6:])
                    delta = chunk["choices"][0]["delta"]
                    if "content" in delta:
                        text += delta["content"]
                    if "tools_called" in chunk and chunk["tools_called"]:
                        tools_called = chunk["tools_called"]
                    if "wall_ms" in chunk:
                        wall_ms = chunk["wall_ms"]
                    if chunk.get("usage"):
                        usage = chunk["usage"]

            client_wall = int((time.time() - t0) * 1000)
            eff_wall = wall_ms if wall_ms > 0 else client_wall
            words = len(text.split())
            history.append({"role": "assistant", "content": text})

            tool_names = [t["name"] for t in tools_called]
            print(f"  Turn {turn_num}: {eff_wall}ms | words={words} | tools={tool_names}")
            print(f"    Text: {text[:100]}...")

            results.append({
                "turn": turn_num,
                "wall_ms": eff_wall,
                "words": words,
                "tools": tool_names,
                "text": text,
                "usage": usage
            })
            time.sleep(1.0)
        except Exception as e:
            print(f"  Turn {turn_num}: ERROR -> {e}")
            results.append({
                "turn": turn_num,
                "error": str(e),
                "wall_ms": 0,
                "words": 0,
                "tools": []
            })

    return {
        "model": model_name,
        "turns": results
    }

def main():
    scoreboard = []
    for m in MODELS_TO_TEST:
        res = run_model_test(m)
        valid_turns = [t for t in res["turns"] if t.get("wall_ms", 0) > 0]
        avg_lat = sum(t["wall_ms"] for t in valid_turns) / len(valid_turns) if valid_turns else 0
        scoreboard.append({
            "model": m,
            "avg_latency_ms": int(avg_lat),
            "turns": res["turns"]
        })

    print("\n" + "=" * 80)
    print("MODEL RESPONSE TIME SCOREBOARD")
    print("=" * 80)
    print(f"{'Model Name':<35} | {'Avg Latency':<12} | {'Turn 1':<10} | {'Turn 2':<10} | {'Turn 3':<10}")
    print("-" * 80)
    for s in scoreboard:
        t_lat = [f"{t.get('wall_ms', 0)}ms" if 'error' not in t else "ERR" for t in s["turns"]]
        while len(t_lat) < 3: t_lat.append("-")
        print(f"{s['model']:<35} | {s['avg_latency_ms']:>6} ms     | {t_lat[0]:<10} | {t_lat[1]:<10} | {t_lat[2]:<10}")
    print("=" * 80)

    # Save detailed traces
    out_file = "web/experiments/results/model-comparison-scoreboard.json"
    os.makedirs(os.path.dirname(out_file), exist_ok=True)
    with open(out_file, "w") as f:
        json.dump(scoreboard, f, indent=2)
    print(f"Saved full comparison traces to: {out_file}")

if __name__ == "__main__":
    main()
