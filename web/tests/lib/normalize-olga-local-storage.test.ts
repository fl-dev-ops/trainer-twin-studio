import { describe, expect, test } from "bun:test";
import { aliasKey, assertAliasChecksum, normalizeStorage } from "../../scripts/normalize-olga-local-storage";

const prefix = "trainertwin/kb/bc657406-6209-4bb8-af6f-c0d8141a17a4/";
const key = `${prefix}scenario-ingest/scenarios/example/v1/SKILL.md`;

describe("local Olga storage normalization", () => {
  test("aliases only the exact copied organization prefix", () => {
    expect(aliasKey(key)).toBe(`prod/${key}`);
    expect(aliasKey(`prod/${key}`)).toBeUndefined();
    expect(aliasKey("trainertwin/kb/other-org/object")).toBeUndefined();
    expect(aliasKey("trainertwin/kb/global/object")).toBeUndefined();
    expect(() => aliasKey(`${prefix}../other-org/object`)).toThrow();
  });
  test("refuses conflicting aliases and accepts identical hashes", () => {
    expect(() => assertAliasChecksum("abc", "abc")).not.toThrow();
    expect(() => assertAliasChecksum("abc", "def")).toThrow();
  });
  test("rewrites verified references without changing authored text or identities", () => {
    const before = { id: "original-id", version: 7, artifacts: key, nested: [key, { prose: `See ${key} for details` }], source: "roleplay-skill" };
    expect(normalizeStorage(before, new Set([key]))).toEqual({
      ...before, artifacts: `prod/${key}`, nested: [`prod/${key}`, { prose: `See ${key} for details` }],
    });
    expect(before.artifacts).toBe(key);
    expect(() => normalizeStorage(`${prefix}unverified`, new Set([key]))).toThrow();
    expect(normalizeStorage(null, new Set())).toBeNull();
  });
});
