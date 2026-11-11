import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DisconnectReason } from "livekit-client";
import ts from "typescript";

// Run the production callback with its closure inputs; React/LiveKit transport is deliberately outside this check.
const source = readFileSync(new URL("../../components/session-view.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("session-view.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback: string | undefined;
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "handleRoomDisconnected") callback = node.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
if (!callback) throw new Error("SessionView disconnect callback was not found");
const javascript = ts.transpileModule(`(function (endingRef, DisconnectReason, handleDisconnect) { ${callback}; return handleRoomDisconnected; })`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const create = new Function(`return ${javascript}`)() as (ending: { current: boolean }, reasons: typeof DisconnectReason, disconnect: (reason: string) => Promise<void>) => (reason?: DisconnectReason) => void;

test("a second tab's DUPLICATE_IDENTITY disconnect never ends the resumed call", () => {
  const end = mock(async (_reason: string) => {});
  create({ current: false }, DisconnectReason, end)(DisconnectReason.DUPLICATE_IDENTITY);
  expect(end).not.toHaveBeenCalled();
});
test.each([undefined, DisconnectReason.CLIENT_INITIATED, DisconnectReason.SERVER_SHUTDOWN])("ordinary disconnect %s still ends through the normal disconnect path", (reason) => {
  const end = mock(async (_reason: string) => {});
  create({ current: false }, DisconnectReason, end)(reason);
  expect(end).toHaveBeenCalledTimes(1); expect(end).toHaveBeenCalledWith("disconnected");
});
test("a callback during an existing end never initiates another end", () => {
  const end = mock(async (_reason: string) => {});
  create({ current: true }, DisconnectReason, end)(DisconnectReason.CLIENT_INITIATED);
  expect(end).not.toHaveBeenCalled();
});
