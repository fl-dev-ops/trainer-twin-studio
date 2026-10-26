/**
 * One Cerebras qwen3.8-27b session, 30 turns, then a gpt-4.1 quality judge.
 *   cd web && bun scripts/cerebras-30-quality.ts
 */
import { db } from "../lib/db";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const EVE_URL = process.env.EVE_URL ?? "http://127.0.0.1:2000";
const MODEL = "alibaba/qwen3.8-27b";
const AGENT_SLUG = process.argv[2] ?? "fundamental-knowledge";
const OUT = "../tmp/cerebras-30.json";

const LEARNER = [
  "session-start",
  "Hi, I'm Priya. Two years of backend, mostly Java and Spring.",
  "Okay, I think the browser sends an HTTP request and the server returns HTML.",
  "The event loop is a queue that runs callbacks one after another on a single thread.",
  "Promises are just callbacks with .then. async/await is syntax sugar over that.",
  "I don't know the difference between microtasks and macrotasks.",
  "setTimeout(fn, 0) runs before Promise.then, right? Because zero delay means now.",
  "Oh — so microtasks flush before the next macrotask. I had that backwards.",
  "Closure is when an inner function remembers variables from the outer function.",
  "I used a closure to keep a counter private in a module.",
  "var is function scoped, let is block scoped. That's the whole difference.",
  "Temporal dead zone? I think that's when you use let before the line that declares it.",
  "this in an arrow function is lexical, in a normal function it depends on the caller.",
  "I would bind this with .bind if a callback loses the object.",
  "REST is JSON over HTTP. GraphQL is also JSON but you pick the fields.",
  "PUT vs PATCH — PUT replaces the whole resource, PATCH updates some fields. I think.",
  "Idempotent means you can retry and the result stays the same. GET and PUT are, POST is not.",
  "I'm not sure about DELETE. Retrying a delete might 404 the second time but that's still fine?",
  "CORS is a server header that lets a browser on another origin call your API.",
  "I would just set Access-Control-Allow-Origin star in production to avoid CORS issues.",
  "Indexes in Postgres make WHERE faster. I'd index every column we filter on.",
  "B-tree is the default. Hash indexes are for equality only.",
  "Transactions: BEGIN, do writes, COMMIT. If something fails, ROLLBACK.",
  "Read uncommitted can see dirty data. Serializable is the strictest.",
  "I don't really know what a phantom read is.",
  "N+1 is when you query a list then query each item again in a loop.",
  "I'd fix N+1 with a join or an IN list, or dataloader if it's GraphQL.",
  "Redis is an in-memory cache. If Redis is down the app should still hit the database.",
  "Cache invalidation is the hard part. I'd use a short TTL and accept stale reads for a bit.",
  "I think I'm stronger on backend than on the browser event loop. What should I study first?",
];

const tokenHash = (t: string) => createHash("sha256").update(t).digest("hex");

async function createSession(slug: string) {
  const agent = await db.agent.findFirstOrThrow({
    where: { slug },
    include: { persona: { select: { slug: true } } },
  });
  const orgId = agent.orgId!;
  const member = await db.member.findFirstOrThrow({ where: { organizationId: orgId }, select: { userId: true } });
  const id = `c30-${randomBytes(4).toString("hex")}`;
  await db.interviewSession.create({
    data: {
      id,
      orgId,
      userId: member.userId,
      agentId: agent.id,
      shareCode: randomBytes(8).toString("hex"),
      runtimeTokenHash: tokenHash(`rt-${id}`),
      personaSlug: agent.persona.slug,
      personaVersion: 1,
      agentSlug: agent.slug,
      agentVersion: agent.version,
      domainSlug: agent.domainSlug,
      domainVersion: 1,
      status: "active",
      mode: "chat",
    },
  });
  return { id, orgId, agentSlug: agent.slug, personaSlug: agent.persona.slug };
}

async function turn(
  session: { id: string; orgId: string; agentSlug: string; personaSlug: string },
  content: string,
) {
  const secret = process.env.COPILOT_SERVICE_SECRET!;
  const auth = Buffer.from(`${session.orgId}:${secret}`).toString("base64");
  const started = performance.now();
  let firstDelta: number | null = null;
  let text = "";
  let tools: string[] = [];
  let res: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      res = await fetch(`${EVE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "content-type": "application/json",
          "x-trainertwin-session-id": session.id,
          "x-trainertwin-agent-slug": session.agentSlug,
          "x-trainertwin-persona-slug": session.personaSlug,
          "x-trainertwin-mode": "chat",
          "x-trainertwin-model": MODEL,
        },
        body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content }], stream: true }),
      });
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  if (!res?.ok || !res.body) throw new Error(`brain ${res?.status}: ${await res?.text().catch(() => "")}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
      try {
        const chunk = JSON.parse(line.slice(6));
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          if (firstDelta === null) firstDelta = performance.now() - started;
          text += delta;
        }
        if (Array.isArray(chunk.tools_called)) {
          tools = chunk.tools_called.map((t: { name?: string }) => t.name ?? "?");
        }
      } catch {
        /* ignore */
      }
    }
  }
  return { ttftMs: firstDelta ?? -1, totalMs: performance.now() - started, tools: tools.join(","), text: text.trim() };
}

