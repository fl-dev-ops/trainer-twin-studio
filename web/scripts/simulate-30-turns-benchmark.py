#!/usr/bin/env python3
"""
30-Turn Session Latency & Persona Progression Benchmark.
Tracks TTFT, Wall Clock Latency, Tool Execution, and Persona Continuity across all 30 turns.
"""

import json
import os
import sys
import time
import urllib.request

TARGET_URL = os.environ.get("TARGET_URL", "https://chat.trainertwin.com/v1/chat/completions")
ORG_ID = "699ffaba-70fa-4fd1-a4ed-d80da8f06bff"
COPILOT_SECRET = "c67a0c2219ca04a134b1ff23e4b813d3a30f3c2600f695a327b64a30cd29ee9b"

import base64
B64_AUTH = base64.b64encode(f"{ORG_ID}:{COPILOT_SECRET}".encode()).decode()

CANDIDATE_30_TURNS = [
    # Phase 1: Intro & Project Overview (Turns 1-5)
    "Hi, I am ready to start. My name is Karthik.",
    "In my recent project, I redesigned our payments processing and ledger service handling around 15,000 transactions per second.",
    "We migrated our core transactional data from a monolithic Postgres database to an event-driven architecture using Kafka and Redis.",
    "We used Redis as a read-through cache for account balance queries, which absorbed 92 percent of read traffic.",
    "That allowed our primary Postgres database to focus strictly on ACID writes and ledger reconciliations.",
    
    # Phase 2: Caching & Concurrency Deep Dive (Turns 6-10)
    "For cache invalidation, we used a write-through pattern with a short 60-second TTL as a fallback safety net.",
    "To handle cache stampedes during flash sales, we implemented single-flight request coalescing using distributed Redis locks with a 50ms lease.",
    "When multiple threads requested the same account balance, only one fetched from Postgres while the others waited for the Redis write.",
    "We sized our Redis cluster with 3 master nodes and 3 read replicas, allocating 32 gigabytes of RAM per node.",
    "Our memory eviction policy was volatile-lru, ensuring keys without TTL were never accidentally evicted.",
    
    # Phase 3: Database & Indexing Optimization (Turns 11-15)
    "On the Postgres side, our p99 query latency on the transaction ledger table was initially 95 milliseconds.",
    "We analyzed the slow query log and found sequential scans on the transaction history table due to multi-column filtering.",
    "We introduced composite partial B-tree indexes on user_id and created_at where status equals completed.",
    "That dropped our p99 query latency from 95 milliseconds down to 14 milliseconds.",
    "We also converted our transaction UUID primary keys to sequential UUIDv7 to eliminate B-tree page fragmentation.",
    
    # Phase 4: Show-and-Tell & Code/Canvas (Turns 16-20)
    "Can you open the code editor so I can show the SQL transaction locking pattern we used for double-entry ledger entries?",
    "Here in the editor, you can see we sort account IDs alphabetically before acquiring row-level locks to prevent deadlocks.",
    "If lock acquisition exceeds 200 milliseconds, the query times out with a 409 conflict and triggers our exponential retry mechanism.",
    "Can you open the whiteboard canvas so I can sketch our Kafka partitioning topology?",
    "As drawn on the canvas, each partition is keyed by tenant ID to guarantee in-order event processing per merchant.",
    
    # Phase 5: Failover & Resilience (Turns 21-25)
    "When a Kafka broker crashed during our chaos testing, partitions were reassigned within 3 seconds using cooperative sticky assignors.",
    "For Redis master failover, we used Redis Sentinel which promoted a replica to master in under 6 seconds.",
    "During failover, our API gateway briefly queued balance updates in memory for up to 10 seconds to prevent user errors.",
    "For disaster recovery, we configured asynchronous multi-region replication to AWS us-west-2 with an RPO under 1 second.",
    "We verified this during our quarterly disaster recovery drill by cutting traffic to our primary region.",
    
    # Phase 6: Monitoring, Lessons Learned & Wrap-up (Turns 26-30)
    "We monitored our p95 and p99 latency metrics using Prometheus, Grafana, and OpenTelemetry distributed tracing.",
    "Our SLO was 99.95 percent availability with p99 response time under 50 milliseconds across all payment endpoints.",
    "Over the last six months, our service maintained 99.98 percent availability and processed over 2 billion dollars in transaction volume.",
    "The biggest lesson learned was to always load test with realistic skew, because 5 percent of merchants generated 80 percent of load.",
    "I believe that covers our end-to-end architecture and performance gains. We are done for today."
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
    },
    {
        "type": "function",
        "function": {
            "name": "finish_session",
            "description": "Signals interview conclusion",
            "parameters": {"type": "object", "properties": {}}
        }
    }
]

