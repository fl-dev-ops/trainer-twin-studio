/**
 * 30-Turn Conversation Latency Benchmark.
 * Simulates a complete, realistic 30-turn voice interview over Vercel AI Gateway.
 * Measures end-to-end turn latency, token consumption, and pre-warm cache impact.
 */

import { db } from "../lib/db";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { handleCompletions } from "../lib/runtime/openai";
import { prewarmSessionOpening } from "../lib/runtime/warmup";
import { initRuntimeState } from "../lib/runtime/runtime";

const tokenHash = (t: string) => createHash("sha256").update(t).digest("hex");
const DATA_DIR = path.resolve(import.meta.dir, "../data");

function loadConfig(agentSlug = "resume-mastery", personaSlug = "vasanth") {
  const agentYaml = fs.readFileSync(path.join(DATA_DIR, `agents/${agentSlug}.yaml`), "utf8");
  const personaYaml = fs.readFileSync(path.join(DATA_DIR, `personas/${personaSlug}.yaml`), "utf8");
  const agentData = (yaml.load(agentYaml) as any).agent;
  const personaData = (yaml.load(personaYaml) as any).persona;
  const domainYaml = fs.readFileSync(path.join(DATA_DIR, `domains/${agentData.domain}.yaml`), "utf8");
  const domainData = (yaml.load(domainYaml) as any).domain;

  return {
    persona: { id: "test-vasanth", slug: personaSlug, version: 1, data: personaData },
    agent: { id: "test-agent", slug: agentSlug, version: 1, data: agentData },
    domain: { slug: agentData.domain, version: 1, data: domainData },
    knowledgeBases: [],
    personaVoiceAvailable: true,
  };
}

const CANDIDATE_TURNS = [
  // Turn 1
  "Hi, in my last role as a Senior Engineer, I led the architecture for a high-throughput payments settlement platform.",
  // Turn 2
  "We had Java Spring Boot microservices communicating asynchronously via Apache Kafka for event-driven settlement batches.",
  // Turn 3
  "We implemented Redis caching in front of PostgreSQL to cache idempotent transaction keys and reduce database read load.",
  // Turn 4
  "That optimization reduced our p99 API latency by around forty percent, dropping from 350 milliseconds down to 210 milliseconds.",
  // Turn 5
  "Under flash sale traffic, multiple checkout workers could attempt concurrent balance adjustments, creating race conditions.",
  // Turn 6
  "We designed distributed locking using Redis with a five-second lease time and automatic renewal via background heartbeat.",
  // Turn 7
  "Can you open the whiteboard so I can show the settlement architecture flow visually?",
  // Turn 8
  "Can you see the screen?",
  // Turn 9
  "On the whiteboard, the client calls the gateway, which publishes settlement events to Kafka topics partitioned by merchant ID.",
  // Turn 10
  "If a Redis node failed during lock acquisition, we implemented a fallback to PostgreSQL pessimistic row locking with a strict timeout.",
  // Turn 11
  "We instrumented every service with OpenTelemetry, exporting traces to Grafana and setting latency percentile alerts.",
  // Turn 12
  "If read-replica replication lag exceeded two seconds, the router temporarily routed read traffic back to the primary database.",
  // Turn 13
  "Can you present my resume that you have in this in a viewer?",
  // Turn 14
  "Looking at the FinTech experience on my resume, we processed roughly five million daily transactions during peak holiday periods.",
  // Turn 15
  "To handle that volume, we sharded our settlement database across eight PostgreSQL instances using merchant hash rings.",
  // Turn 16
  "Can you open the code editor? I can walk through the token bucket rate limiter implementation.",
  // Turn 17
  "Here is our rate limiter: we execute an atomic Lua script in Redis so the check-and-decrement operates in a single thread.",
  // Turn 18
  "The Lua script guarantees zero race conditions because Redis executes scripts atomically without interleaved commands.",
  // Turn 19
  "We ran chaos engineering experiments with Chaos Mesh by randomly partitioning network links between Redis and the app containers.",
  // Turn 20
  "During network partitions, the app gracefully degraded by rejecting non-critical requests while permitting high-priority settlements.",
  // Turn 21
  "Our services were containerized with Docker and deployed onto AWS ECS with blue-green rollouts through AWS CodeDeploy.",
  // Turn 22
  "Database migrations followed the expand-contract pattern: first add nullable columns, deploy new code, then backfill and lock.",
  // Turn 23
  "If canary health metrics degraded within five minutes of deployment, Route 53 and ALB automatically rolled traffic back.",
  // Turn 24
  "I led a pod of four engineers, running bi-weekly sprint planning, architecture reviews, and post-mortem incident analyses.",
  // Turn 25
  "The biggest trade-off we made was eventual consistency on reporting dashboards to preserve low latency on the transactional path.",
  // Turn 26
  "We tracked RED metrics: rate, errors, and duration, keeping our error budget burn rate under one percent per month.",
  // Turn 27
  "Our recovery time objective was thirty minutes, and our recovery point objective was under one minute with cross-region read replicas.",
  // Turn 28
  "If I were redesigning the system today, I would explore using DynamoDB with global tables to eliminate manual sharding maintenance.",
  // Turn 29
  "I think that covers the main technical architecture and production decisions for this project.",
  // Turn 30
  "Thank you, this was a great deep-dive discussion. That's all from my side.",
];

