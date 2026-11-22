import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Run with `bun scripts/check-text-roleplay.ts` from chat/. Only synthetic session data reaches the configured model.
assert(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN, "A model gateway credential is required");
const secret = crypto.randomUUID();
const org = "synthetic-text-qa";
const sessions = new Map<string, string>();
const ended = new Set<string>();
const studio = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(req) {
    if (new URL(req.url).pathname !== "/api/copilot/studio" || req.headers.get("authorization") !== `Bearer ${secret}` || req.headers.get("x-trainertwin-org-id") !== org) return new Response(null, { status: 404 });
    const { action, sessionId } = await req.json();
    const name = sessions.get(sessionId);
    if (!name) return new Response(null, { status: 404 });
    if (action === "finishSession") { ended.add(sessionId); return Response.json({ ok: true }); }
    if (action === "recordTurnEvidence") return Response.json({ ok: true });
    if (action !== "getSessionContext") return new Response(null, { status: 400 });
    return Response.json({
      sessionId, documents: [], learnerName: "Sam",
      persona: { slug: "synthetic-interviewer", version: 1, data: { name: "Riley" } },
      agent: { slug: "synthetic-practice", kind: "ROLEPLAY", version: 1, data: {
        name: "Book handoff practice", source: "scenario-ingest",
        before: { preScreenshare: false, preUpload: true, duringUpload: false },
        scenario: { trainer_role: "bookstore clerk", learner_role: "visitor" },
        skill: `# Book handoff\nYou are ${name}, a bookstore clerk. On opening, introduce yourself by name and ask the visitor for their pickup code. Remember the code across turns. If asked how to carry a heavy box of books, answer briefly and keep the pickup open. The usual script asks visitors to share their screen or attach a receipt for verification; if that is unavailable, continue using the pickup code. When they ask you to confirm the code and finish, repeat the exact code, say goodbye and end the practice with end_call.`,
      } },
    });
  },
});
const port = 2092;
const base = `http://127.0.0.1:${port}`;
// Eve allows only one dev server per app root. Keep fixture state separate from the developer's running app.
const fixtureRoot = mkdtempSync(join(tmpdir(), "trainertwin-chat-qa-"));
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  for (const name of ["agent", "prompts", "package.json"]) cpSync(name, join(fixtureRoot, name), { recursive: true });
  rmSync(join(fixtureRoot, "agent", "instrumentation"), { recursive: true }); // Keep synthetic turns out of telemetry exporters.
  symlinkSync(resolve("node_modules"), join(fixtureRoot, "node_modules"), "dir");
  assert(!(await fetch(base, { signal: AbortSignal.timeout(500) }).then(() => true, () => false)), "Port 2092 is already in use");
  server = Bun.spawn([resolve("node_modules/.bin/eve"), "dev", "--host", "127.0.0.1", "--port", String(port), "--no-ui", "--no-default-extensions"], {
    cwd: fixtureRoot, stdout: "inherit", stderr: "inherit",
    env: { ...process.env, COPILOT_SERVICE_SECRET: secret, STUDIO_URL: studio.url.origin, OTEL_SDK_DISABLED: "", LANGFUSE_PUBLIC_KEY: "", LANGFUSE_SECRET_KEY: "" },
  });
  for (let attempt = 0;; attempt++) {
    assert(server.exitCode === null, "Chat server stopped before it was ready");
    if (await fetch(base, { signal: AbortSignal.timeout(500) }).then(() => true, () => false)) break;
    assert(attempt < 120, "Chat server did not start");
    await Bun.sleep(250);
  }
  const auth = `Basic ${Buffer.from(`${org}:${secret}`).toString("base64")}`;
  async function send(sessionId: string, content: string) {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", signal: AbortSignal.timeout(60_000),
      headers: { authorization: auth, "content-type": "application/json", "x-trainertwin-session-id": sessionId, "x-trainertwin-mode": "chat" },
      body: JSON.stringify({ messages: [{ role: "user", content }] }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    let text = "";
    let finish: string | null = null;
    let done = false;
    for (const line of (await response.text()).split("\n")) {
      if (line === "data: [DONE]") { done = true; break; }
      if (!line.startsWith("data: ")) continue;
      const frame = JSON.parse(line.slice(6));
      assert(!frame.error, `Text response failed: ${JSON.stringify(frame.error)}`);
      text += frame.choices?.[0]?.delta?.content ?? "";
      finish = frame.choices?.[0]?.finish_reason ?? finish;
    }
    console.log(JSON.stringify({ input: content, reply: text, finish, done }));
    assert(text.trim(), "The learner received no reply");
    assert.equal(finish, "stop");
    assert(done, "The stream never finished");
    return text;
  }
  const primary = crypto.randomUUID(), other = crypto.randomUUID();
  sessions.set(primary, "Mira"); sessions.set(other, "Drew");
  const opening = await send(primary, "session-start");
  assert.match(opening, /\bMira\b/i); assert.match(opening, /code/i);
  await send(primary, "My pickup code is 73418. I'm not ready to finish yet.");
  const pickupCode = /\b(?:7[\s-]*3[\s-]*4[\s-]*1[\s-]*8|seven[\s-]+three[\s-]+four[\s-]+one[\s-]+eight)\b/i;
  const second = await send(other, "session-start");
  assert.match(second, /\bDrew\b/i);
  assert.doesNotMatch(second, /\bMira\b/i);
  assert.doesNotMatch(second, pickupCode);
  const followUp = await send(primary, "I forgot to attach my receipt before we started. Do I need to upload it now, or share my screen?");
  assert.match(followUp, /\b(?:no|not|don.t|can.t|without|unavailable|enough|all (?:I|we) need)\b/i);
  assert.doesNotMatch(followUp, /(?:please|go ahead and|you need to) (?:attach|upload|share)/i);
  assert(!ended.has(primary), "The role play ended before the learner was ready");
  const closing = await send(primary, "Please confirm my exact pickup code and finish now.");
  assert.match(closing, pickupCode);
  assert(ended.has(primary), "The role play did not close");
  assert(!ended.has(other), "The other conversation was closed");
  console.log("Text role play passed: two isolated openings, follow-up, recall and close.");
} finally {
  server?.kill();
  await server?.exited;
  studio.stop(true);
  rmSync(fixtureRoot, { recursive: true, force: true });
}
