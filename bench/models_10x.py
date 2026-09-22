"""Run 10 sessions per model, report performance + quality.

  cd bench && BENCH_MODELS="google/gemini-3.8-flash,alibaba/qwen3.8-27b" uv run python models_10x.py
"""

import json
import os
import statistics
import time
from pathlib import Path

from bridge import Bridge
from conf import AGENT_SLUG, PERSONA_SLUG, RESULTS_DIR
from models_ab import TEST_TURNS, TOOLS_SCHEMA

MODELS = [
    value.strip()
    for value in os.getenv(
        "BENCH_MODELS", "google/gemini-3.8-flash,alibaba/qwen3.8-27b"
    ).split(",")
    if value.strip()
]
SESSIONS_PER_MODEL = int(os.getenv("BENCH_SESSIONS", "10"))

JUDGE_MODEL = os.getenv("BENCH_EVALUATION_MODEL", "google/gemini-2.5-flash")


def run_session(model_name: str, idx: int) -> dict:
    bridge = Bridge(agent_slug=AGENT_SLUG, persona_slug=PERSONA_SLUG, model=model_name)
    turns = []
    for turn_num, user_text in enumerate(TEST_TURNS):
        is_opening = user_text == "session-start"
        try:
            response = bridge.send(user_text, tools=TOOLS_SCHEMA)
            turns.append({
                "turn": turn_num,
                "wall_ms": response["wall_ms"],
                "ttft_ms": response["ttft_ms"],
                "words": len(response["text"].split()),
                "tools": [t["name"] for t in response["tools_called"]],
                "text": response["text"],
            })
        except Exception as exc:
            turns.append({"turn": turn_num, "error": str(exc), "wall_ms": 0, "ttft_ms": 0, "words": 0, "tools": [], "text": ""})
        time.sleep(0.5)
    return {"model": model_name, "session_idx": idx, "session_id": bridge.session_id, "turns": turns}


def judge_quality(transcripts: list[dict]) -> dict:
    """Judge quality across all 10 transcripts for one model via the eval model."""
    import urllib.request

    # Load root .env.local for AI_GATEWAY_API_KEY if not in env
    key = os.getenv("AI_GATEWAY_API_KEY")
    if not key:
        root_env = Path(__file__).resolve().parents[1] / ".env.local"
        if root_env.exists():
            for line in root_env.read_text().splitlines():
                if line.startswith("AI_GATEWAY_API_KEY="):
                    key = line.split("=", 1)[1].strip()
                    break

    corpus = []
    for s in transcripts:
        convo = "\n".join(
            f"{'TRAINER' if t['turn'] != 0 or i == 0 else 'TRAINER(OPENING)'}: {t['text']}"
            for i, t in enumerate(s["turns"])
            if t.get("text")
        )
        corpus.append(f"--- Session {s['session_idx']} ---\n{convo}")

    prompt = f"""You are grading AI interview-trainer transcripts. Below are 10 sessions from the SAME model.
Grade each dimension 1-10 across ALL sessions (aggregate), with a one-line justification each.

Dimensions:
1. persona_fidelity: Does the trainer sound like a consistent human coach persona (warm, direct, uses learner name naturally)?
2. voice_modality: Are turns speakable aloud? (No markdown, no headings, no bullet lists, no "let me check the tool" narration, under ~80 words/turn)
3. question_quality: Are main questions specific, technical, and progressive (not generic)?
4. tool_discipline: Appropriate tool usage implied by flow (no narrating tool use, no referencing a missing checklist/artifact, no confusion)?
5. coaching_value: Actionable, evidence-grounded feedback vs generic praise?

Output STRICT JSON only:
{{"persona_fidelity": {{"score": n, "note": "..."}}, "voice_modality": {{"score": n, "note": "..."}}, "question_quality": {{"score": n, "note": "..."}}, "tool_discipline": {{"score": n, "note": "..."}}, "coaching_value": {{"score": n, "note": "..."}}}}

TRANSCRIPTS:
{chr(10).join(corpus)}"""

    try:
        req = urllib.request.Request(
            "https://ai-gateway.vercel.sh/v1/chat/completions",
            data=json.dumps({
                "model": JUDGE_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.2,
            }).encode(),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = json.loads(resp.read())
        text = body["choices"][0]["message"]["content"].strip()
        if text.startswith("```"):
            text = text.split("```", 2)[1].removeprefix("json")
        return json.loads(text)
    except Exception as exc:
        return {"error": str(exc)}


def main():
    all_results = {}
    for model in MODELS:
        sessions = []
        print(f"\n=== {model}: {SESSIONS_PER_MODEL} sessions ===")
        for i in range(SESSIONS_PER_MODEL):
            s = run_session(model, i)
            ok = [t for t in s["turns"] if t.get("wall_ms", 0) > 0]
            errors = [t for t in s["turns"] if t.get("error")]
            open_t = [t for t in ok if t["turn"] == 0]
            later = [t for t in ok if t["turn"] > 0]
            print(f"  s{i}: open_ttft={open_t[0]['ttft_ms'] if open_t else '-'}ms "
                  f"later_med_ttft={int(statistics.median([t['ttft_ms'] for t in later])) if later else '-'}ms "
                  f"errors={len(errors)}")
            sessions.append(s)

        valid_later_ttft = [t["ttft_ms"] for s in sessions for t in s["turns"][1:] if t.get("wall_ms", 0) > 0]
        valid_later_wall = [t["wall_ms"] for s in sessions for t in s["turns"][1:] if t.get("wall_ms", 0) > 0]
        opens = [s["turns"][0] for s in sessions if s["turns"][0].get("wall_ms", 0) > 0]
        all_tools = [t for s in sessions for turn in s["turns"] for t in turn.get("tools", [])]

        summary = {
            "model": model,
            "sessions": len(sessions),
            "errors_total": sum(1 for s in sessions for t in s["turns"] if t.get("error")),
            "opening_ttft_p50": int(statistics.median([t["ttft_ms"] for t in opens])) if opens else 0,
            "opening_ttft_p95": int(sorted(t["ttft_ms"] for t in opens)[int(len(opens) * 0.95) - 1]) if opens else 0,
            "opening_wall_p50": int(statistics.median([t["wall_ms"] for t in opens])) if opens else 0,
            "later_ttft_p50": int(statistics.median(valid_later_ttft)) if valid_later_ttft else 0,
            "later_ttft_p95": int(sorted(valid_later_ttft)[int(len(valid_later_ttft) * 0.95) - 1]) if valid_later_ttft else 0,
            "later_wall_p50": int(statistics.median(valid_later_wall)) if valid_later_wall else 0,
            "later_wall_p95": int(sorted(valid_later_wall)[int(len(valid_later_wall) * 0.95) - 1]) if valid_later_wall else 0,
            "tool_calls_total": len(all_tools),
            "session_plan_calls": all_tools.count("session_plan"),
        }
        print(f"  >> {json.dumps({k: v for k, v in summary.items()}, default=str)}")
        all_results[model] = {"summary": summary, "sessions": sessions}

    print("\nJudging quality (this takes a while)...")
    for model in MODELS:
        verdict = judge_quality(all_results[model]["sessions"])
        all_results[model]["quality"] = verdict
        print(f"\n=== QUALITY: {model} ===")
        print(json.dumps(verdict, indent=2))

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    out = RESULTS_DIR / f"models-10x-{int(time.time())}.json"
    out.write_text(json.dumps(all_results, indent=2) + "\n")
    print(f"\nSaved: {out}")


if __name__ == "__main__":
    main()
