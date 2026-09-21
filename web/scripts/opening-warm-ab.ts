/**
 * A/B: chat-brain opening turn with vs without warmOpening.
 * Fresh InterviewSession + eve session per trial. Drains SSE; records tools_called.
 *
 * Run: cd web && bun scripts/opening-warm-ab.ts [agentSlug]
 */
import { db } from "../lib/db";
import { createHash, randomBytes } from "node:crypto";

const EVE_URL = process.env.EVE_URL ?? "http://127.0.0.1:2000";
const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3001";
const TRIALS = 3;
const tokenHash = (t: string) => createHash("sha256").update(t).digest("hex");

async function createSession(slug: string, prefix: string) {
  const agent = await db.agent.findFirstOrThrow({
    where: { slug },
    include: { persona: { select: { slug: true } } },
  });
  const orgId = agent.orgId!;
  const member = await db.member.findFirstOrThrow({ where: { organizationId: orgId }, select: { userId: true } });
  const id = `${prefix}-${randomBytes(3).toString("hex")}`;
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

async function warm(session: { id: string; orgId: string }) {
  const started = performance.now();
  const res = await fetch(`${STUDIO}/api/dev-warm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: session.id, orgId: session.orgId }),
  });
  if (!res.ok) throw new Error(`dev-warm failed: ${await res.text()}`);
  const row = await db.interviewSession.findUnique({ where: { id: session.id }, select: { warmOpening: true } });
  const wo = row?.warmOpening as { style?: unknown; surfaceQueued?: boolean } | null;
  return {
    ms: Math.round(performance.now() - started),
    styleHits: Boolean(wo?.style),
    surfaceQueued: Boolean(wo?.surfaceQueued),
  };
}

async function openTurn(session: { id: string; orgId: string; agentSlug: string; personaSlug: string }) {
  const secret = process.env.COPILOT_SERVICE_SECRET!;
  const auth = Buffer.from(`${session.orgId}:${secret}`).toString("base64");
  const started = performance.now();
  let firstDelta: number | null = null;
  let totalText = "";
  let tools: string[] = [];

  const res = await fetch(`${EVE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "content-type": "application/json",
      "x-trainertwin-session-id": session.id,
      "x-trainertwin-agent-slug": session.agentSlug,
      "x-trainertwin-persona-slug": session.personaSlug,
      "x-trainertwin-mode": "chat",
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: "session-start" }],
      stream: true,
    }),
  });
  if (!res.ok || !res.body) throw new Error(`brain ${res.status}: ${await res.text().catch(() => "")}`);

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
      } catch {
        /* ignore partial */
      }
    }
  }
  return {
    firstDeltaMs: firstDelta,
    totalMs: performance.now() - started,
    tools,
    preview: totalText.replace(/\s+/g, " ").slice(0, 80),
  };
}

const slug = process.argv[2] ?? "fundamental-knowledge";
console.log(`A/B opening-turn · agent=${slug} · trials=${TRIALS} · brain=${EVE_URL}\n`);

const rows: { kind: string; ttft: number; total: number; tools: string }[] = [];
const ids: string[] = [];

for (let i = 1; i <= TRIALS; i++) {
  const ctrlSess = await createSession(slug, `warmtest-c${i}`);
  const warmSess = await createSession(slug, `warmtest-w${i}`);
  ids.push(ctrlSess.id, warmSess.id);

  const w = await warm(warmSess);
  console.log(`trial ${i} warmChatOpening ${w.ms}ms styleHits=${w.styleHits} surfaceQueued=${w.surfaceQueued}`);
  if (!w.styleHits) {
    console.error("warm produced no style — aborting (would compare identical paths)");
    process.exit(1);
  }

  const ctrl = await openTurn(ctrlSess);
  const warmed = await openTurn(warmSess);
  console.log(
    `  control ttft=${Math.round(ctrl.firstDeltaMs ?? -1)}ms total=${Math.round(ctrl.totalMs)}ms tools=[${ctrl.tools.join(",")}] "${ctrl.preview}"`,
  );
  console.log(
    `  warm    ttft=${Math.round(warmed.firstDeltaMs ?? -1)}ms total=${Math.round(warmed.totalMs)}ms tools=[${warmed.tools.join(",")}] "${warmed.preview}"`,
  );
  rows.push(
    { kind: "control", ttft: ctrl.firstDeltaMs ?? -1, total: ctrl.totalMs, tools: ctrl.tools.join(",") },
    { kind: "warm", ttft: warmed.firstDeltaMs ?? -1, total: warmed.totalMs, tools: warmed.tools.join(",") },
  );
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const ctrl = rows.filter((r) => r.kind === "control");
const warmRows = rows.filter((r) => r.kind === "warm");
console.log("\nmedian control ttft", Math.round(median(ctrl.map((r) => r.ttft))), "ms  tools", [...new Set(ctrl.map((r) => r.tools))].join(" | "));
console.log("median warm    ttft", Math.round(median(warmRows.map((r) => r.ttft))), "ms  tools", [...new Set(warmRows.map((r) => r.tools))].join(" | "));

await db.interviewSession.updateMany({
  where: { id: { in: ids } },
  data: { status: "abandoned", endedAt: new Date() },
});
process.exit(0);
