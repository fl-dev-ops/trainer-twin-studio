import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { getAgentConfigForAgent } from "@/lib/specs";

// CLI: bun scripts/simulate-15-turns.ts --variant variant-5
//      bun scripts/simulate-15-turns.ts --variant variant-6
//      bun scripts/simulate-15-turns.ts --variant baseline
const args = process.argv.slice(2);
function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}
const variant = getArg("--variant") ?? "variant-5";
const AGENT_SLUG = "project-experience-deep-dive";

let handlerModule: { handleCompletions: (req: Request) => Promise<Response> };
if (variant === "baseline") {
  handlerModule = await import("@/lib/runtime/openai");
} else {
  handlerModule = await import(`@/experiments/${variant}/handler`);
}
const handleCompletions = handlerModule.handleCompletions;

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

interface ConversationSpec {
  id: string;
  candidateName: string;
  roleDescription: string;
  turns: string[];
}

const CONVERSATIONS: ConversationSpec[] = [
  {
    id: "conv-1-karthik",
    candidateName: "Karthik",
    roleDescription: "5 YOE Backend Engineer — Payments, Redis idempotency, Kafka pipelines",
    turns: [
      "Hi Vasanth, I'm Karthik. Thanks for having me. I have about 5 years of experience in backend development, mostly with Go, Node, and distributed systems.",
      "Yes, I've worked primarily on high-throughput microservices for payments, specifically building a Redis idempotency layer and Kafka event notification pipelines.",
      "In our payment processing system, we had duplicate webhook events coming from payment gateways during network retries. I designed a deduplication layer using Redis.",
      "We used Redis SETNX with a 24-hour TTL. If the key already existed, we returned the cached result immediately, which guaranteed exactly-once processing.",
      "Well, because Redis is single-threaded and the key is set atomically with SETNX, no two requests can process the same transaction at the same time.",
      "Wait, actually, I guess if the downstream database commit fails after setting the Redis key, the request wouldn't have been processed, but Redis would still say it's done. So that's not truly exactly-once.",
      "Yeah, that's why we added a two-phase check with a state machine in Postgres, but honestly it was tricky to handle crashes in between.",
      "I personally designed the Redis key format and the state machine transition logic. A team of three other engineers implemented the gateway client handlers.",
      "Sorry, could you repeat that question? I want to make sure I understand what you're asking.",
      "For the Kafka notification pipeline, we had 12 partitions and consumer groups processing email and SMS alerts.",
      "We assumed that as long as we were using consumer groups, messages would always be processed strictly in order across the system.",
      "Could you give me a small hint on how partition ordering actually interacts with consumer groups?",
      "Ah, right! Ordering is only guaranteed within a single partition using the partition key, not globally across the topic. So if we used the user ID as the key, all events for that user stay in order.",
      "One major limitation was during deployment restarts, consumer rebalancing would cause thundering herd latency spikes of 15 to 20 seconds.",
      "Looking back, we should have used cooperative sticky assignors in Kafka instead of the default eager assignor to avoid stopping all consumers during a rebalance."
    ]
  },
  {
    id: "conv-2-anubhav",
    candidateName: "Anubhav",
    roleDescription: "4 YOE Full Stack Engineer — React virtual DOM, Node.js event loop & worker threads",
    turns: [
      "Hi Vasanth, thanks for having me. I'm Anubhav, 4 years of experience doing full stack with React and Node.js.",
      "I've spent the last two years at an e-commerce company building customer-facing checkout flows and inventory dashboards in React.",
      "I owned the checkout cart rewrite. We had severe lag when users updated item quantities because the entire component tree re-rendered.",
      "React uses the virtual DOM and reconciliation with diffing algorithm to update only changed nodes, but in our case, parent state changes were triggering child re-renders unnecessarily.",
      "We wrapped our cart items in React.memo and moved state down to leaf components using Zustand.",
      "Wait, isn't React always faster than vanilla JavaScript because of reconciliation?",
      "Right, right, vanilla JS doing direct DOM manipulation is actually faster for simple DOM nodes because it doesn't have the overhead of creating virtual DOM objects and diffing trees.",
      "On the backend with Node.js, we handled payment webhooks using an event loop with asynchronous I/O.",
      "Node.js runs on a single thread using libuv, with a pool of 4 worker threads for filesystem and crypto operations.",
      "If someone runs CPU-heavy JSON parsing or encryption on the main thread, it blocks the event loop and delays incoming HTTP requests.",
      "We solved that by offloading heavy cryptographic signature verification to Node worker threads using worker_threads module.",
      "I was the sole engineer responsible for the worker thread architecture and performance benchmarking.",
      "Can you clarify what you mean by backpressure in Node streams?",
      "Backpressure happens when the readable stream pushes data faster than the writable stream can consume it, filling up the internal buffer.",
      "We used pipeline() from stream module which automatically handles backpressure and error cleanup between streams."
    ]
  },
  {
    id: "conv-3-vinay",
    candidateName: "Vinay",
    roleDescription: "Fresher / Junior — Video player comments, WebSockets, useEffect cleanup & time complexity",
    turns: [
      "Hello Vasanth sir. I am Vinay. I recently graduated in computer science and I'm looking for junior developer roles.",
      "I built a YouTube clone as my final year capstone project using React, Node.js, and MongoDB.",
      "I built the video player page and the real-time comment section where users can post comments under videos.",
      "For comments, we stored comments in MongoDB with a parent_id field referencing the master comment for replies.",
      "When a new comment is posted while someone is reading, we used WebSockets to broadcast the new comment to all connected viewers.",
      "If 10,000 users are watching a viral video and commenting at the same time, broadcasting every single comment creates thousands of WebSocket messages per second.",
      "Honestly sir, I'm not sure how big companies handle this. Could you give me a small hint?",
      "Ah! Polling in batches or throttling the comment stream so the UI updates every 3 to 5 seconds instead of real-time for every single comment!",
      "In React, I used useEffect to establish the WebSocket connection on component mount.",
      "In the cleanup function of useEffect, I called socket.disconnect() to prevent memory leaks when the user navigates away.",
      "Wait, if the dependency array is empty, does useEffect run on every render or only on mount?",
      "It runs only once on mount, but if someone forgets the cleanup return function, every re-render creates a new socket connection.",
      "For time complexity, our comment sorting by timestamp in the client was taking O(N log N) using JavaScript array sort.",
      "On the database, we created a compound index on video_id and created_at so MongoDB returns sorted comments directly using the B-tree index.",
      "Thank you Vasanth sir, this mock interview really gave me perspective on how to think like a developer instead of just a user."
    ]
  }
];

