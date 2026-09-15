"""Parallel 5-session benchmark: 5 concurrent sessions, 16 scripted turns each,
against the chat bridge. Tracks latency, tool calls, token usage per turn.

  cd bench && uv run python concurrency.py
"""

import json
import statistics
import time
from concurrent.futures import ThreadPoolExecutor

from bridge import Bridge
from conf import AGENT_SLUG, PERSONA_SLUG, RESULTS_DIR

# 5 distinct technical candidate conversation scripts (16 turns each)
CANDIDATES = [
    {
        "id": "session-1-karthik",
        "candidate": "Karthik",
        "topic": "Distributed Messaging & Caching",
        "turns": [
            "Hi, I am ready to start. My name is Karthik.",
            "In my last project, I redesigned our ingestion pipeline using Kafka and Redis, handling around 25,000 events per second.",
            "We used Kafka topic partitions keyed by customer ID to guarantee strict per-customer ordering.",
            "We had 32 partitions per topic across a 4-node broker cluster, which gave us enough parallelism.",
            "When rebalances occurred, we switched to Cooperative Sticky Assignors to avoid stop-the-world pauses.",
            "That dropped our rebalance latency from forty seconds down to under two seconds.",
            "For deduplication, we maintained a Redis SET with a 24-hour TTL keyed by event idempotency key.",
            "Yes, we considered memory usage. Each key was only 32 bytes, so 20 million keys took around 1.5 gigabytes of RAM.",
            "Can you open the whiteboard canvas so I can sketch the partition and consumer group topology?",
            "Thanks. As drawn here, consumers read from assigned partitions and write to a buffer before flushing to Postgres.",
            "If a consumer crashes, the remaining consumers pick up its partitions after the heartbeat timeout of three seconds.",
            "For exactly-once delivery, we used Kafka transactional producer IDs combined with downstream idempotent database upserts.",
            "We tested network partition edge cases using Chaos Mesh by injecting packet loss between brokers.",
            "During testing, we discovered our producer ack setting was set to 1 instead of all, which risked data loss on leader failure.",
            "We corrected it to acks equals all and set min.insync.replicas to two to guarantee durability.",
            "I think we have covered the key architecture. We are done for today.",
        ],
    },
    {
        "id": "session-2-anubhav",
        "candidate": "Anubhav",
        "topic": "Payments & Transaction Concurrency",
        "turns": [
            "Hello, I am Anubhav. Good to connect today.",
            "I led the core ledger team where we built an ACID-compliant double-entry payment service in Java and Postgres.",
            "We handled 12 million transactions daily with zero financial reconciliation discrepancies.",
            "We used Postgres serializable isolation for high-value transfers, and read-committed with row-level locks for standard payments.",
            "To prevent deadlocks during high-concurrency wallet transfers, we always locked user accounts in alphabetical order of their UUIDs.",
            "Before that sorting rule, we were seeing around 150 deadlock exceptions per hour during flash sales.",
            "After enforcing the account locking order, deadlock errors dropped to zero.",
            "We handled idempotency at the API gateway using an SHA-256 hash of the request payload and an idempotency token.",
            "Can you open the code editor? I can show the row-locking implementation in SQL.",
            "Here in the editor, we use SELECT FOR UPDATE NOWAIT so transactions fail fast rather than hanging indefinitely.",
            "If NOWAIT raises an error, our retry mechanism uses exponential backoff with jitter across three attempts.",
            "For disaster recovery, we configured synchronous replication across two availability zones with 10ms max replica lag.",
            "During our chaos drill, failover completed in under twelve seconds using Patroni and etcd.",
            "One challenge was table bloat in Postgres due to heavy updates on hot account balance rows.",
            "We tuned autovacuum thresholds and implemented an append-only transaction ledger with nightly rollup tables.",
            "That summarizes our transaction safety design. We can conclude the session here.",
        ],
    },
    {
        "id": "session-3-vinay",
        "candidate": "Vinay",
        "topic": "Authentication & Rate Limiting",
        "turns": [
            "Hi, my name is Vinay. Ready for the interview.",
            "I designed the centralized authentication and authorization service serving 15 microservices at my previous company.",
            "We handled over 8,000 token validation requests per second with a p99 response time under 4 milliseconds.",
            "We used asymmetric RS256 JWTs so downstream services could verify tokens locally using the public key without network hops.",
            "To support immediate token revocation when a user logs out or changes password, we maintained a Redis blacklist.",
            "The blacklist only stores revoked JTI IDs with a TTL matching the token remaining lifespan, keeping the set small.",
            "For rate limiting, we implemented a distributed token bucket algorithm using Redis Lua scripts.",
            "A Lua script guarantees atomic check-and-decrement in a single round-trip without race conditions.",
            "Can you open the whiteboard canvas so I can diagram the public key caching flow?",
            "As sketched, services fetch the JWKS once at startup and refresh it every six hours or on cache misses.",
            "If Redis goes down, we have a circuit breaker that falls back to in-memory local caches with a conservative 100-request limit.",
            "We secured user passwords using Argon2id with 64 megabytes of memory cost and three iterations.",
            "We mitigated brute force attacks by introducing tiered rate limits based on client IP and account username.",
            "Our monitoring with Prometheus and Grafana alerts us if failed authentication attempts spike above 2 percent.",
            "This setup successfully defended against two credential stuffing attacks without impacting legitimate users.",
            "I think we have touched upon all the key security layers. We can wrap up for today.",
        ],
    },
    {
        "id": "session-4-priya",
        "candidate": "Priya",
        "topic": "Search & Event-Driven Indexing",
        "turns": [
            "Hello, I am Priya. Nice to meet you.",
            "I engineered our product search system using Elasticsearch and Kafka, serving over 30 million item queries per day.",
            "Our primary challenge was search latency during peak catalog updates, which we reduced from 280ms to 35ms.",
            "We separated the write pipeline from the read cluster by streaming database changes via Debezium CDC into Kafka.",
            "Kafka consumers bulk-indexed updates into Elasticsearch in batches of 500 documents every 200 milliseconds.",
            "This batching reduced Elasticsearch indexing CPU load by over 60 percent compared to single-document updates.",
            "For relevance, we customized BM25 similarity scoring with field-level boosts on product titles and brand names.",
            "We used custom edge-ngram tokenizers to support fast autocomplete queries with prefix matching.",
            "Can you open the code editor so I can share our Elasticsearch index mapping schema?",
            "In this mapping, we disabled norms on non-text fields and set doc_values to true to optimize memory usage.",
            "To handle node failures without data loss, we configured two replica shards per primary shard across three availability zones.",
            "When dealing with eventual consistency between MySQL and Elasticsearch, we added version timestamps to ignore out-of-order Kafka events.",
            "If an update had an older version timestamp than the current index doc, the consumer safely discarded it.",
            "We tracked query latency percentiles using Jaeger distributed tracing across the search gateway and ES nodes.",
            "This architecture maintained 99.95 percent availability during our annual holiday shopping sale.",
            "That covers the main aspects of our search infrastructure. We are done for today.",
        ],
    },
    {
        "id": "session-5-sneha",
        "candidate": "Sneha",
        "topic": "Cloud Infrastructure & SRE",
        "turns": [
            "Hi, I am Sneha. Excited to discuss my background.",
            "I was the lead SRE responsible for migrating 40 microservices from EC2 instances to AWS EKS Kubernetes clusters.",
            "The migration reduced our AWS cloud infrastructure spend by 38 percent while improving deployment frequency from weekly to daily.",
            "We used Kubernetes Horizontal Pod Autoscaler based on custom Prometheus metrics, specifically request queue depth.",
            "Scaling on queue depth allowed our worker pods to scale up 90 seconds faster than standard CPU threshold scaling.",
            "For zero-downtime deployments, we configured readiness probes and pod disruption budgets with rolling update strategies.",
            "Our maximum unavailable pods was capped at 10 percent during deployments to prevent traffic degradation.",
            "We implemented Cilium as our CNI plugin for eBPF-based network policy enforcement and observability.",
            "Can you open the whiteboard canvas so I can draw our multi-cluster networking topology?",
            "As shown here, we route ingress traffic through AWS ALB directly to pod IPs using the AWS Load Balancer Controller.",
            "Bypassing kube-proxy NodePort hops reduced our intra-cluster network latency by approximately 8 milliseconds.",
            "For disaster recovery, we used Velero to back up Kubernetes persistent volumes and cluster state to S3 every four hours.",
            "In our restore simulation, we brought up a secondary cluster in another region in twenty-four minutes.",
            "We standardized our SLOs with Prometheus alertmanager, tracking error budgets with a 99.9 percent monthly availability target.",
            "Our mean time to recovery dropped from forty minutes to under nine minutes after implementing these automated runbooks.",
            "I believe that covers our reliability engineering work. We are done for today.",
        ],
    },
]


