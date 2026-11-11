import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Run the actual callback with closure inputs; no browser/LiveKit transport or changed meaning of End.
const source = readFileSync(new URL("../../components/session-view.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("session-view.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback: string | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "finalizeSession" && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0].getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
if (!callback) throw new Error("SessionView finalize callback was not found");
type Entry = { role: string; text: string };
const javascript = ts.transpileModule(`(function(connection, finalizedRef, entriesRef, fetch) { return ${callback}; })`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const create = new Function(`return ${javascript}`)() as (connection: { sessionId: string } | null, finalized: { current: boolean }, entries: { current: Entry[] }, fetcher: (url: string, init: RequestInit) => Promise<Response>) => (status: "completed" | "abandoned") => Promise<void>;

test.each(["completed", "abandoned"] as const)("page finalize sends only status %s and provisional transcript, never evidence or transcriptFinal", async (status) => {
  const fetching = mock(async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }));
  const entries = [{ role: "user", text: "My answer" }];
  await create({ sessionId: "s1" }, { current: false }, { current: entries }, fetching)(status);
  expect(fetching.mock.calls[0][0]).toBe("/api/sessions/finalize");
  expect(JSON.parse(String(fetching.mock.calls[0][1].body))).toEqual({ sessionId: "s1", status, transcript: entries });
  expect(fetching.mock.calls[0][1]).toMatchObject({ method: "POST", keepalive: true });
});
test.each([59_999, 60_000, 60_001])("keepalive is enabled only below 60,000 body characters (%s)", async (size) => {
  const overhead = JSON.stringify({ sessionId: "s1", status: "abandoned", transcript: [{ role: "user", text: "" }] }).length;
  const fetching = mock(async (_url: string, _init: RequestInit) => new Response());
  await create({ sessionId: "s1" }, { current: false }, { current: [{ role: "user", text: "x".repeat(size - overhead) }] }, fetching)("abandoned");
  const init = fetching.mock.calls[0][1]; expect(String(init.body)).toHaveLength(size); expect(init.keepalive).toBe(size < 60_000);
});
test("failed finalization clears the duplicate guard so the caller can retry", async () => {
  const guard = { current: false };
  const fetching = mock(async (_url: string, _init: RequestInit) => new Response(null, { status: 500 }));
  const finalize = create({ sessionId: "s1" }, guard, { current: [] }, fetching);
  await expect(finalize("abandoned")).rejects.toThrow("Session save failed (500)"); expect(guard.current).toBe(false);
  fetching.mockResolvedValue(new Response()); await finalize("abandoned"); await finalize("abandoned");
  expect(fetching).toHaveBeenCalledTimes(2); expect(guard.current).toBe(true);
});
