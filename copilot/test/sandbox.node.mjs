// just-bash's rg only behaves like the dev server's under Node (eve dev runs on Node; under Bun it finds nothing).
// Run: node --test test/sandbox.node.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { Bash, ReadWriteFs } from "just-bash";
import { sandboxIo } from "../agent/lib/paths.ts";

test("grep works through just-bash's own rg, the local sandbox", async () => {
  const root = mkdtempSync("/tmp/jb-");
  mkdirSync(`${root}/users/u/data/v`, { recursive: true });
  writeFileSync(`${root}/users/u/data/v/a [abc123].md`, "---\ntitle: t\n---\nspeaker_1: tell me about your project\nspeaker_2: it was a payment app\n");
  const bash = new Bash({ fs: new ReadWriteFs({ root }), cwd: "/" });
  const sb = { readTextFile: async () => null, writeTextFile: async () => {}, run: ({ command }) => bash.exec(command) };
  const hits = await sandboxIo(sb).grep(["your project", "payment"], "users/u/data");
  assert.deepEqual(hits.map((h) => h.line), [4, 5]);
  assert.equal(hits[0].path, "users/u/data/v/a [abc123].md");
  const none = await sandboxIo(sb).grep(["nothing-like-this"], "users/u/data");
  assert.deepEqual(none, []);
  // An unknown flag is a loud failure, not an empty result.
  const bad = { ...sb, run: async () => ({ stdout: "", stderr: "rg: unrecognized option '--x'", exitCode: 2 }) };
  await assert.rejects(sandboxIo(bad).grep(["x"], "users/u/data"), /search failed/);
});