def run_session(candidate_info: dict) -> dict:
    bridge = Bridge(agent_slug=AGENT_SLUG, persona_slug=PERSONA_SLUG)
    session_id = f"bench-{candidate_info['id']}-{int(time.time())}"
    candidate_name = candidate_info["candidate"]
    print(f"[START] Session {candidate_name} ({session_id}) — {len(candidate_info['turns'])} turns...")

    turn_results = []
    for turn_num, user_msg in enumerate(candidate_info["turns"], 1):
        try:
            response = bridge.send(user_msg)
            text = response["text"]
            tool_names = [t["name"] for t in response["tools_called"]]
            turn_results.append({
                "turn_number": turn_num,
                "user_text": user_msg,
                "trainer_text": text,
                "word_count": len(text.split()),
                "wall_ms": response["wall_ms"],
                "tools_called": response["tools_called"],
                "usage": response["usage"],
            })
            print(f"  [{candidate_name} T{turn_num:02d}] {response['wall_ms']}ms | words={len(text.split())} | tools={tool_names} | text: {text[:80]}...")
            time.sleep(0.5)
        except Exception as exc:
            print(f"  [{candidate_name} T{turn_num:02d}] ERROR: {exc}")
            turn_results.append({
                "turn_number": turn_num,
                "user_text": user_msg,
                "error": str(exc),
                "wall_ms": 0,
                "tools_called": [],
            })
            time.sleep(1.0)

    print(f"[DONE] Session {candidate_name} completed!")
    return {
        "session_id": session_id,
        "candidate": candidate_name,
        "topic": candidate_info["topic"],
        "turns": turn_results,
    }


