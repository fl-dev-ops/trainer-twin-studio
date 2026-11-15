import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { formatWorkspaceState } from "../../../agent/lib/workspace-state";
import instructions from "../../../agent/instructions/session-spec";

process.env.COPILOT_SERVICE_SECRET ??= "test-secret";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("choice has a live label and absent state never claims a workspace is open", () => {
  assert.match(formatWorkspaceState({ active: "choice", key: "mcq1" }), /Multiple choice/);
  assert.match(formatWorkspaceState(null), /not reported/);
  assert.match(formatWorkspaceState({ active: null }), /Active surface: none/);
});

test("session instructions memoize configuration, but fetch workspace state again on every turn", async () => {
  let active: string | null = "choice";
  let configReads = 0;
  let stateReads = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const input = JSON.parse(String(init?.body));
    if (input.action === "getWorkspaceState") {
      stateReads++;
      return new Response(JSON.stringify({ uiState: { active, key: active ? "current-choice" : null } }));
    }
    assert.equal(input.action, "getSessionContext");
    configReads++;
    return new Response(JSON.stringify({ sessionId: "workspace-state-test", agent: { kind: "ROLEPLAY", data: { config: { interview: { type: "technical" } } } },
      uiState: { active: "code", key: "stale-cached-key" }, documents: [] }));
  }) as typeof fetch;
  const memo = new Map<string, Promise<unknown>>();
  const ctx = {
    session: { id: "workspace-state-test", auth: { current: { attributes: { orgId: "org", sessionId: "workspace-state-test" } } } },
    memo: (key: unknown, fn: () => Promise<unknown>) => {
      const id = JSON.stringify(key);
      if (!memo.has(id)) memo.set(id, fn());
      return memo.get(id);
    },
  };
  const resolve = (instructions as unknown as Record<symbol, (value: unknown) => Promise<unknown>>)[Symbol.for("eve.dynamic")];
  const first = JSON.stringify(await resolve(ctx));
  assert.match(first, /Active surface: Multiple choice/);
  assert.doesNotMatch(first, /stale-cached-key/);
  active = null;
  const second = JSON.stringify(await resolve(ctx));
  assert.match(second, /Active surface: none/);
  assert.doesNotMatch(second, /current-choice/);
  assert.equal(configReads, 1);
  assert.equal(stateReads, 2);
});
