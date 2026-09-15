"""DeepEval 30-turn behaviour-ladder simulation against the TrainerTwin brain.

Uses deepeval.simulator.ConversationSimulator with a scripted learner-behaviour
ladder (imperfect candidate: false claims, hesitation, hints, workspace
requests) to test the brain's phase-locked episode retrieval, grounded past
exchanges, and tool handling.

  cd bench && uv run python behaviors.py
"""

import json
import os
import time
from copy import deepcopy
from pathlib import Path

from deepeval.dataset import ConversationalGolden, Persona
from deepeval.models import OpenRouterModel
from deepeval.simulator import ConversationSimulator
from deepeval.simulator.simulation_graph import SimulationNode
from deepeval.test_case import Turn

from bridge import Bridge
from conf import AGENT_SLUG, PERSONA_SLUG, RESULTS_DIR

# Workspace + internal tools the brain may act on during a session.
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


def run_simulation():
    bridge = Bridge(agent_slug=AGENT_SLUG, persona_slug=PERSONA_SLUG)
    turn_log = []

    def chatbot_callback(input: str, turns: list[Turn] | None = None, thread_id: str | None = None) -> Turn:
        del turns, thread_id
        response = bridge.send(input, tools=TOOLS)
        text = response["text"]
        turn_log.append({
            "candidate": input,
            "trainer": text,
            "tools": [t["name"] for t in response["tools_called"]],
            "latency_ms": response["wall_ms"],
            "ttft_ms": response["ttft_ms"],
            "words": len(text.split()),
        })
        print(f"\n[Turn {len(turn_log):2d}/{len(BEHAVIOURS)}] Wall: {response['wall_ms']}ms | TTFT: {response['ttft_ms']}ms | Words: {len(text.split())} | Tools: {[t['name'] for t in response['tools_called']]}")
        print(f"  Candidate: {input[:80]}...")
        print(f"  Vasanth:   {text}")
        return Turn(role="assistant", content=text)

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
            max_visits=len(BEHAVIOURS),
            name="karthik-imperfect-learner",
        )

    golden = ConversationalGolden(
        name="brain-behaviour-ladder",
        scenario="30-turn technical interview deep-dive with imperfect candidate Karthik",
        expected_outcome="Vasanth sustains authentic persona across 30 turns",
    )

    simulator_model = OpenRouterModel(
        model=os.environ.get("BENCH_EVALUATION_MODEL", "openai/gpt-4.1-mini"),
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
    print("STARTING DEEPEVAL BEHAVIOUR-LADDER SIMULATION")
    print(f"Target: {bridge.url} | Session: {bridge.session_id}")
    print(f"Agent: {AGENT_SLUG} | Persona: {PERSONA_SLUG}")
    print("=" * 80)

    simulator.simulate(conversational_goldens=[golden], max_user_simulations=len(BEHAVIOURS))

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    out_file = RESULTS_DIR / f"deepeval-sim-{int(time.time())}.json"
    out_file.write_text(json.dumps({
        "session_id": bridge.session_id,
        "target": bridge.url,
        "turns": turn_log,
    }, indent=2) + "\n")

    print("\n" + "=" * 80)
    print("SIMULATION COMPLETED")
    lats = sorted(t["latency_ms"] for t in turn_log)
    words = [t["words"] for t in turn_log]
    print(f"Total Turns:       {len(turn_log)}")
    print(f"Median Wall:       {lats[len(lats)//2]} ms")
    print(f"Average Words:     {sum(words)/len(words):.1f} words/turn")
    print(f"Turns with Tools:  {sum(1 for t in turn_log if t['tools'])}/{len(turn_log)}")
    print(f"Saved Results to:  {out_file}")
    print("=" * 80)


if __name__ == "__main__":
    run_simulation()