def main():
    print("=" * 70)
    print("RUNNING 5 PARALLEL SESSIONS (16 TURNS EACH) AGAINST THE BRAIN")
    print("=" * 70)

    t_start = time.time()
    with ThreadPoolExecutor(max_workers=5) as executor:
        results = list(executor.map(run_session, CANDIDATES))
    total_time_s = time.time() - t_start

    all_latencies = []
    tool_counts: dict = {}
    total_turns = 0
    successful_turns = 0
    words_per_turn = []

    for session in results:
        for turn in session["turns"]:
            total_turns += 1
            if "error" not in turn and turn["wall_ms"] > 0:
                successful_turns += 1
                all_latencies.append(turn["wall_ms"])
                words_per_turn.append(turn["word_count"])
                for tool_call in turn.get("tools_called", []):
                    name = tool_call["name"]
                    tool_counts[name] = tool_counts.get(name, 0) + 1

    median_lat = statistics.median(all_latencies) if all_latencies else 0
    p90_lat = statistics.quantiles(all_latencies, n=10)[8] if len(all_latencies) >= 10 else (max(all_latencies) if all_latencies else 0)
    avg_words = statistics.mean(words_per_turn) if words_per_turn else 0

    print("\n" + "=" * 70)
    print("PARALLEL BENCHMARK RESULTS SUMMARY")
    print(f"Total Wall Time for 5 Concurrent Sessions: {total_time_s:.1f}s")
    print(f"Total Turns:                               {total_turns}")
    print(f"Successful Turns:                          {successful_turns}/{total_turns} ({(successful_turns/max(1,total_turns))*100:.1f}%)")
    print(f"Median Turn Latency:                       {median_lat:.0f} ms")
    print(f"90th Percentile Latency:                   {p90_lat:.0f} ms")
    print(f"Average Words per Turn:                    {avg_words:.1f} words (target < 50)")
    print(f"Tools Executed Across All Turns:           {json.dumps(tool_counts, indent=2)}")
    print("=" * 70)

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = RESULTS_DIR / f"parallel-5sessions-{int(time.time())}.json"
    out_path.write_text(json.dumps({
        "timestamp": time.time(),
        "total_time_s": total_time_s,
        "sessions_count": len(results),
        "turns_per_session": 16,
        "summary": {
            "median_wall_ms": median_lat,
            "p90_wall_ms": p90_lat,
            "avg_words_per_turn": avg_words,
            "tool_counts": tool_counts,
        },
        "sessions": results,
    }, indent=2) + "\n")
    print(f"Detailed traces saved to: {out_path}")


if __name__ == "__main__":
    main()
