"""Parallel 5-session benchmark for mixed interview round (depth-reasoning-application).

Evaluates whether the agent:
1. Asks the configured question types (verbal, mcq, coding, code-output, system-design)
2. Opens the appropriate workspace surfaces (open_whiteboard, open_code_editor)
3. Tracks session progress via session_plan across turns
4. Respects turn limits and quotas (up to 30 turns max)

Runs 5 concurrent sessions in parallel using ThreadPoolExecutor.
"""

import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

from bridge import Bridge
from conf import RESULTS_DIR
from simulate import OpenRouterLLM

SCENARIO_SLUG = "depth-reasoning-application"
PERSONA_SLUG = "Vasanth"
MAX_TURNS = 30
CONCURRENCY = 5

CANDIDATES = [
    {"name": "Karthik", "role": "Frontend / React Engineer (5 YoE)", "focus": "React performance, virtual DOM, hooks"},
    {"name": "Anubhav", "role": "Full-Stack Node.js Developer (4 YoE)", "focus": "Node.js event loop, APIs, Postgres"},
    {"name": "Vinay", "role": "Distributed Systems Engineer (5 YoE)", "focus": "System architecture, caching, queues"},
    {"name": "Priya", "role": "Frontend Performance Specialist (4 YoE)", "focus": "Web Vitals, code splitting, asset loading"},
    {"name": "Deepak", "role": "Full-Stack Product Engineer (5 YoE)", "focus": "State management, component design, microfrontends"},
]

def classify_question(text: str) -> list[str]:
    """Identify which question types or features are present in the trainer text."""
    types = []
    lower = text.lower()
    if re.search(r"\b(option\s+[a-d]|which of the following|multiple choice|\ba\)|\[a\])\b", lower):
        types.append("mcq")
    if re.search(r"\b(write a function|implement|code a|write code|in the editor|write a polyfill|coding problem)\b", lower):
        types.append("coding")
    if re.search(r"\b(what (is|would be) the output|predict the output|what does this (print|log|return)|snippet)\b", lower):
        types.append("code-output")
    if re.search(r"\b(architecture|whiteboard|system design|design a|high-level design|sketch|microservice|data flow)\b", lower):
        types.append("system-design")
    if re.search(r"\b(explain|how does|what is the mechanism|why would you|difference between|trade-off|under the hood)\b", lower):
        types.append("verbal")
    return types or ["general"]

def generate_candidate_reply(llm: OpenRouterLLM, name: str, focus: str, trainer_speech: str) -> str:
    prompt = f"""You are {name}, a candidate with focus in {focus}, in a technical interview with an expert interviewer.
Interviewer just said:
"{trainer_speech}"

Reply naturally, conversationally, and concisely (under 35 words) as {name}:
- If asked an MCQ, state your chosen option and a one-sentence reason.
- If asked a coding task, say you will write the implementation and mention your approach.
- If asked about architecture or whiteboard, outline the main components and flow.
- If asked a conceptual question, give a clear technical explanation.
- If the interviewer wraps up or says goodbye, thank them.
Do NOT speak as an AI. Answer directly as {name}."""
    try:
        reply = llm.generate(prompt)
        return str(reply).strip()
    except Exception as e:
        return "Understood. I would approach this by breaking the problem down and analyzing the key trade-offs."

