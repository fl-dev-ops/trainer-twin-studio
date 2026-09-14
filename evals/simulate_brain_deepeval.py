"""DeepEval 30-turn conversation simulation against TrainerTwin Autonomous Brain.

Uses deepeval.simulator.ConversationSimulator to generate realistic, imperfect,
dynamic candidate turns (not static strings) while testing the Brain's:
1. Phase-locked episode retrieval (sessionPhase)
2. Grounded past exchanges
3. Handling of false claims, hesitation, hints, and whiteboard/editor requests
"""

import json
import os
import time
import base64
import urllib.request
from copy import deepcopy
from pathlib import Path
from dotenv import load_dotenv

from deepeval.dataset import EvaluationDataset
from deepeval.dataset.golden import ConversationalGolden, Persona
from deepeval.models import OpenRouterModel
from deepeval.simulator import ConversationSimulator
from deepeval.simulator.simulation_graph import SimulationNode
from deepeval.test_case import Turn

load_dotenv("web/.env")

BRAIN_URL = os.environ.get("BRAIN_URL", "http://localhost:3100/v1/chat/completions")
SECRET = os.environ.get("COPILOT_SERVICE_SECRET", "c67a0c2219ca04a134b1ff23e4b813d3a30f3c2600f695a327b64a30cd29ee9b")
ORG_ID = "699ffaba-70fa-4fd1-a4ed-d80da8f06bff"
SESSION_ID = f"deepeval-sim-{int(time.time())}"

b64 = base64.b64encode(f"{ORG_ID}:{SECRET}".encode()).decode()
HEADERS = {
    "Authorization": f"Basic {b64}",
    "x-trainertwin-org-id": ORG_ID,
    "x-trainertwin-session-id": SESSION_ID,
    "x-trainertwin-agent-slug": "impact-quantification",
    "x-trainertwin-persona-slug": "Vasanth",
    "x-trainertwin-mode": "voice",
    "content-type": "application/json",
}

TOOLS = [
    {"type": "function", "function": {"name": "surface", "parameters": {"type": "object", "properties": {"action": {"type": "string"}}}}},
    {"type": "function", "function": {"name": "read_document", "parameters": {"type": "object", "properties": {"documentId": {"type": "string"}, "query": {"type": "string"}}}}},
    {"type": "function", "function": {"name": "search_style", "parameters": {"type": "object", "properties": {"personaSlug": {"type": "string"}, "query": {"type": "string"}, "sessionPhase": {"type": "string"}}}}},
    {"type": "function", "function": {"name": "finish_session", "parameters": {"type": "object", "properties": {}}}},
]

BASE_PERSONA = (
    "You are Karthik, a software engineer with 5 years of experience. You worked on a Redis caching "
    "layer for payments and a Kafka notification pipeline. English is not your first language. "
    "You get nervous in interviews. Speak conversationally as a real candidate: sometimes hesitant, "
    "sometimes making mistakes, self-correcting, or defending your design. Do NOT speak as an AI assistant. "
    "Keep answers natural, realistic, and strictly under 60 words."
)

BEHAVIOURS = [
    # 1-3: Icebreaker & Greeting
    "Greet Vasanth warmly, introduce yourself as Karthik. Admit you feel a bit nervous for the interview today.",
    "Respond to Vasanth's encouragement, take a deep breath, and say you are ready to begin.",
    "Give a brief high-level intro: you've been working on backend payments systems and distributed caching.",
    # 4-8: FinTech & Redis Caching
    "Explain your Redis caching project: you put Redis in front of PostgreSQL read replicas to reduce p99 latency.",
    "State your metrics: baseline p99 was 200ms, and Redis brought it down to 80ms, about a 40% reduction.",
    "Confidently but falsely claim that Redis TTL guarantees exactly-once processing for payment transactions.",
    "When challenged on that claim, defend it slightly, then pause and admit you might be mixing up idempotency and TTL.",
    "Explain the real idempotency mechanism: unique payment idempotency keys stored in Redis with atomic SETNX.",
    # 9-14: Cache Invalidation & Edge Cases
    "Explain cache invalidation: you used Kafka events to trigger cache eviction across Redis cluster nodes.",
    "Address what happens if Kafka is delayed: admit stale data could be served and explain how you'd handle financial discrepancies.",
    "Explain your Redis high availability setup: Redis Cluster with 3 masters and 3 replicas across AWS AZs.",
    "Describe what happens during cache stampedes: explain how probabilistic early expiration (XFetch) helped.",
    "Explain your fallback if Redis completely crashes: circuit breakers falling back to database read replicas.",
    "Give one real limitation: cold starts after a cluster flush caused high database CPU load.",
    # 15-20: Kafka Notification Pipeline
    "Introduce your second project: migrating notification delivery from AWS SQS to Apache Kafka.",
    "Confidently but falsely claim that Kafka consumer groups guarantee global ordering across all partitions.",
    "When questioned, correct yourself: ordering is only guaranteed within a single partition, not globally.",
    "Explain how you solved partition ordering: partitioning by merchant ID so each merchant's events stay in order.",
    "Describe handling poison pill messages: after 3 retries, routing failed events to a dead-letter queue topic.",
    "Explain consumer lag tuning: batching up to 500 records per poll to triple throughput.",
    # 21-25: Early Startup Experience (Triggers read_document)
    "Mention your earlier experience at a product startup from June 2017 to June 2019 in Chennai.",
    "Explain you did PostgreSQL schema design and composite indexing to speed up slow reporting queries.",
    "Give the specific fix: partial indexes on active records and tuning work_mem dropped query time from 30s to 600ms.",
    "Admit an area where you struggled: understanding database query planner behavior on deeply nested joins.",
    "Ask Vasanth how senior engineers typically debug explain analyze plans with large buffers.",
    # 26-28: Show-and-Tell Workspace Requests
    "Ask Vasanth if you can open the whiteboard to draw how the Redis and Kafka layers communicate.",
    "Ask Vasanth if you can open the code editor to show the PostgreSQL partial index definition.",
    "Share that you've put the SQL index definition in the editor and ask for his thoughts on it.",
    # 29-30: Session Wrapup
    "Say you think that covers the main technical areas and ask if he has any final questions or feedback.",
    "Thank Vasanth warmly for a great, encouraging interview session and say goodbye.",
]

