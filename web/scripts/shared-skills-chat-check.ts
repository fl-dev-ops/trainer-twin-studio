import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const approvedTemp = "/private/var/folders/5g/1ftb3rfd00n1966h7sf_lp5c0000gn/T/opencode";
const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
};
assert(args.includes("--apply"), "Explicit --apply is required for paid live chat calls");
assert(option("--fixtures"), "--fixtures path is required");
assert.equal(process.env.DATABASE_URL, "postgresql://surya@localhost:5432/trainertwin_shared_skills_live_test?host=/tmp", "Refusing another database");
assert.equal(process.env.S3_BASE_PREFIX, "trainertwin-shared-skills-live-20261119", "Refusing another S3 prefix");
assert.equal(process.env.CHROMA_URL, "http://127.0.0.1:8100", "Only isolated self-hosted Chroma is allowed");
assert(!process.env.CHROMA_API_KEY, "Do not send Cloud credentials");
assert(process.env.COPILOT_SERVICE_SECRET?.trim(), "Missing runtime service secret");
const secret = process.env.COPILOT_SERVICE_SECRET;
const fixtureSchema = z.object({
  orgId: z.string().startsWith("sharedskills-live-"),
  sourceDocumentId: z.string().optional(),
  fixtures: z.array(z.object({
    label: z.string(), sessionId: z.string().min(1), agentSlug: z.string().startsWith("sharedskills-live-"),
    runtimeAttributes: z.record(z.string(), z.unknown()).optional(),
  })).min(1),
});
const fixtures = fixtureSchema.parse(JSON.parse(await readFile(resolve(option("--fixtures")!), "utf8")));
const reportPath = resolve(option("--report") ?? `${approvedTemp}/shared-skills-chat-report.json`);
assert(reportPath.startsWith(`${approvedTemp}/`), "Report must be in approved private temp");
const priorPath = option("--prior-report");
const prior = priorPath ? objectFromJson(await readFile(resolve(priorPath), "utf8")) : {};
function objectFromJson(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "Invalid prior report");
  return value as Record<string, unknown>;
}
const priorCounts = prior.counts && typeof prior.counts === "object" ? prior.counts as Record<string, unknown> : {};
const priorRequests = typeof priorCounts.requests === "number" ? priorCounts.requests : 0;
const turnsPerSession = Number(option("--turns") ?? 3);
assert(Number.isInteger(turnsPerSession) && turnsPerSession >= 1 && turnsPerSession <= 3, "--turns must be 1..3");
const secretValues = Object.entries(process.env)
  .filter(([key, value]) => /SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|DATABASE_URL/.test(key) && value && value.length > 5)
  .map(([, value]) => value!);
const redact = (text: string) => secretValues.reduce((out, value) => out.replaceAll(value, "[REDACTED]"), text)
  .replaceAll(Buffer.from(`${fixtures.orgId}:${secret}`).toString("base64"), "[REDACTED]");