def run_single_simulation(candidate: dict, index: int) -> dict:
    name = candidate["name"]
    session_id = f"bench-mixed-{name.lower()}-{int(time.time())}"
    print(f"[{name}] Starting session {session_id} on {SCENARIO_SLUG}...")

    bridge = Bridge(
        session_id=session_id,
        agent_slug=SCENARIO_SLUG,
        persona_slug=PERSONA_SLUG,
    )
    llm = OpenRouterLLM(os.getenv("BENCH_EVALUATION_MODEL", "google/gemini-2.5-flash"))

    history = []
    tool_counts: dict[str, int] = {}
    surface_actions: list[str] = []
    plan_actions: list[dict] = []
    question_types_detected: set[str] = set()
    session_completed = False

    # Opening turn
    opening_text = bridge.open_session()
    print(f"[{name}] Turn 0 (OPENING): {opening_text[:80]}...")
    history.append({"turn": 0, "speaker": "TRAINER", "text": opening_text, "tools": []})

    current_reply = f"Hi Vasanth, my name is {name}. Glad to be here and ready for the interview."

    for turn_num in range(1, MAX_TURNS + 1):
        # Learner turn
        history.append({"turn": turn_num, "speaker": "LEARNER", "text": current_reply})

        # Send to bridge with advertised tools
        res = bridge.send(current_reply, tools=[
            {"type": "function", "function": {"name": "surface", "parameters": {"type": "object", "properties": {"action": {"type": "string"}, "payload": {"type": "object"}}}}},
            {"type": "function", "function": {"name": "finish_session", "parameters": {"type": "object", "properties": {}}}},
        ])

        trainer_text = res.get("text", "")
        tools_called = res.get("tools_called", [])

        # Process tool calls
        for call in tools_called:
            t_name = call.get("name", "unknown")
            tool_counts[t_name] = tool_counts.get(t_name, 0) + 1
            if t_name == "surface":
                act = call.get("input", {}).get("action")
                if act:
                    surface_actions.append(act)
            elif t_name == "session_plan":
                plan_actions.append(call.get("input", {}))
            elif t_name == "finish_session":
                session_completed = True

        q_types = classify_question(trainer_text)
        for qt in q_types:
            question_types_detected.add(qt)

        history.append({
            "turn": turn_num,
            "speaker": "TRAINER",
            "text": trainer_text,
            "tools": tools_called,
            "types": q_types,
        })

        print(f"[{name}] Turn {turn_num}: tools={[t.get('name') for t in tools_called]} | text: {trainer_text[:70]}...")

        if session_completed or "wrap up" in trainer_text.lower() or "end of our session" in trainer_text.lower():
            print(f"[{name}] Session completed at turn {turn_num}!")
            break

        # Generate candidate answer for next turn
        current_reply = generate_candidate_reply(llm, name, candidate["focus"], trainer_text)

    return {
        "candidate": name,
        "sessionId": session_id,
        "turnsCompleted": len([h for h in history if h["speaker"] == "TRAINER"]),
        "sessionCompletedNaturally": session_completed,
        "toolCounts": tool_counts,
        "surfaceActions": surface_actions,
        "planActionsCount": len(plan_actions),
        "planActions": plan_actions,
        "questionTypesDetected": list(question_types_detected),
        "transcript": history,
    }

def main():
    print("=" * 80)
    print(f"STARTING 5-SESSION CONCURRENT BENCHMARK — {SCENARIO_SLUG.upper()}")
    print(f"Concurrency: {CONCURRENCY} parallel sessions | Max turns: {MAX_TURNS}")
    print("=" * 80)

    start_time = time.time()
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as executor:
        futures = [
            executor.submit(run_single_simulation, cand, i)
            for i, cand in enumerate(CANDIDATES[:CONCURRENCY])
        ]
        results = [f.result() for f in futures]

    elapsed = time.time() - start_time
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    report_file = RESULTS_DIR / f"mixed-round-benchmark-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    with open(report_file, "w") as f:
        json.dump({"results": results, "elapsed_seconds": elapsed}, f, indent=2)

    print("\n" + "=" * 80)
    print("                 PARALLEL BENCHMARK RESULTS SUMMARY                   ")
    print("=" * 80)
    print(f"Total Elapsed Time: {elapsed:.2f}s ({elapsed / CONCURRENCY:.2f}s avg/session concurrent)\n")

    for r in results:
        print(f"Candidate: {r['candidate']}")
        print(f"  Turns completed:       {r['turnsCompleted']}")
        print(f"  Natural completion:    {r['sessionCompletedNaturally']}")
        print(f"  Tools called:          {r['toolCounts']}")
        print(f"  Surfaces opened:       {r['surfaceActions']}")
        print(f"  session_plan updates:  {r['planActionsCount']}")
        print(f"  Question types found:  {', '.join(r['questionTypesDetected'])}")
        print("-" * 60)

    # Aggregates
    total_turns = sum(r["turnsCompleted"] for r in results)
    all_tools = {}
    all_surfaces = {}
    all_qtypes = set()
    for r in results:
        for t, c in r["toolCounts"].items():
            all_tools[t] = all_tools.get(t, 0) + c
        for s in r["surfaceActions"]:
            all_surfaces[s] = all_surfaces.get(s, 0) + 1
        for qt in r["questionTypesDetected"]:
            all_qtypes.add(qt)

    print("\nAGGREGATE METRICS ACROSS ALL 5 SESSIONS:")
    print(f"  Total Turns Simulated:     {total_turns}")
    print(f"  All Tool Calls:            {all_tools}")
    print(f"  Surfaces Opened:           {all_surfaces}")
    print(f"  Question Types Detected:   {', '.join(sorted(all_qtypes))}")
    print(f"  Detailed Report Saved To:  {report_file}")
    print("=" * 80)

if __name__ == "__main__":
    main()
