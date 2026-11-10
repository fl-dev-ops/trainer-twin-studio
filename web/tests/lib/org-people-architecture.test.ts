import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const web = join(import.meta.dir, "../..");
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "generated" || entry.name.startsWith(".")) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [path] : [];
  });
}
const allow = new Set(["lib/org-people.ts", "lib/org.ts", "lib/members.ts", "app/auth/onboarding/page.tsx"]);
const hits = (roots: string[], pattern: RegExp, excluded = new Set<string>()) => roots.flatMap((root) => sources(join(web, root))).flatMap((path) => {
  const file = relative(web, path);
  if (excluded.has(file)) return [];
  return [...readFileSync(path, "utf8").matchAll(pattern)].map((match) => `${file}:${readFileSync(path, "utf8").slice(0, match.index).split("\n").length}: ${match[0]}`);
});

test("people architecture: only the people service (and account-own membership allowlist) reads member lists", () => {
  expect(hits(["lib", "app", "workflows", "components"], /\.member\s*\.\s*(?:findMany|findFirst|findUnique|count|groupBy)\s*\(/g, allow)).toEqual([]);
});

test("people architecture: recipientEmail is absent from runtime sources and scripts", () => {
  expect(hits(["lib", "app", "workflows", "components", "scripts"], /recipientEmail/g)).toEqual([]);
});