turn_log = []

def call_brain(user_message: str) -> str:
    payload = {
        "model": "google/gemini-3.5-flash-lite",
        "stream": True,
        "tools": TOOLS,
        "messages": [{"role": "user", "content": user_message}],
    }
    req = urllib.request.Request(BRAIN_URL, data=json.dumps(payload).encode(), headers=HEADERS)
    t0 = time.time()
    text = ""
    tools_called = []
    with urllib.request.urlopen(req, timeout=90) as resp:
        for line in resp:
            l = line.decode().strip()
            if not l.startswith("data: ") or l == "data: [DONE]":
                continue
            c = json.loads(l[6:])
            d = c.get("choices", [{}])[0].get("delta", {})
            if "content" in d and d["content"]:
                text += d["content"]
            if "tools_called" in c and c["tools_called"]:
                tools_called = [t["name"] for t in c["tools_called"]]
    elapsed = int((time.time() - t0) * 1000)
    turn_log.append({
        "candidate": user_message,
        "trainer": text,
        "tools": tools_called,
        "latency_ms": elapsed,
        "words": len(text.split()),
    })
    print(f"\n[Turn {len(turn_log):2d}/30] Latency: {elapsed:4d}ms | Words: {len(text.split()):2d} | Tools: {tools_called}")
    print(f"  Candidate: {user_message[:80]}...")
    print(f"  Vasanth:   {text}")
    return text

def build_simulation_graph() -> SimulationNode:
    async def user_action(simulator, turns, golden):
        index = sum(turn.role == "user" for turn in turns)
        requirement = BEHAVIOURS[min(index, len(BEHAVIOURS) - 1)]
        turn_golden = deepcopy(golden)
        turn_golden.persona = Persona(
            name="Karthik",
            characteristics=(
                f"{BASE_PERSONA}\nCURRENT TURN REQUIREMENT: {requirement}\n"
                "Respond naturally to what the trainer just said while fulfilling this turn's requirement. "
                "Keep your response strictly under 50 spoken words. Never speak as an AI."
            ),
        )
        if index == 0:
            return await simulator.a_generate_first_user_input(turn_golden)
        return await simulator.a_generate_next_user_input(turn_golden, turns)

    return SimulationNode(
        action=user_action,
        max_visits=30,
        name="karthik-imperfect-learner",
    )

def run_simulation():
    golden = ConversationalGolden(
        name="vasanth-30-turn-simulation",
        scenario="30-turn technical interview deep-dive with imperfect candidate Karthik",
        expected_outcome="Vasanth sustains authentic persona across 30 turns",
    )
    dataset = EvaluationDataset()
    dataset.add_golden(golden)

    def chatbot_callback(input: str, turns: list[Turn] | None = None, thread_id: str | None = None) -> Turn:
        del turns, thread_id
        response_text = call_brain(input)
        return Turn(role="assistant", content=response_text)

    # Use DeepEval ConversationSimulator with OpenRouter model for realistic dynamic responses
    simulator_model = OpenRouterModel(
        model="openai/gpt-4.1-mini",
        temperature=0.7,
        api_key=os.environ.get("OPENROUTER_API_KEY"),
    )

    simulator = ConversationSimulator(
        model_callback=chatbot_callback,
        simulation_graph=build_simulation_graph(),
        simulator_model=simulator_model,
        stopping_controller=lambda: None,
    )

    print("=" * 80)
    print("STARTING DEEPEVAL CONVERSATION SIMULATION (30 TURNS)")
    print(f"Target Brain: {BRAIN_URL}")
    print(f"Learner Model: openai/gpt-4.1-mini via DeepEval Simulator")
    print("=" * 80)

    cases = simulator.simulate(
        conversational_goldens=dataset.goldens,
        max_user_simulations=30,
    )

    # Save output
    out_dir = Path("evals/results")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / f"deepeval-sim-{int(time.time())}.json"
    with open(out_file, "w") as f:
        json.dump(turn_log, f, indent=2)

    print("\n" + "=" * 80)
    print("SIMULATION COMPLETED SUCCESSFULLY")
    print("=" * 80)
    lats = [t["latency_ms"] for t in turn_log]
    words = [t["words"] for t in turn_log]
    print(f"Total Turns:       {len(turn_log)}")
    print(f"Median Latency:    {sorted(lats)[len(lats)//2]} ms")
    print(f"Average Words:     {sum(words)/len(words):.1f} words/turn")
    print(f"Saved Results to:  {out_file}")

if __name__ == "__main__":
    run_simulation()
