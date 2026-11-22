import { expect, test } from "bun:test";
import ts from "typescript";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
function roots(configFile: string) {
  const config = ts.readConfigFile(resolve(root, configFile), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  if (parsed.errors.length) throw new Error(ts.flattenDiagnosticMessageText(parsed.errors[0].messageText, "\n"));
  return parsed.fileNames;
}

test("production type-check excludes browser harnesses that require another service's dependencies", () => {
  const files = roots("tsconfig.json");
  expect(files.some(file => file.includes("/e2e/"))).toBe(false);
  expect(files).toContain(resolve(root, "lib/livekit-workspaces.tsx"));
  expect(files).toContain(resolve(root, "components/session-view.tsx"));
});

test("browser harnesses retain their own explicit type-check", () => {
  const files = roots("tsconfig.e2e.json");
  expect(files).toContain(resolve(root, "e2e/workspace/workspace.spec.ts"));
  expect(files).toContain(resolve(root, "e2e/workspace/fixture.tsx"));
});