def main():
    session_id = f"bench-30turns-karthik-{int(time.time())}"
    headers = {
        "Authorization": f"Basic {B64_AUTH}",
        "x-trainertwin-org-id": ORG_ID,
        "x-trainertwin-session-id": session_id,
        "x-trainertwin-agent-slug": "impact-quantification",
        "x-trainertwin-persona-slug": "Vasanth",
        "x-trainertwin-mode": "voice",
        "content-type": "application/json"
    }

    print("=" * 80)
    print(f"RUNNING 30-TURN FULL SESSION BENCHMARK AGAINST PRODUCTION")
    print(f"Target URL: {TARGET_URL}")
    print(f"Session ID: {session_id}")
    print(f"Candidate:  Karthik (Payments & Ledger Architecture)")
    print("=" * 80)

    history = []
    results = []

    for turn_num, user_msg in enumerate(CANDIDATE_30_TURNS, 1):
        history.append({"role": "user", "content": user_msg})
        payload = {
            "model": "openai/gpt-4.1-mini",
            "stream": True,
            "tools": TOOLS_SCHEMA,
            "messages": history
        }

        req = urllib.request.Request(TARGET_URL, data=json.dumps(payload).encode(), headers=headers)
        t0 = time.time()
        text = ""
        tools_called = []
        wall_ms = 0
        ttft_ms = 0
        usage = {}

        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                for line in resp:
                    l = line.decode().strip()
                    if not l.startswith("data: ") or l == "data: [DONE]":
                        continue
                    c = json.loads(l[6:])
                    delta = c.get("choices", [{}])[0].get("delta", {})
                    if "content" in delta and delta["content"]:
                        text += delta["content"]
                    if "tools_called" in c and c["tools_called"]:
                        tools_called = c["tools_called"]
                    if "wall_ms" in c:
                        wall_ms = c["wall_ms"]
                    if "ttft_ms" in c:
                        ttft_ms = c["ttft_ms"]
                    if c.get("usage"):
                        usage = c["usage"]

            client_wall = int((time.time() - t0) * 1000)
            eff_wall = wall_ms if wall_ms > 0 else client_wall
            words = len(text.split())
            tool_names = [t["name"] for t in tools_called]

            history.append({"role": "assistant", "content": text})

            print(f"  [T{turn_num:02d}] Wall: {eff_wall:5d}ms | TTFT: {ttft_ms:5d}ms | Words: {words:2d} | Tools: {tool_names}")
            print(f"        Q: {text[:90]}...")

            results.append({
                "turn": turn_num,
                "wall_ms": eff_wall,
                "ttft_ms": ttft_ms,
                "words": words,
                "tools": tool_names,
                "text": text,
                "usage": usage
            })
            time.sleep(0.5)

        except Exception as e:
            print(f"  [T{turn_num:02d}] ERROR: {e}")
            results.append({"turn": turn_num, "error": str(e), "wall_ms": 0})
            time.sleep(1.0)

    # Summary analysis
    valid = [r for r in results if r.get("wall_ms", 0) > 0]
    wall_latencies = [r["wall_ms"] for r in valid]
    ttft_latencies = [r["ttft_ms"] for r in valid if r.get("ttft_ms", 0) > 0]

    import statistics
    print("\n" + "=" * 80)
    print("30-TURN BENCHMARK SCORECARD")
    print("=" * 80)
    print(f"Total Turns Completed:       {len(valid)}/30 ({(len(valid)/30)*100:.1f}%)")
    print(f"Median Wall Clock Latency:   {statistics.median(wall_latencies):.0f} ms")
    print(f"P90 Wall Clock Latency:      {statistics.quantiles(wall_latencies, n=10)[8]:.0f} ms")
    print(f"Min / Max Wall Latency:      {min(wall_latencies)} ms / {max(wall_latencies)} ms")
    print(f"Median TTFT:                 {statistics.median(ttft_latencies):.0f} ms")
    print(f"Average Words per Turn:      {statistics.mean([r['words'] for r in valid]):.1f} words")
    
    # Turns 1-10 vs 11-20 vs 21-30 latency progression
    p1_wall = [r["wall_ms"] for r in valid if 1 <= r["turn"] <= 10]
    p2_wall = [r["wall_ms"] for r in valid if 11 <= r["turn"] <= 20]
    p3_wall = [r["wall_ms"] for r in valid if 21 <= r["turn"] <= 30]

    print("\nLATENCY PROGRESSION ACROSS SESSION PHASES:")
    print(f"  Turns 01 - 10 (Opening & Overview):      Median {statistics.median(p1_wall):.0f} ms")
    print(f"  Turns 11 - 20 (Deep Dive & Show-and-Tell): Median {statistics.median(p2_wall):.0f} ms")
    print(f"  Turns 21 - 30 (Failover & Concluding):     Median {statistics.median(p3_wall):.0f} ms")
    print("=" * 80)

    out_file = "web/experiments/results/simulation-30turns-karthik.json"
    os.makedirs(os.path.dirname(out_file), exist_ok=True)
    with open(out_file, "w") as f:
        json.dump({"session_id": session_id, "summary": {"median_wall_ms": statistics.median(wall_latencies)}, "turns": results}, f, indent=2)
    print(f"Detailed traces saved to: {out_file}")

if __name__ == "__main__":
    main()