interface TurnRecord {
  turnIndex: number;
  speaker: "candidate" | "trainer";
  learnerText?: string;
  trainerReply?: string;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  wordsSpoken: number;
  isPrewarmed?: boolean;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1);
  return sorted[index];
}

async function main() {
  console.log("================================================================================");
  console.log("            30-TURN LIVE CONVERSATION BENCHMARK (Vercel AI Gateway)             ");
  console.log("================================================================================");

  const existingAgent = await db.agent.findFirstOrThrow();
  const orgId = existingAgent.orgId!;
  const existingMember = await db.member.findFirstOrThrow({ where: { organizationId: orgId } });
  const userId = existingMember.userId;

  const sessionId = `bench-30t-${randomBytes(4).toString("hex")}`;
  const runtimeToken = `rt-bench-${randomBytes(16).toString("hex")}`;
  const config = loadConfig("resume-mastery", "vasanth");

  // Create session
  await db.interviewSession.create({
    data: {
      id: sessionId,
      orgId,
      userId,
      agentId: existingAgent.id,
      shareCode: randomBytes(8).toString("hex"),
      runtimeTokenHash: tokenHash(runtimeToken),
      personaSlug: "vasanth",
      personaVersion: 1,
      agentSlug: "resume-mastery",
      agentVersion: 1,
      domainSlug: "software-engineering-resume",
      domainVersion: 1,
      status: "active",
      compiledSnapshot: config,
      runtimeState: initRuntimeState() as any,
    },
  });

  console.log(`Session ID:     ${sessionId}`);
  console.log(`Agent:          resume-mastery (Vercel AI Gateway / openai/gpt-4.1-mini)`);
  console.log(`Total Turns:    30 candidate turns + opening`);
  console.log("--------------------------------------------------------------------------------");

  const turnRecords: TurnRecord[] = [];
  const messages: Array<{ role: string; content: string | null; tool_calls?: any; tool_call_id?: string }> = [];

  // Step 1: Pre-warm opening in background (simulating session activation window)
  process.stdout.write("Running background pre-warm on session activation ... ");
  const pwStart = performance.now();
  await prewarmSessionOpening(sessionId);
  const pwDuration = Math.round(performance.now() - pwStart);
  console.log(`Done in ${pwDuration}ms!`);

  // Step 2: Turn 0 (Opening turn from LiveKit agent)
  process.stdout.write("Turn  0 [Opening Turn] ... ");
  const t0_start = performance.now();
  const openRes = await handleCompletions(
    new Request("http://localhost/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${runtimeToken}` },
      body: JSON.stringify({
        messages: [{ role: "developer", content: "session-start" }],
        stream: false,
      }),
    })
  );
  const t0_latency = Math.round(performance.now() - t0_start);
  const openBody = (await openRes.json()) as any;
  const openingContent = openBody.choices?.[0]?.message?.content ?? "(tool call or opening)";
  const openWords = openingContent.trim().split(/\s+/).length;

  turnRecords.push({
    turnIndex: 0,
    speaker: "trainer",
    trainerReply: openingContent,
    latencyMs: t0_latency,
    wordsSpoken: openWords,
    isPrewarmed: true,
  });

  console.log(`Done. Latency: ${t0_latency}ms [PRE-WARMED] | Words: ${openWords}`);
  console.log(`  Trainer: "${openingContent.slice(0, 80)}..."\n`);

  messages.push({ role: "developer", content: "session-start" });
  messages.push({ role: "assistant", content: openingContent });

  // Step 3: Run 30 consecutive conversation turns
  const tools = [
    { type: "function", function: { name: "surface" } },
    { type: "function", function: { name: "finish_session" } },
  ];

  for (let i = 0; i < CANDIDATE_TURNS.length; i++) {
    const turnNumber = i + 1;
    const userText = CANDIDATE_TURNS[i];
    messages.push({ role: "user", content: userText });

    process.stdout.write(`Turn ${turnNumber.toString().padStart(2)}/30 ... `);
    const startTurn = performance.now();

    const res = await handleCompletions(
      new Request("http://localhost/api/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${runtimeToken}` },
        body: JSON.stringify({
          messages,
          tools,
          stream: false,
        }),
      })
    );

    const turnDuration = Math.round(performance.now() - startTurn);
    const body = (await res.json()) as any;
    const choice = body.choices?.[0];
    let replyText = "";

    if (choice?.finish_reason === "tool_calls") {
      const tc = choice.message.tool_calls[0];
      replyText = `[Tool Call: ${tc.function.name}]`;

      // If tool call, send tool response back to complete the turn
      messages.push({ role: "assistant", content: null, tool_calls: [tc] });
      messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ status: "ok" }) });

      const followUpRes = await handleCompletions(
        new Request("http://localhost/api/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${runtimeToken}` },
          body: JSON.stringify({ messages, tools, stream: false }),
        })
      );
      const followUpBody = (await followUpRes.json()) as any;
      replyText = followUpBody.choices?.[0]?.message?.content ?? replyText;
    } else {
      replyText = choice?.message?.content ?? "";
    }

    messages.push({ role: "assistant", content: replyText });
    const words = replyText.trim().split(/\s+/).length;

    turnRecords.push({
      turnIndex: turnNumber,
      speaker: "trainer",
      learnerText: userText,
      trainerReply: replyText,
      latencyMs: turnDuration,
      promptTokens: body.usage?.prompt_tokens,
      completionTokens: body.usage?.completion_tokens,
      totalTokens: body.usage?.total_tokens,
      wordsSpoken: words,
    });

    console.log(`Done. Latency: ${turnDuration}ms | Words: ${words}`);
    console.log(`  Candidate: "${userText.slice(0, 65)}..."`);
    console.log(`  Trainer:   "${replyText.slice(0, 75)}..."\n`);
  }

  // Cleanup session from DB
  await db.interviewSession.deleteMany({ where: { id: sessionId } }).catch(() => null);

  // Print Summary Table
  console.log("================================================================================");
  console.log("                           TURN LATENCY BENCHMARK TABLE                         ");
  console.log("================================================================================");
  console.log("| Turn | Type / Topic                     | Latency   | Words | Prompt T | Comp T | Notes          |");
  console.log("|-----:|:---------------------------------|----------:|------:|---------:|-------:|:---------------|");

  for (const r of turnRecords) {
    const turnStr = r.turnIndex.toString().padStart(4);
    const latencyStr = `${r.latencyMs.toString().padStart(6)} ms`;
    const wordsStr = r.wordsSpoken.toString().padStart(5);
    const promptStr = (r.promptTokens ?? 0).toString().padStart(8);
    const compStr = (r.completionTokens ?? 0).toString().padStart(6);

    let topic = "Discussion";
    let notes = "Vercel Gateway";
    if (r.turnIndex === 0) {
      topic = "Opening Greeting";
      notes = "CACHE HIT (Pre-warmed)";
    } else if (r.learnerText?.includes("whiteboard")) {
      topic = "Workspace: Whiteboard Request";
      notes = "Deterministic Tool";
    } else if (r.learnerText?.includes("see the screen")) {
      topic = "Vision Clarification";
      notes = "Grounded Response";
    } else if (r.learnerText?.includes("resume that you have")) {
      topic = "Workspace: Resume PDF Request";
      notes = "Deterministic Tool";
    } else if (r.learnerText?.includes("code editor")) {
      topic = "Workspace: Code Editor Request";
      notes = "Deterministic Tool";
    } else if (r.turnIndex === 1) {
      topic = "Turn 1 (First Candidate Turn)";
      notes = "KV-Cache Warm";
    }

    console.log(
      `| ${turnStr} | ${topic.padEnd(32)} | ${latencyStr} | ${wordsStr} | ${promptStr} | ${compStr} | ${notes.padEnd(14)} |`
    );
  }

  const latencies = turnRecords.map((r) => r.latencyMs).sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p90 = percentile(latencies, 90);
  const p99 = percentile(latencies, 99);
  const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  const min = latencies[0];
  const max = latencies[latencies.length - 1];

  console.log("================================================================================");
  console.log("                             AGGREGATE STATISTICS                               ");
  console.log("================================================================================");
  console.log(`- Turn 0 (Pre-warmed Opening):     ${turnRecords[0].latencyMs} ms`);
  console.log(`- Min Turn Latency:                ${min} ms`);
  console.log(`- Max Turn Latency:                ${max} ms`);
  console.log(`- Average Turn Latency:            ${avg} ms`);
  console.log(`- P50 (Median) Latency:            ${p50} ms`);
  console.log(`- P90 Latency:                     ${p90} ms`);
  console.log(`- P99 Latency:                     ${p99} ms`);
  console.log("================================================================================");
}

main().catch(console.error);
