import { expect, mock, test } from "bun:test";

let marker: number | null = 1;
let snapshot: Record<string, unknown> | null = null;
const update = mock(async () => { throw new Error("Must not attach current data"); });
const compile = mock(async () => { throw new Error("Must not read current configuration"); });
const tx = {
  $queryRaw: async () => [],
  interviewSession: { findFirst: async () => ({ skillPinsVersion: marker, compiledSnapshot: snapshot }), update },
};
mock.module("@/lib/db", () => ({
  db: {},
  withLock: async (_keys: string[], work: (client: typeof tx) => Promise<Record<string, unknown>>) => work(tx),
}));
mock.module("@/lib/specs", () => ({ getAgentConfigForAgent: compile }));
const { ensureSessionSnapshot } = await import("@/lib/session-snapshot");

test("missing managed snapshots fail 503 without attaching current data", async () => {
  marker = 1; snapshot = null;
  await expect(ensureSessionSnapshot("managed-session", "org")).rejects.toMatchObject({ code: "skill_package_unavailable", status: 503 });
  expect(compile).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});

test("an existing frozen snapshot is reused without configuration or package lookups", async () => {
  snapshot = { agent: { version: 1, data: { skill: "# Original" } }, persona: { version: 1 } };
  expect(await ensureSessionSnapshot("managed-session", "org")).toEqual(snapshot);
  expect(compile).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});