const excerpt = (error: unknown) => redact(error instanceof Error ? error.message : String(error)).slice(0, 200);
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function frozenExamples(value: unknown) {
  assert(Array.isArray(value), "Expected examples array");
  return value.map((entry) => {
    return Object.fromEntries(Object.entries(object(entry)).filter(([key]) => key !== "score"));
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
type Fixture = z.infer<typeof fixtureSchema>["fixtures"][number];
type Check = { name: string; status: "passed" | "failed"; durationMs: number; category?: string; error?: string };
const report = {
  orgId: fixtures.orgId, startedAt: new Date().toISOString(), finishedAt: "", status: "running",
  transport: "Basic-authenticated OpenAI-compatible SSE; actual Eve durable sessions",
  checks: [] as Check[], sessions: [] as Record<string, unknown>[],
  priorRun: priorPath ? { path: resolve(priorPath), requests: priorRequests, modelStepsUnknown: true } : null,
  counts: { requests: priorRequests, successfulTurns: 0, observedModelSteps: typeof priorCounts.observedModelSteps === "number" ? priorCounts.observedModelSteps : 0 },
  limits: { maxRequests: 20, maxObservedModelSteps: 20, maxTurnsPerSession: 3, turnTimeoutMs: 120_000 },
  skipped: [] as string[],
  limitations: [
    "Synthetic text transport only; no voice, billing activation, or production attestation.",
    "Provider fixtures already pinned v1 before v2/v3 publication; this checker never republishes.",
    "The server owns internal tool/model loops; observed model steps are reported, not silently equated with HTTP calls.",
    "Observed conversation is not written back as a fabricated studio transcript.",
  ],
};
async function persist() {
  await writeFile(reportPath, redact(JSON.stringify(report, null, 2)), { mode: 0o600 });
  await chmod(reportPath, 0o600);
}
function category(message: string) {
  if (/401|403|unauthorized|authentication/i.test(message)) return "authentication";
  if (/quota|rate.limit|429|provider|model|gateway|credits/i.test(message)) return "model/provider";
  if (/tool|scenario_examples|retrieval/i.test(message)) return "tool/retrieval";
  if (/timeout|abort/i.test(message)) return "timeout";
  return "contract/persistence";
}
async function check(name: string, work: () => Promise<void>) {
  const started = performance.now();
  try {
    await work();
    report.checks.push({ name, status: "passed", durationMs: Math.round(performance.now() - started) });
  } catch (error) {
    const message = excerpt(error);
    report.checks.push({ name, status: "failed", durationMs: Math.round(performance.now() - started), category: category(message), error: message });
  }
  await persist();
  console.info(`${report.checks.at(-1)!.status}: ${name}`);
}
async function studio(fixture: Fixture, action: string, extra: Record<string, unknown> = {}) {
  const response = await fetch("http://127.0.0.1:3100/api/copilot/studio", {
    method: "POST", headers: { authorization: `Bearer ${secret}`, "x-trainertwin-org-id": fixtures.orgId, "content-type": "application/json" },
    body: JSON.stringify({ action, sessionId: fixture.sessionId, ...extra }), signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  assert(response.ok, `Studio ${action} HTTP ${response.status}: ${excerpt(text)}`);
  const body: unknown = JSON.parse(text);
  assert(!object(body).error, `Studio ${action}: ${excerpt(object(body).error)}`);
  return body;
}
async function turn(fixture: Fixture, message: string) {
  assert(report.counts.requests < report.limits.maxRequests, "Paid request budget exhausted");
  assert(report.counts.observedModelSteps < report.limits.maxObservedModelSteps, "Observed model step budget exhausted");
  report.counts.requests += 1;
  const started = performance.now();
  const response = await fetch("http://127.0.0.1:2100/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${fixtures.orgId}:${secret}`).toString("base64")}`,
      "content-type": "application/json", "x-trainertwin-session-id": fixture.sessionId,
      "x-trainertwin-agent-slug": fixture.agentSlug, "x-trainertwin-mode": "chat",
      ...(typeof fixture.runtimeAttributes?.personaSlug === "string" ? { "x-trainertwin-persona-slug": fixture.runtimeAttributes.personaSlug } : {}),
    },
    body: JSON.stringify({ model: "trainertwin-brain", stream: true, messages: [{ role: "user", content: message }] }),
    signal: AbortSignal.timeout(report.limits.turnTimeoutMs),
  });
  if (!response.ok) throw new Error(`Chat HTTP ${response.status}: ${excerpt(await response.text())}`);
  assert(response.headers.get("content-type")?.includes("text/event-stream"), "Expected SSE response");
  assert(response.body, "Missing SSE body");
  let buffer = "";
  let reply = "";
  let done = false;
  let terminal: Record<string, unknown> | undefined;
  const decoder = new TextDecoder();
  const consume = (frame: string) => {
    const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    if (data === "[DONE]") { done = true; return; }
    const chunk = object(JSON.parse(data));
    assert(!chunk.error, `Model stream error: ${excerpt(JSON.stringify(chunk.error))}`);
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const choice of choices) {
      const entry = object(choice);
      const content = object(entry.delta).content;
      if (typeof content === "string") reply += content;
      if (entry.finish_reason) terminal = chunk;
    }
  };
  const reader = response.body.getReader();
  while (true) {
    const { done: ended, value: bytes } = await reader.read();
    if (ended) break;
    buffer += decoder.decode(bytes, { stream: true }).replaceAll("\r\n", "\n");
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      consume(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consume(buffer);
  const trace = object(terminal?.brain_trace);
  const steps = Array.isArray(trace.llm_steps) ? trace.llm_steps : [];
  report.counts.observedModelSteps += steps.length;
  assert(done && terminal, `Incomplete model SSE: done=${done}, terminal=${Boolean(terminal)}, replyChars=${reply.length}`);
  assert(["delivery.handled", "delivery.completed"].includes(String(trace.status)), `Model terminal status ${String(trace.status)}: ${excerpt(JSON.stringify(trace))}`);
  assert(reply.trim().length >= 8 && /[a-z]{2}/i.test(reply), "Model returned no meaningful reply");
  const tools = Array.isArray(trace.tools_executed) ? trace.tools_executed : [];
  for (const tool of tools) {
    const output = object(object(tool).output);
    assert(!output.isError && !output.error, `Tool failure: ${excerpt(JSON.stringify(tool))}`);
  }
  report.counts.successfulTurns += 1;
  return {
    heard: message, reply: reply.trim(), durationMs: Math.round(performance.now() - started),
    model: trace.llm_model, route: trace.llm_route, modelSteps: steps.length,
    tools, toolsCalled: terminal.tools_called, retrievalTraces: terminal.retrieval_traces,
  };
}
await persist();
const { db } = await import("@/lib/db");
const labels = ["builder-roleplay", "authored-roleplay", "twin", "main-mixed", "main-empty"];
const selected = labels.flatMap((label) => fixtures.fixtures.filter((fixture) => fixture.label === label));
const calibration = fixtures.fixtures.find((fixture) => /calibration/.test(fixture.label));
if (calibration) selected.push(calibration);
else report.skipped.push("calibration: no fixture supplied");
for (const fixture of fixtures.fixtures.filter((fixture) => !selected.includes(fixture))) report.skipped.push(fixture.label);
try {
  assert(selected.length > 0, "No supported fixture labels");
  for (const fixture of selected) {
    if (report.counts.observedModelSteps >= 20 || report.counts.requests >= 20) {
      report.skipped.push(`${fixture.label}: paid call budget exhausted`);
      continue;
    }
    const sessionReport: Record<string, unknown> = { label: fixture.label, sessionId: fixture.sessionId, turns: [] };
    const observed: Awaited<ReturnType<typeof turn>>[] = [];
    sessionReport.turns = observed;
    report.sessions.push(sessionReport);
    await check(`${fixture.label}: ${turnsPerSession} verified durable turns and frozen context/examples`, async () => {
      const session = await db.interviewSession.findFirstOrThrow({
        where: { id: fixture.sessionId, orgId: fixtures.orgId, agentSlug: fixture.agentSlug },
        include: { skillPins: { include: { version: true }, orderBy: { position: "asc" } }, agent: true },
      });
      const pins = session.skillPins.map((pin) => ({ id: pin.skillVersionId, version: pin.version.version, skillHash: hash(pin.version.skillText) }));
      sessionReport.pins = pins;
      sessionReport.liveAgentVersion = session.agent.version;
      sessionReport.pinnedAgentVersion = session.agentVersion;
      const before = await studio(fixture, "getSessionContext");
      const search = () => studio(fixture, "searchScenarioItems", {
        agentSlug: fixture.agentSlug, query: "What concern should I explore before advising?", limit: 3,
      });
      const examplesBefore = object(await search()).examples;
      assert(Array.isArray(examplesBefore), "Missing examples array");
      sessionReport.examplesBefore = examplesBefore;
      const contextBefore = object(before);
      sessionReport.contextHashBefore = hash({ agent: contextBefore.agent, twinPlaybooks: contextBefore.twinPlaybooks });
      if (["builder-roleplay", "authored-roleplay", "twin"].includes(fixture.label)) {
        assert.equal(pins.length, 1);
        assert.equal(pins[0].version, 1);
        assert(session.agent.version > session.agentVersion, "Fixture must predate newer publication");
        assert(examplesBefore.length > 0, "Expected pinned source examples");
        assert(examplesBefore.every((entry) => String(object(entry).text).includes("revision 1")), "Source examples drifted from v1");
        assert(JSON.stringify(contextBefore.agent).includes("revision 1"), "Pinned instructions missing v1");
        assert(!JSON.stringify(contextBefore.agent).includes("revision 3"), "Instructions drifted to v3");
      }
      if (fixture.label === "main-empty") assert.equal(examplesBefore.length, 0, "Frozen empty catalog must stay empty");
      const messages = /calibration/.test(fixture.label)
        ? ["I am a synthetic learner unsure what concern to explore before advising. How would you start?", "Feels off", "Try a concise question about the concern instead of giving advice."]
        : ["I am a synthetic learner. I am worried about choosing a next step before understanding the main concern. Where should we begin?", "My main concern is that advice could miss what matters most. What would you ask before suggesting a next step?", "I would first ask what concern matters most and listen. Help me make that question concise without finishing the session yet."];
      for (const message of messages.slice(3 - turnsPerSession)) {
        observed.push(await turn(fixture, message));
        await persist();
      }
      const after = object(await studio(fixture, "getSessionContext"));
      sessionReport.contextHashAfter = hash({ agent: after.agent, twinPlaybooks: after.twinPlaybooks });
      assert.equal(sessionReport.contextHashAfter, sessionReport.contextHashBefore, "Pinned instructions changed during chat");
      const examplesAfter = object(await search()).examples;
      sessionReport.examplesAfter = examplesAfter;
      assert.deepEqual(frozenExamples(examplesAfter), frozenExamples(examplesBefore), "Pinned source examples changed during chat");
      assert.deepEqual((await db.sessionSkill.findMany({
        where: { sessionId: fixture.sessionId }, orderBy: { position: "asc" }, select: { skillVersionId: true },
      })).map((pin) => pin.skillVersionId), pins.map((pin) => pin.id));
    });
    await check(`${fixture.label}: actual studio evidence and persisted session state`, async () => {
      const evidence = await db.twinTurnEvidence.findMany({
        where: { sessionId: fixture.sessionId, session: { orgId: fixtures.orgId } }, orderBy: { createdAt: "asc" },
        select: { data: true },
      });
      sessionReport.studioEvidence = evidence;
      const row = await db.interviewSession.findFirstOrThrow({
        where: { id: fixture.sessionId, orgId: fixtures.orgId },
        select: { status: true, transcript: true, reportStatus: true, report: true },
      });
      sessionReport.persistedSession = row;
      if (["twin", "main-mixed", "main-empty"].includes(fixture.label) && observed.length) {
        for (const result of observed) {
          assert(evidence.some((entry) => object(entry.data).reply === result.reply), "Actual studio turn evidence missing");
        }
      }
    });
  }
} catch (error) {
  report.checks.push({ name: "setup", status: "failed", durationMs: 0, category: category(excerpt(error)), error: excerpt(error) });
} finally {
  report.finishedAt = new Date().toISOString();
  report.status = report.checks.some((entry) => entry.status === "failed") ? "failed" : report.skipped.some((entry) => entry.includes("budget")) ? "partial" : "passed";
  await persist();
  await db.$disconnect();
}
console.info(JSON.stringify({ status: report.status, counts: report.counts, reportPath }));
process.exitCode = report.status === "passed" ? 0 : 1;