function median(xs: number[]) {
  const s = xs.filter((n) => n >= 0).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : -1;
}

const sess = await createSession(AGENT_SLUG);
console.log(`session ${sess.id}  model=${MODEL}  turns=${LEARNER.length}\n`);
const turns: { turn: number; learner: string; trainer: string; ttftMs: number; totalMs: number; tools: string }[] = [];

for (let i = 0; i < LEARNER.length; i++) {
  const learner = LEARNER[i]!;
  try {
    const r = await turn(sess, learner);
    turns.push({ turn: i + 1, learner, trainer: r.text, ttftMs: r.ttftMs, totalMs: r.totalMs, tools: r.tools });
    console.log(
      `t${i + 1} ttft=${Math.round(r.ttftMs)}ms total=${Math.round(r.totalMs)}ms tools=[${r.tools}]\n  L: ${learner.slice(0, 90)}\n  T: ${r.text.replace(/\s+/g, " ").slice(0, 160)}\n`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    turns.push({ turn: i + 1, learner, trainer: "", ttftMs: -1, totalMs: -1, tools: "", });
    console.log(`t${i + 1} FAIL ${msg.slice(0, 180)}\n`);
  }
}

const ok = turns.filter((t) => t.ttftMs >= 0);
const t1 = ok.filter((t) => t.turn === 1);
const later = ok.filter((t) => t.turn >= 2);
console.log(
  `latency  t1 ttft ${Math.round(median(t1.map((t) => t.ttftMs)))}ms  later ${Math.round(median(later.map((t) => t.ttftMs)))}ms  n=${ok.length}/${turns.length}`,
);

const transcript = turns
  .map((t) => `Turn ${t.turn}\nLearner: ${t.learner === "session-start" ? "(session start)" : t.learner}\nTrainer: ${t.trainer || "(empty)"}\nTools: ${t.tools || "none"}`)
  .join("\n\n");

const judgeBody = {
  model: "openai/gpt-4.1",
  temperature: 0,
  max_tokens: 1800,
  response_format: { type: "json_object" },
  messages: [
    {
      role: "system",
      content: "You are a strict evaluator of technical interview / training conversations. Output valid JSON only.",
    },
    {
      role: "user",
      content: `Score this 30-turn training session. Agent objective: probe software engineering fundamentals (JS runtime, HTTP, data, correctness) in the trainer's voice. Be strict.

Return JSON:
{
  "scores": {
    "relevance": 1-5,
    "grounding": 1-5,
    "interview_quality": 1-5,
    "naturalness": 1-5,
    "error_handling": 1-5,
    "progress": 1-5
  },
  "overall": 1-5,
  "strengths": ["short bullets"],
  "failures": ["concrete moments that went wrong, with turn numbers"],
  "hallucinations_or_inventions": ["or empty"],
  "would_ship": true/false,
  "one_line": "verdict"
}

Rubric: relevance=responds to the latest answer; grounding=no invented learner facts; interview_quality=useful next question, doesn't repeat solved points, challenges wrong answers; naturalness=spoken, concise; error_handling=wrong answers and 'I don't know' get corrected or probed, not ignored; progress=covers ground across 30 turns instead of looping.

Transcript:
${transcript}`,
    },
  ],
};

const orKey = process.env.OPENROUTER_API_KEY;
const gwKey = process.env.AI_GATEWAY_API_KEY;
let judge: unknown = null;
if (orKey || gwKey) {
  const url = orKey ? "https://openrouter.ai/api/v1/chat/completions" : "https://ai-gateway.vercel.sh/v1/chat/completions";
  const key = orKey ?? gwKey!;
  const jr = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(judgeBody),
  });
  if (!jr.ok) {
    console.error(`judge failed ${jr.status} ${await jr.text()}`);
  } else {
    const payload = (await jr.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = payload.choices?.[0]?.message?.content ?? "{}";
    try {
      judge = JSON.parse(raw);
    } catch {
      judge = { raw };
    }
    console.log("\n=== quality ===\n" + JSON.stringify(judge, null, 2));
  }
} else {
  console.error("no OPENROUTER_API_KEY / AI_GATEWAY_API_KEY — skipped judge");
}

mkdirSync("../tmp", { recursive: true });
writeFileSync(OUT, JSON.stringify({ model: MODEL, sessionId: sess.id, turns, judge }, null, 2));
await db.interviewSession.update({ where: { id: sess.id }, data: { status: "abandoned", endedAt: new Date() } });
console.log(`\nraw ${OUT}`);
process.exit(0);
