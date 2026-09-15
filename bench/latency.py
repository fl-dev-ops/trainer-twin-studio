"""30-turn session latency benchmark against the brain (TTFT, wall clock,
persona progression across session phases).

  cd bench && uv run python latency.py
  BENCH_API_URL=https://chat.trainertwin.com uv run python latency.py  # prod
"""

import json
import statistics
import time

from bridge import Bridge
from conf import AGENT_SLUG, PERSONA_SLUG, RESULTS_DIR

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
    "I believe that covers our end-to-end architecture and performance gains. We are done for today.",
]


def main():
    bridge = Bridge(agent_slug=AGENT_SLUG, persona_slug=PERSONA_SLUG)
    print("=" * 80)
    print("RUNNING 30-TURN SESSION LATENCY BENCHMARK")
    print(f"Target: {bridge.url} | Session: {bridge.session_id}")
    print("=" * 80)

    results = []
    for turn_num, user_msg in enumerate(CANDIDATE_30_TURNS, 1):
        try:
            response = bridge.send(user_msg, tools=[{"type": "function", "function": {"name": "surface", "parameters": {"type": "object", "properties": {"action": {"type": "string"}, "payload": {"type": "object"}}}, "required": ["action"]}}])
            text = response["text"]
            tool_names = [t["name"] for t in response["tools_called"]]
            results.append({
                "turn": turn_num,
                "wall_ms": response["wall_ms"],
                "ttft_ms": response["ttft_ms"],
                "words": len(text.split()),
                "tools": tool_names,
                "text": text,
                "usage": response["usage"],
            })
            print(f"  [T{turn_num:02d}] Wall: {response['wall_ms']:5d}ms | TTFT: {response['ttft_ms']:5d}ms | Words: {len(text.split()):2d} | Tools: {tool_names}")
            print(f"        A: {text[:90]}...")
            time.sleep(0.5)
        except Exception as exc:
            print(f"  [T{turn_num:02d}] ERROR: {exc}")
            results.append({"turn": turn_num, "error": str(exc), "wall_ms": 0})
            time.sleep(1.0)

    valid = [r for r in results if r.get("wall_ms", 0) > 0]
    wall = [r["wall_ms"] for r in valid]
    ttft = [r["ttft_ms"] for r in valid]
    print("\n" + "=" * 80)
    print("30-TURN BENCHMARK SCORECARD")
    print(f"Total Turns Completed:       {len(valid)}/30 ({(len(valid)/30)*100:.1f}%)")
    print(f"Median Wall Clock Latency:   {statistics.median(wall):.0f} ms")
    print(f"P90 Wall Clock Latency:      {statistics.quantiles(wall, n=10)[8]:.0f} ms" if len(wall) >= 10 else "")
    print(f"Min / Max Wall Latency:      {min(wall)} ms / {max(wall)} ms")
    print(f"Median TTFT:                 {statistics.median([r['ttft_ms'] for r in valid]):.0f} ms")
    print(f"Average Words per Turn:      {statistics.mean([r['words'] for r in valid]):.1f} words")

    print("\nLATENCY PROGRESSION ACROSS SESSION PHASES:")
    for lo, hi, label in ((1, 10, "Opening & Overview"), (11, 20, "Deep Dive & Show-and-Tell"), (21, 30, "Failover & Concluding")):
        chunk = [r["wall_ms"] for r in valid if lo <= r["turn"] <= hi]
        if chunk:
            print(f"  Turns {lo:02d} - {hi} ({label}): Median {statistics.median(chunk):.0f} ms")
    print("=" * 80)

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    out_file = RESULTS_DIR / f"latency-30turns-{int(time.time())}.json"
    out_file.write_text(json.dumps({
        "session_id": bridge.session_id,
        "summary": {"median_wall_ms": statistics.median(wall)},
        "turns": results,
    }, indent=2) + "\n")
    print(f"Detailed traces saved to: {out_file}")


if __name__ == "__main__":
    main()
