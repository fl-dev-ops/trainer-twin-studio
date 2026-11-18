import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { POST } from "@/app/api/copilot/studio/route";
import { browserToken, runtimeToken, tokenHash } from "@/lib/interview-sessions";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "../lib/minutes-test-db";

describe.skipIf(!localMinutesDb)("public twin studio service boundary (real database)", () => {
  let f: MinutesFixture;
  let call: { id: string };
  let oldSecret: string | undefined;
  const secret = "public-studio-service-secret";
  beforeEach(async () => {
    f = minutesFixture();
    await f.create();
    oldSecret = process.env.COPILOT_SERVICE_SECRET;
    process.env.COPILOT_SERVICE_SECRET = secret;
    await db.agent.update({ where: { id: f.twin.id }, data: { data: { publicAccess: { enabled: true, maxSeconds: 120 } } } });
    const hash = () => createHash("sha256").update(randomUUID()).digest("hex");
    call = await f.session({
      agentId: f.twin.id, agentSlug: f.twin.slug, userId: null, anonymousId: hash(), anonymousIpHash: hash(), anonymousName: "Visitor",
      mode: "voice", status: "active", chargesOrg: true, allowedSeconds: 120, startedAt: new Date(), endedAt: null,
    });
    await db.interviewSession.update({ where: { id: call.id }, data: { runtimeTokenHash: tokenHash(runtimeToken(call.id)) } });
  });
  afterEach(async () => {
    if (oldSecret === undefined) delete process.env.COPILOT_SERVICE_SECRET;
    else process.env.COPILOT_SERVICE_SECRET = oldSecret;
    await f.clean();
  });
  const request = (body: Record<string, unknown>, headers: Record<string, string> = {}) => POST(new Request("https://test/api/copilot/studio", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "x-trainertwin-org-id": f.org.id, "x-trainertwin-session-id": call.id, "x-trainertwin-runtime-token": runtimeToken(call.id), ...headers },
    body: JSON.stringify(body),
  }));
  const authorize = (headers: Record<string, string> = {}, token?: string) => request({ action: "authorizeRuntimeSession", sessionId: call.id, ...(token ? { token } : {}) }, headers);
  test("requires service authentication in addition to the runtime token", async () => {
    expect((await authorize({ authorization: "" })).status).toBe(401);
    expect((await authorize({ authorization: `Bearer ${runtimeToken(call.id)}` })).status).toBe(401);
    const response = await authorize();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ valid: true, anonymous: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  test.each(["missing", "browser", "other-session", "other-org"])("rejects %s runtime credentials", async (kind) => {
    const headers = {
      "x-trainertwin-runtime-token": kind === "missing" ? "" : kind === "browser" ? browserToken(call.id) : kind === "other-session" ? runtimeToken("different-session") : runtimeToken(call.id),
      ...(kind === "other-org" ? { "x-trainertwin-org-id": "different-org" } : {}),
    };
    expect((await authorize(headers)).status).toBe(401);
  });
  test("supports the explicit runtime token body contract", async () => {
    expect((await authorize({ "x-trainertwin-runtime-token": "" }, runtimeToken(call.id))).status).toBe(200);
  });
  test.each(["expired", "deleted", "completed", "failed", "activating"])("refuses %s session", async (state) => {
    await db.interviewSession.update({ where: { id: call.id }, data: {
      ...(state === "expired" ? { startedAt: new Date(Date.now() - 121_000) } : {}),
      ...(state === "deleted" ? { deletedAt: new Date() } : {}),
      ...(["completed", "failed", "activating"].includes(state) ? { status: state } : {}),
    } });
    expect((await authorize()).status).toBe(401);
  });
  test.each([
    { action: "readDocument", documentId: "private-doc" },
    { action: "readKnowledgeDocument", documentId: "private-doc" },
    { action: "searchKnowledge", knowledgeBase: "private", query: "secret", limit: 1 },
    { action: "resolveUpload", sessionId: "placeholder", documentId: "private-doc" },
    { action: "getWorkspaceState", sessionId: "placeholder" },
    { action: "listResumeClaims", sessionId: "placeholder" },
    { action: "enqueueWorkspaceCommand", sessionId: "placeholder", callId: "command", tool: "read_file" },
  ])("anonymous allowlist rejects $action", async (body) => {
    expect((await request({ ...body, ...("sessionId" in body ? { sessionId: call.id } : {}) })).status).toBe(403);
  });
  test("allowed actions cannot override the pinned agent, persona or session", async () => {
    for (const body of [
      { action: "getSessionContext", agentSlug: "other-agent" },
      { action: "getSessionContext", personaSlug: "other-persona" },
      { action: "getSessionContext", sessionId: "other-session" },
      { action: "searchScenarioItems", agentSlug: "other-agent", query: "test", limit: 1 },
    ]) expect((await request(body)).status).toBe(403);
  });
  test("the public allowlist retains harmless session capability queries", async () => {
    const response = await request({ action: "isCalibrationSession", sessionId: call.id });
    expect(response.status).toBe(200);
  });
});
