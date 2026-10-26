/**
 * 10 sessions × 10 turns latency: first message vs later turns, per model.
 *
 *   cd web && bun scripts/model-turn-latency.ts
 *
 * Override: MODELS=google/gemini-3.8-flash,openai/gpt-5-mini SESSIONS=10 TURNS=10
 */
import { db } from "../lib/db";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";

const EVE_URL = process.env.EVE_URL ?? "http://127.0.0.1:2000";
const AGENT_SLUG = process.argv[2] ?? "fundamental-knowledge";
const SESSIONS = Number(process.env.SESSIONS ?? 10);
const TURNS = Number(process.env.TURNS ?? 10);
const MODELS = (process.env.MODELS ?? "google/gemini-3.8-flash,openai/gpt-5-mini,alibaba/qwen3.7-flash,alibaba/qwen3.8-27b").split(",").map((s) => s.trim());
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 8);
const OUT = process.env.OUT ?? "../tmp/model-turn-latency.jsonl";

const REPLIES = [
  "session-start",
  "Hi, I'm Priya. I have about two years of backend experience.",
  "Mostly Java and Spring Boot, some Postgres.",
  "I built a payments API that talked to Stripe.",
  "We cached account lookups in Redis because the DB was slow.",
  "I don't know Kafka very well.",
  "p99 dropped to around 80ms after the cache.",
  "I'd shard by customer id so one noisy customer can't take everyone down.",
  "Consistency matters more than availability for payments, I think.",
  "Thanks, that helps. What should I study next?",
  "I can talk about indexes if you want.",
  "We used Flyway for migrations.",
];

const tokenHash = (t: string) => createHash("sha256").update(t).digest("hex");

type Row = {
  model: string;
  session: number;
  sessionId: string;
  turn: number;
  ttftMs: number;
  totalMs: number;
  tools: string;
  promptTokens: number;
  completionTokens: number;
  preview: string;
  error?: string;
};

async function createSession(slug: string) {
  const agent = await db.agent.findFirstOrThrow({
    where: { slug },
    include: { persona: { select: { slug: true } } },
  });
  const orgId = agent.orgId!;
  const member = await db.member.findFirstOrThrow({ where: { organizationId: orgId }, select: { userId: true } });
  const id = `lat-${randomBytes(4).toString("hex")}`;
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
  model: string,
  content: string,
): Promise<Omit<Row, "model" | "session" | "sessionId" | "turn">> {
  const secret = process.env.COPILOT_SERVICE_SECRET!;
  const auth = Buffer.from(`${session.orgId}:${secret}`).toString("base64");
  const started = performance.now();
  let firstDelta: number | null = null;
  let totalText = "";
  let tools: string[] = [];
  let promptTokens = 0;
  let completionTokens = 0;

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
          "x-trainertwin-model": model,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content }],
          stream: true,
        }),
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
          totalText += delta;
        }
        if (Array.isArray(chunk.tools_called)) {
          tools = chunk.tools_called.map((t: { name?: string }) => t.name ?? "?");
        }
        if (chunk.usage) {
          promptTokens = Number(chunk.usage.prompt_tokens ?? 0);
          completionTokens = Number(chunk.usage.completion_tokens ?? 0);
        }
      } catch {
        /* ignore */
      }
    }
  }
  return {
    ttftMs: firstDelta ?? -1,
    totalMs: performance.now() - started,
    tools: tools.join(","),
    promptTokens,
    completionTokens,
    preview: totalText.replace(/\s+/g, " ").slice(0, 70),
  };
}

function median(xs: number[]) {
  const s = xs.filter((n) => n >= 0).sort((a, b) => a - b);
  if (!s.length) return -1;
  return s[Math.floor(s.length / 2)]!;
}

function summarize(model: string, rows: Row[]) {
  const first = rows.filter((r) => r.turn === 1 && r.ttftMs >= 0);
  const later = rows.filter((r) => r.turn >= 2 && r.ttftMs >= 0);
  const failed = rows.filter((r) => r.error);
  console.log(`\n=== ${model} ===`);
  console.log(`ok ${rows.length - failed.length}/${rows.length}  failed ${failed.length}`);
  console.log(
    `turn 1     ttft median ${Math.round(median(first.map((r) => r.ttftMs)))}ms  total ${Math.round(median(first.map((r) => r.totalMs)))}ms  n=${first.length}`,
  );
  console.log(
    `turns 2-${TURNS} ttft median ${Math.round(median(later.map((r) => r.ttftMs)))}ms  total ${Math.round(median(later.map((r) => r.totalMs)))}ms  n=${later.length}`,
  );
}

mkdirSync("../tmp", { recursive: true });
writeFileSync(OUT, "");

console.log(`agent=${AGENT_SLUG} sessions=${SESSIONS} turns=${TURNS} concurrency=${CONCURRENCY} models=${MODELS.join(" | ")} out=${OUT}\n`);

const all: Row[] = [];
const ids: string[] = [];
let writeChain = Promise.resolve();
function emit(row: Row) {
  all.push(row);
  writeChain = writeChain.then(() => {
    appendFileSync(OUT, JSON.stringify(row) + "\n");
    const tag = row.error ? `FAIL ${row.error}` : `ttft=${Math.round(row.ttftMs)}ms total=${Math.round(row.totalMs)}ms tools=[${row.tools}] "${row.preview}"`;
    console.log(`${row.model} s${row.session} t${row.turn} ${tag}`);
  });
}

async function runSession(model: string, s: number) {
  const sess = await createSession(AGENT_SLUG);
  ids.push(sess.id);
  for (let t = 1; t <= TURNS; t++) {
    const content = REPLIES[t - 1] ?? `Continue. Turn ${t}.`;
    try {
      emit({ model, session: s, sessionId: sess.id, turn: t, ...(await turn(sess, model, content)) });
    } catch (err) {
      emit({
        model,
        session: s,
        sessionId: sess.id,
        turn: t,
        ttftMs: -1,
        totalMs: -1,
        tools: "",
        promptTokens: 0,
        completionTokens: 0,
        preview: "",
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
    }
  }
}

const jobs = MODELS.flatMap((model) => Array.from({ length: SESSIONS }, (_, i) => ({ model, s: i + 1 })));
const queue = [...jobs];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const job = queue.shift();
      if (!job) return;
      await runSession(job.model, job.s);
    }
  }),
);
await writeChain;

for (const model of MODELS) summarize(model, all.filter((r) => r.model === model));

await db.interviewSession.updateMany({
  where: { id: { in: ids } },
  data: { status: "abandoned", endedAt: new Date() },
});
console.log(`\nraw: ${OUT}`);
process.exit(0);
