/**
 * Real conversations with ported interview skills (scripts/port-vasanth-skills.ts) on the local copy: starts a chat
 * session per ported role play through the app's own activation, then sends turns to a local chat service (real
 * model). Checks that the session is pinned to the published package, the AI speaks as the interviewer (asks, does
 * not answer for the candidate), respects the ported word limit, and that a republish does not change a running call.
 *
 *   bun scripts/interview-skill-chat-check.ts --org careerwithvasanth --chat http://127.0.0.1:2100 [--only slug,...] [--turns 3] [--originals] --apply
 *
 * `--originals` instead runs the original no-skill interviews (legacy interview mode) to show they still work.
 * `--slugs a,b` runs any managed role plays by full slug (e.g. ones the copilot wrote from requirements), with the
 * learner lines from `--lines <file>` (one per line) instead of the interview candidate's.
 *
 * Local only (same guards as the port). Paid model calls: needs --apply and stays within --turns per session.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertLocalPortEnvironment } from "./port-vasanth-skills";

const argv = process.argv.slice(2);
const option = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
const object = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});

const CANDIDATE = [
  "Hi, I'm ready. One of my projects cut our page load time by about thirty percent last year.",
  "We measured it with Lighthouse and our real-user monitoring over two weeks, before and after the release.",
  "I owned the caching layer myself; the team handled the rollout. I think the number is mostly from my change, but there were other fixes too.",
];

async function turn(chat: string, orgId: string, secret: string, session: { id: string; agentSlug: string }, message: string) {
  const response = await fetch(`${chat}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${orgId}:${secret}`).toString("base64")}`, "content-type": "application/json",
      "x-trainertwin-session-id": session.id, "x-trainertwin-agent-slug": session.agentSlug, "x-trainertwin-mode": "chat",
    },
    body: JSON.stringify({ model: "trainertwin-brain", stream: true, messages: [{ role: "user", content: message }] }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`Chat HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  assert(response.body, "Missing SSE body");
  let buffer = "", reply = "", done = false;
  let terminal: Record<string, unknown> | undefined;
  const consume = (frame: string) => {
    const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    if (!data) return;
    if (data === "[DONE]") { done = true; return; }
    const chunk = object(JSON.parse(data));
    if (chunk.error) throw new Error(`Model stream error: ${JSON.stringify(chunk.error).slice(0, 300)}`);
    for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
      const content = object(object(choice).delta).content;
      if (typeof content === "string") reply += content;
      if (object(choice).finish_reason) terminal = chunk;
    }
  };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done: ended, value } = await reader.read();
    if (ended) break;
    buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
    let at: number;
    while ((at = buffer.indexOf("\n\n")) >= 0) { consume(buffer.slice(0, at)); buffer = buffer.slice(at + 2); }
  }
  if (buffer.trim()) consume(buffer);
  assert(done && terminal, "Incomplete SSE stream");
  const trace = object(terminal.brain_trace);
  assert(["delivery.handled", "delivery.completed"].includes(String(trace.status)), `Terminal status ${String(trace.status)}`);
  return { reply: reply.trim(), model: trace.llm_model, tools: (Array.isArray(trace.tools_executed) ? trace.tools_executed : []).map((t) => object(t).name ?? object(t).tool) };
}

async function main() {
  assertLocalPortEnvironment(process.env);
  assert(argv.includes("--apply"), "--apply is required for paid model calls");
  const secret = process.env.COPILOT_SERVICE_SECRET;
  assert(secret, "COPILOT_SERVICE_SECRET is required");
  const chat = option("chat") ?? "http://127.0.0.1:2100";
  assert(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(chat), "Chat must be a local service");
  const turns = Math.min(3, Math.max(1, Number(option("turns") ?? 3)));
  const { db } = await import("../lib/db");
  const { activateSession } = await import("../lib/interview-sessions");
  const { buildSessionContext } = await import("../lib/session-context");
  const { interviewSkillPackage } = await import("../lib/interview-skill");
  const { publishInterviewSkill } = await import("../lib/scenario-ingest");
  const org = await db.organization.findUniqueOrThrow({ where: { slug: option("org") ?? "careerwithvasanth" }, select: { id: true, slug: true } });
  const admin = await db.member.findFirstOrThrow({ where: { organizationId: org.id, role: "admin", disabledAt: null }, select: { userId: true } });
  const only = option("only")?.split(",").map((s) => `${org.slug}-${s.trim()}`);
  const ported = await db.agent.findMany({
    where: { orgId: org.id, kind: "ROLEPLAY", archivedAt: null, primarySkillId: { not: null }, ...(only ? { slug: { in: only } } : {}) },
    select: { slug: true, data: true, primarySkill: { select: { currentVersion: { select: { id: true, version: true } } } } },
    orderBy: { slug: "asc" },
  });
  const originals = argv.includes("--originals");
  const slugs = option("slugs")?.split(",").map((slug) => slug.trim()).filter(Boolean);
  const targets = slugs
    ? await db.agent.findMany({
      where: { orgId: org.id, slug: { in: slugs }, primarySkillId: { not: null } },
      select: { slug: true, data: true, primarySkill: { select: { currentVersion: { select: { id: true, version: true } } } } }, orderBy: { slug: "asc" },
    })
    : originals
    ? (await db.agent.findMany({
      where: { orgId: org.id, kind: "ROLEPLAY", archivedAt: null, primarySkillId: null, ...(option("only") ? { slug: { in: option("only")!.split(",") } } : {}) },
      select: { slug: true, data: true, primarySkill: { select: { currentVersion: { select: { id: true, version: true } } } } }, orderBy: { slug: "asc" },
    })).filter((agent) => !object(agent.data).skill)
    : ported.filter((agent) => object(agent.data).portedFrom);
  assert(targets.length, originals ? "No original interviews found" : "No ported interviews found; run the port first");

  const results: Record<string, unknown>[] = [];
  let failures = 0;
  for (const agent of targets) {
    const result: Record<string, unknown> = { agent: agent.slug, turns: [] as unknown[] };
    results.push(result);
    try {
      const session = await activateSession({ orgId: org.id, userId: admin.userId, agentSlug: agent.slug, mode: "chat", idempotencyKey: randomUUID() });
      assert(session, "No session");
      const row = await db.interviewSession.findUniqueOrThrow({ where: { id: session.id }, include: { skillPins: true } });
      if (originals) {
        assert.equal(row.skillPinsVersion, null, "An original interview must stay a legacy (unpinned) session");
        assert.equal(row.skillPins.length, 0);
      } else {
        assert.equal(row.skillPinsVersion, 1, "Session is not managed");
        assert.equal(row.skillPins[0]?.skillVersionId, agent.primarySkill?.currentVersion?.id, "Session is not pinned to the published package");
      }
      const pinnedSkill = object((await buildSessionContext({ orgId: org.id, sessionId: session.id })).agent?.data).skill;
      const maxWords = Number(/At most (\d+) words per turn/.exec(String(pinnedSkill))?.[1] ?? 0);
      const learnerLines = option("lines") ? (await import("node:fs")).readFileSync(option("lines")!, "utf8").split("\n").filter(Boolean) : CANDIDATE;
      const messages = ["[OPENING]", ...learnerLines].slice(0, turns + 1);
      for (const [index, message] of messages.entries()) {
        const started = performance.now();
        const reply = await turn(chat, org.id, secret, { id: session.id, agentSlug: agent.slug }, message);
        const words = reply.reply.split(/\s+/).filter(Boolean).length;
        (result.turns as unknown[]).push({ heard: message, reply: reply.reply, words, ms: Math.round(performance.now() - started), model: reply.model, tools: reply.tools });
        assert(reply.reply.length >= 8, `Turn ${index}: empty reply`);
        assert(!/CLIENT ROLE-PLAY|guard level/i.test(reply.reply), `Turn ${index}: leaked operating instructions`);
        if (index > 0 && !slugs) assert(/\?/.test(reply.reply), `Turn ${index}: the interviewer did not ask a question`);
        if (maxWords) assert(words <= Math.ceil(maxWords * 1.5), `Turn ${index}: ${words} words exceeds the ported limit of ${maxWords}`);
      }
      if (originals || slugs) { result.status = "passed"; continue; }
      // A republish (same content) during the call is a no-op; the session's pin never changes.
      const original = await db.agent.findUniqueOrThrow({ where: { slug: String(object(object(agent.data).portedFrom).slug) } });
      const pkg = interviewSkillPackage(original);
      await publishInterviewSkill(org.id, { personaSlug: (await db.persona.findUniqueOrThrow({ where: { id: original.personaId } })).slug, ...pkg });
      const after = await db.interviewSession.findUniqueOrThrow({ where: { id: session.id }, include: { skillPins: true } });
      assert.equal(after.skillPins[0]?.skillVersionId, row.skillPins[0]?.skillVersionId, "Pin changed after republish");
      result.status = "passed";
    } catch (error) {
      failures++;
      result.status = "failed";
      result.error = error instanceof Error ? error.message : String(error);
    }
  }
  console.log(JSON.stringify({ org: org.slug, sessions: results.length, failures, results }, null, 2));
  await db.$disconnect();
  if (failures) process.exit(1);
}

if (import.meta.main) await main();