const agent = await db.agent.findFirstOrThrow({
  where: { slug: AGENT_SLUG },
  include: { persona: true },
});
const member = await db.member.findFirstOrThrow({ where: { organizationId: agent.orgId } });
const context = await db.contextDocument.findFirst({
  where: { orgId: agent.orgId },
  orderBy: { createdAt: "desc" },
});
const config = await getAgentConfigForAgent(agent.id, agent.orgId, context?.id);
if (!config) throw new Error("Could not compile agent config");

interface TranscriptRecord {
  turnNumber: number;
  speaker: "candidate" | "vasanth";
  text: string;
  wallMs?: number;
}

const allResults: Record<string, { candidate: string; role: string; turns: TranscriptRecord[]; totalWallMs: number }> = {};

for (const conv of CONVERSATIONS) {
  console.log(`\n======================================================`);
  console.log(`RUNNING CONVERSATION: ${conv.candidateName} (${conv.id}) [Variant: ${variant}]`);
  console.log(`Profile: ${conv.roleDescription}`);
  console.log(`======================================================\n`);

  const token = `sim-${randomBytes(18).toString("hex")}`;
  const sessionId = `sim-${randomBytes(8).toString("hex")}`;

  await db.interviewSession.create({
    data: {
      id: sessionId,
      orgId: agent.orgId,
      userId: member.userId,
      agentId: agent.id,
      contextId: context?.id,
      contextName: context?.name,
      shareCode: randomBytes(9).toString("hex"),
      runtimeTokenHash: tokenHash(token),
      personaSlug: agent.persona.slug,
      personaVersion: agent.persona.version,
      agentSlug: agent.slug,
      agentVersion: agent.version,
      domainSlug: agent.domainSlug,
      domainVersion: 1,
      status: "active",
      compiledSnapshot: config,
      runtimeState: {},
      runtimeRevision: 0,
    },
  });

  const history: Array<Record<string, unknown>> = [];
  const transcript: TranscriptRecord[] = [];
  let convWallMs = 0;

  try {
    // Opening turn
    const openStart = performance.now();
    const openRes = await handleCompletions(new Request("http://localhost/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "trainertwin-runtime", messages: [{ role: "developer", content: "session-start" }], stream: false }),
    }));
    const openJson = await openRes.json() as any;
    const openText = String(openJson.choices?.[0]?.message?.content ?? "");
    const openMs = Math.round(performance.now() - openStart);
    convWallMs += openMs;

    transcript.push({ turnNumber: 0, speaker: "vasanth", text: openText, wallMs: openMs });
    history.push({ role: "assistant", content: openText });
    console.log(`[Turn 0 | Vasanth | ${openMs}ms]:\n"${openText}"\n`);

    // Candidate turns
    for (let i = 0; i < conv.turns.length; i++) {
      const candText = conv.turns[i];
      transcript.push({ turnNumber: i * 2 + 1, speaker: "candidate", text: candText });
      history.push({ role: "user", content: candText });
      console.log(`[Turn ${i * 2 + 1} | ${conv.candidateName}]:\n"${candText}"\n`);

      const tStart = performance.now();
      const res = await handleCompletions(new Request("http://localhost/api/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: "trainertwin-runtime", messages: history, stream: false }),
      }));
      const resJson = await res.json() as any;
      const vText = String(resJson.choices?.[0]?.message?.content ?? "");
      const tMs = Math.round(performance.now() - tStart);
      convWallMs += tMs;

      transcript.push({ turnNumber: i * 2 + 2, speaker: "vasanth", text: vText, wallMs: tMs });
      history.push({ role: "assistant", content: vText });
      console.log(`[Turn ${i * 2 + 2} | Vasanth | ${tMs}ms]:\n"${vText}"\n`);
    }

    allResults[conv.id] = {
      candidate: conv.candidateName,
      role: conv.roleDescription,
      turns: transcript,
      totalWallMs: convWallMs,
    };
  } finally {
    await db.interviewSession.deleteMany({ where: { id: sessionId } });
  }
}

const outPath = `web/experiments/results/simulation-15turns-${variant}.json`;
await Bun.write(new URL(`../../${outPath}`, import.meta.url), JSON.stringify(allResults, null, 2));
console.log(`\nAll 3 conversations completed! Saved transcript to ${outPath}\n`);
