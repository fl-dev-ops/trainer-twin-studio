import json, urllib.request, time, base64, os, sys, subprocess

SECRET = 'c67a0c2219ca04a134b1ff23e4b813d3a30f3c2600f695a327b64a30cd29ee9b'
ORG = '699ffaba-70fa-4fd1-a4ed-d80da8f06bff'
SESSION_ID = 'cmu0rvnu5000004l57xra6qwl' # Harini session with resume
URL = 'http://localhost:3100/v1/chat/completions'

b64 = base64.b64encode(f"{ORG}:{SECRET}".encode()).decode()
headers = {
    "Authorization": f"Basic {b64}",
    "x-trainertwin-org-id": ORG,
    "x-trainertwin-session-id": f"bench-30-{int(time.time())}",
    "x-trainertwin-agent-slug": "impact-quantification",
    "x-trainertwin-persona-slug": "Vasanth",
    "x-trainertwin-mode": "voice",
    "content-type": "application/json"
}

# 30 Realistic conversational turns covering:
# 1-3: Icebreaker
# 4-8: FinTech background
# 9-14: Redis caching & invalidation
# 15-20: Kafka pipeline & throughput
# 21-25: Startup experience (2017-2019) with read_document
# 26-28: Whiteboard & Code editor surface
# 29-30: Wrapup
turns = [
    # 1-3: Icebreaker
    "[OPENING]",
    "Hi Vasanth, I'm doing great, thank you! A little nervous for the interview, but excited to be here.",
    "Sounds great. Yes, I'm ready to get started.",
    # 4-8: FinTech Platform
    "In my recent role at the FinTech Platform, I was a Senior Software Engineer working on backend microservices for payments and transaction processing.",
    "Our main goal was reducing API latency and decoupling our transactional workflows so peak traffic wouldn't take down the checkout service.",
    "We introduced Redis caching in front of our database read replicas, which cut our endpoint latency by about forty percent.",
    "The baseline p99 latency was around two hundred milliseconds, and with caching we brought it down to eighty milliseconds.",
    "We cached user payment method profiles and merchant fee configurations.",
    # 9-14: Redis Deep-Dive
    "For cache invalidation, we used a write-through strategy with a short TTL of ten minutes as a safety net.",
    "When a merchant updated their fee tier, we emitted an event on Kafka that triggered invalidation across all Redis cluster nodes.",
    "If Redis went down, we had a circuit breaker that fell back to read replicas directly, with rate limiting to protect the database.",
    "We used Redis Cluster with three masters and three replicas across different availability zones to ensure high availability.",
    "We monitored cache hit rates using Prometheus and Datadog; our hit rate averaged around ninety-two percent.",
    "Yes, during flash sales, cache stampede was an issue, so we added probabilistic early expiration using the XFetch algorithm.",
    # 15-20: Kafka Pipeline
    "Beyond caching, we also moved all notification and receipt processing to Kafka asynchronously.",
    "We partitioned our Kafka topics by merchant ID so all transactions for a single merchant were processed strictly in order.",
    "We had eight partitions per topic and our consumer group scaled horizontally based on consumer lag metrics in CloudWatch.",
    "For poison pill messages, we routed failures after three retries to a dead letter queue topic for manual inspection.",
    "We tuned consumer polling to batch up to five hundred records per fetch, which boosted our throughput by three times.",
    "Exactly. That kept our synchronous API response time completely isolated from downstream notification delivery.",
    # 21-25: Startup Experience (2017-2019) -> Triggers read_document
    "Before that, I worked at a product startup from June 2017 to June 2019 in Chennai where I did database schema design and REST APIs.",
    "We were using PostgreSQL and Node.js. It was an early-stage startup so I had to handle both backend logic and query optimization.",
    "We had serious performance issues with our reporting queries taking over thirty seconds, so I restructured our relational schemas and added composite indexes.",
    "We analyzed slow query logs using pg_stat_statements and noticed sequential scans on our accounts ledger table.",
    "By adding partial indexes on active records and tuning work_mem, query runtime dropped from thirty seconds down to under six hundred milliseconds.",
    # 26-28: Show-and-Tell Workspace Requests
    "Can you open the whiteboard so I can sketch how the Redis cache and Kafka consumer pipeline fit together?",
    "I've sketched the architecture on the whiteboard now. Can you also open the code editor so I can share the SQL partial index definition?",
    "Here is the partial index query in the editor. How does that look to you?",
    # 29-30: Session Wrapup
    "That covers the main technical architecture of both systems. Do you have any final questions for me?",
    "Thank you so much Vasanth, this was a really enjoyable session!"
]

tools = [
  {"type":"function","function":{"name":"surface","parameters":{"type":"object","properties":{"action":{"type":"string"}}}}},
  {"type":"function","function":{"name":"read_document","parameters":{"type":"object","properties":{"documentId":{"type":"string"},"query":{"type":"string"}}}}},
  {"type":"function","function":{"name":"search_style","parameters":{"type":"object","properties":{"personaSlug":{"type":"string"},"query":{"type":"string"}}}}},
  {"type":"function","function":{"name":"finish_session","parameters":{"type":"object","properties":{}}}}
]

print("=" * 80)
print(f"STARTING 30-TURN BENCHMARK (Local Brain on {URL})")
print("=" * 80)

latencies = []
word_counts = []
tools_by_turn = []

for i, msg in enumerate(turns, 1):
    payload = {
        "model": "google/gemini-3.5-flash-lite",
        "stream": True,
        "tools": tools,
        "messages": [{"role": "user", "content": msg}]
    }
    req = urllib.request.Request(URL, data=json.dumps(payload).encode(), headers=headers)
    t0 = time.time()
    text = ""; tools_called = []
    
    with urllib.request.urlopen(req, timeout=90) as resp:
        for line in resp:
            l = line.decode().strip()
            if not l.startswith("data: ") or l == "data: [DONE]": continue
            c = json.loads(l[6:])
            d = c.get("choices", [{}])[0].get("delta", {})
            if "content" in d and d["content"]: text += d["content"]
            if "tools_called" in c and c["tools_called"]: tools_called = [t["name"] for t in c["tools_called"]]
            
    wall = int((time.time() - t0) * 1000)
    words = len(text.split())
    latencies.append(wall)
    word_counts.append(words)
    tools_by_turn.append(tools_called)
    
    print(f"\n[Turn {i:2d}/30] | Latency: {wall:5d}ms | Words: {words:2d} | Tools: {tools_called}")
    print(f"  Candidate: {msg[:80]}...")
    print(f"  Vasanth:   {text}")
    time.sleep(0.5)

print("\n" + "=" * 80)
print("30-TURN BENCHMARK SUMMARY")
print("=" * 80)
print(f"Total Turns:       {len(latencies)}")
print(f"Median Latency:    {sorted(latencies)[len(latencies)//2]} ms")
print(f"Mean Latency:      {sum(latencies)/len(latencies):.1f} ms")
print(f"Min / Max Latency: {min(latencies)} ms / {max(latencies)} ms")
print(f"Avg Word Count:    {sum(word_counts)/len(word_counts):.1f} words (Target: <50)")
print(f"Turns with Tools:  {sum(1 for t in tools_by_turn if len(t) > 0)} / 30")
print("=" * 80)
