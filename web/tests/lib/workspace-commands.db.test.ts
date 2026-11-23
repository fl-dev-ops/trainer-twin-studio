import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as lifecycle from "@/lib/session-lifecycle";
import { randomUUID, createHmac } from "node:crypto";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";
import { claimWorkspaceCommand, completeWorkspaceCommand, enqueueWorkspaceCommand, listPendingWorkspaceCommands } from "@/lib/workspace-commands";
import { GET as readUi, POST as writeUi } from "@/app/api/sessions/[id]/ui-state/route";
import { POST as studio } from "@/app/api/copilot/studio/route";

const consumer = randomUUID();
const secret = "workspace-db-test-secret";

describe.skipIf(!localMinutesDb)("workspace commands: real database and browser-state routes", () => {
  let f: MinutesFixture;
  let session: { id: string };
  let oldSecret: string | undefined;
  beforeEach(async () => {
    f = minutesFixture(); await f.create();
    session = await f.session({ status: "active", startedAt: new Date(), endedAt: null });
    oldSecret = process.env.COPILOT_SERVICE_SECRET;
    process.env.COPILOT_SERVICE_SECRET = secret;
  });
  afterEach(async () => {
    if (oldSecret === undefined) delete process.env.COPILOT_SERVICE_SECRET; else process.env.COPILOT_SERVICE_SECRET = oldSecret;
    await f.clean();
  });
  const insert = async (patch: object = {}) => db.workspaceCommand.create({ data: {
    id: randomUUID(), sessionId: session.id, tool: "surface", input: { action: "close_surface" }, ...patch,
  } });
  const enqueue = (id: string, tool = "surface", payload: unknown = { action: "close_surface" }) => enqueueWorkspaceCommand({
    orgId: f.org.id, sessionId: session.id, callId: id, tool, payload,
  });

  test("two tabs cannot both claim a command; only the claimant can acknowledge it", async () => {
    const row = await insert();
    const other = randomUUID();
    const claims = await Promise.all([claimWorkspaceCommand(session.id, row.id, consumer), claimWorkspaceCommand(session.id, row.id, other)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const winner = claims[0] ? consumer : other;
    const loser = claims[0] ? other : consumer;
    expect(await completeWorkspaceCommand(session.id, row.id, loser, { ok: true })).toBe(false);
    expect(await completeWorkspaceCommand(session.id, row.id, winner, { ok: true })).toBe(true);
    expect(await completeWorkspaceCommand(session.id, row.id, winner, { ok: true })).toBe(true);
    expect(await completeWorkspaceCommand(session.id, row.id, winner, { ok: false }, true)).toBe(false);
    expect(await listPendingWorkspaceCommands(session.id)).toEqual([]);
    expect(await enqueue(row.id)).toEqual({ status: "completed", result: { ok: true } });
  });

  test("enqueue waits for browser execution, returns its result, and replays it", async () => {
    const id = randomUUID();
    const waiting = enqueue(id);
    // Wait for the insert, not for a fixed sleep; this models the independent browser poll.
    for (let i = 0; i < 100 && !await db.workspaceCommand.findUnique({ where: { id } }); i++) await Bun.sleep(5);
    expect(await claimWorkspaceCommand(session.id, id, consumer)).toBe(true);
    expect(await completeWorkspaceCommand(session.id, id, consumer, { ok: true, action: "close_surface" })).toBe(true);
    expect(await waiting).toEqual({ status: "completed", result: { ok: true, action: "close_surface" } });
    expect(await enqueue(id)).toEqual(await waiting);
  });

  test("global command IDs cannot leak results across sessions or accept a changed payload", async () => {
    const other = await f.session({ status: "active", startedAt: new Date(), endedAt: null });
    const foreign = await insert({ sessionId: other.id, status: "completed", result: { private: "other call" } });
    await expect(enqueue(foreign.id)).rejects.toThrow("identity conflict");
    const row = await insert({ status: "completed", result: { ok: true } });
    await expect(enqueue(row.id, "surface", { action: "open_whiteboard" })).rejects.toThrow("identity conflict");
    await expect(enqueue(row.id, "get_code_state", { action: "close_surface" })).rejects.toThrow("identity conflict");
  });

  test("a lost browser still gets a server-side call end, without faking a successful browser command", async () => {
    const closed = spyOn(lifecycle, "closeInterviewSession").mockResolvedValue(null);
    try {
      const row = await insert({ tool: "finish_session", input: {}, createdAt: new Date(Date.now() - 31_000) });
      expect(await enqueue(row.id, "finish_session", {})).toMatchObject({ status: "failed", result: { ok: false } });
      expect(closed).toHaveBeenCalledWith(session.id, "completed");
    } finally { closed.mockRestore(); }
  });

  test("server teardown observes the grace even if a browser acknowledges immediately", async () => {
    let closedAt = 0;
    const closed = spyOn(lifecycle, "closeInterviewSession").mockImplementation(async () => { closedAt = Date.now(); return null; });
    try {
      const row = await insert({ tool: "finish_session", input: {}, status: "completed", result: { ok: true }, createdAt: new Date(Date.now() - 4_700) });
      expect(await enqueue(row.id, "finish_session", {})).toMatchObject({ status: "completed" });
      expect(closedAt).toBeGreaterThanOrEqual(row.createdAt.getTime() + 5_000);
      expect(closed).toHaveBeenCalledTimes(1);
    } finally { closed.mockRestore(); }
  });

  test.each(["pending", "running"])("stale %s commands become terminal failures, never execute after reconnect", async (status) => {
    const row = await insert({ status, claimedBy: status === "running" ? consumer : null, createdAt: new Date(Date.now() - 31_000) });
    expect(await listPendingWorkspaceCommands(session.id)).toEqual([]);
    expect(await claimWorkspaceCommand(session.id, row.id, consumer)).toBe(false);
    expect(await completeWorkspaceCommand(session.id, row.id, consumer, { ok: true })).toBe(false);
    expect(await enqueue(row.id)).toMatchObject({ status: "failed", result: { ok: false, error: "Timed out waiting for the browser" } });
  });

  const params = () => ({ params: Promise.resolve({ id: session.id }) });
  const browserHeaders = () => ({ authorization: `Bearer ${createHmac("sha256", secret).update(`browser:${session.id}`).digest("base64url")}` });
  const ui = (active: string | null, revision: number) => writeUi(new Request("http://local/ui-state", {
    method: "POST", headers: browserHeaders(), body: JSON.stringify({ active, revision, key: active ? `${active}-1` : null }),
  }), params());
  test("choice is reported live, old updates cannot win, and unrelated state is kept", async () => {
    await db.interviewSession.update({ where: { id: session.id }, data: { runtimeState: { unrelated: "keep me" } } });
    expect((await ui("choice", 20)).status).toBe(200);
    expect(await (await ui("code", 10)).json()).toMatchObject({ applied: false });
    const response = await readUi(new Request("http://local/ui-state", { headers: browserHeaders() }), params());
    expect(await response.json()).toMatchObject({ uiState: { active: "choice", revision: 20 } });
    const current = await db.interviewSession.findUniqueOrThrow({ where: { id: session.id }, select: { runtimeState: true } });
    expect(current.runtimeState).toMatchObject({ unrelated: "keep me", uiState: { active: "choice" } });
    const live = () => studio(new Request("http://local/api/copilot/studio", { method: "POST",
      headers: { authorization: `Bearer ${secret}`, "x-trainertwin-org-id": f.org.id },
      body: JSON.stringify({ action: "getWorkspaceState", sessionId: session.id }),
    }));
    expect(await (await live()).json()).toMatchObject({ uiState: { active: "choice" } });
    expect((await ui(null, 30)).status).toBe(200);
    expect(await (await live()).json()).toMatchObject({ uiState: { active: null, revision: 30 } });
    expect((await ui("unknown", 40)).status).toBe(400);
  });
});
