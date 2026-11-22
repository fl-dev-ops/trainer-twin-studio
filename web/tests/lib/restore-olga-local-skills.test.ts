import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { assertRestoreEntries, assertRestoreEnvironment, cachedEmbeddingResolver } from "../../scripts/restore-olga-local-skills";
import type { SkillMigrationEntry } from "@/lib/skill-migration";

const environment = {
  DATABASE_URL: "postgresql://surya@localhost:5432/trainertwin_olga_local?host=/tmp",
  AWS_ENDPOINT_URL_S3: "http://127.0.0.1:9100",
  S3_BUCKET: "olga-local",
  AWS_ACCESS_KEY_ID: "S3RVER",
  AWS_SECRET_ACCESS_KEY: "S3RVER",
  S3_BASE_PREFIX: "prod/trainertwin/kb",
  CHROMA_URL: "http://127.0.0.1:8101",
  CHROMA_TENANT: "default_tenant",
};
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function cache(records: Record<string, { input: string; embedding: number[]; sourceIds: string[] }>) {
  return { algorithm: "sha256", renderer: "context ? context + '\\n' + text : text", records };
}

describe("local Olga restore guards (no service connections)", () => {
  test("accepts only the explicit local environment", () => {
    expect(() => assertRestoreEnvironment(environment)).not.toThrow();
  });

  test.each([
    ["DATABASE_URL", "postgresql://surya@localhost:5432/trainertwin?host=/tmp"],
    ["DATABASE_URL", "postgresql://surya@localhost:5432/trainertwin_olga_local"],
    ["DATABASE_URL", "postgresql://surya@remote:5432/trainertwin_olga_local?host=/tmp"],
    ["DATABASE_URL", "postgresql://surya@localhost:5432/trainertwin_olga_local?host=/var/run/postgresql"],
    ["DATABASE_URL", "postgresql://surya@localhost:5432/trainertwin_olga_local?host=/tmp&options=unsafe"],
    ["DATABASE_URL", "postgresql://surya@localhost:5432/trainertwin_olga_local?host=/tmp&host=remote"],
    ["DATABASE_URL_UNPOOLED", "postgresql://surya@localhost:5432/trainertwin"],
    ["AWS_ENDPOINT_URL_S3", "https://s3.amazonaws.com"],
    ["AWS_ENDPOINT_URL", "https://s3.amazonaws.com"],
    ["S3_BUCKET", "production"],
    ["AWS_S3_BUCKET", "production"],
    ["AWS_ACCESS_KEY_ID", "real-key"],
    ["AWS_SECRET_ACCESS_KEY", "real-secret"],
    ["AWS_SESSION_TOKEN", "session-token"],
    ["S3_BASE_PREFIX", "trainertwin-dev"],
    ["CHROMA_URL", "https://api.trychroma.com"],
    ["CHROMA_TENANT", "other_tenant"],
    ["CHROMA_API_KEY", "cloud-key"],
  ])("refuses unsafe %s override", (key, value) => {
    expect(() => assertRestoreEnvironment({ ...environment, [key]: value })).toThrow();
  });

  test("preserves exact whitespace and contextual embedding inputs", () => {
    const contextual = "Opening\n Saved concern \n";
    const bare = "Saved concern";
    const resolve = cachedEmbeddingResolver(cache({
      [sha(contextual)]: { input: contextual, embedding: [0.25, 0.75], sourceIds: ["source-1"] },
      [sha(bare)]: { input: bare, embedding: [0.5, 0.5], sourceIds: ["source-2"] },
    }));
    expect(resolve([{ context: "Opening", text: " Saved concern \n" }, { context: "", text: bare }])).toEqual([[0.25, 0.75], [0.5, 0.5]]);
    expect(() => resolve([{ context: "Opening", text: "Saved concern" }])).toThrow("Missing exact imported embedding");
    expect(resolve([])).toEqual([]);
  });

  test("refuses cache keys that do not hash the saved exact input", () => {
    expect(() => cachedEmbeddingResolver(cache({
      [sha("different")]: { input: "Original", embedding: [1, 2], sourceIds: ["source"] },
    }))).toThrow("checksum");
  });

  test.each([{ embedding: [] }, { embedding: [NaN] }, { embedding: [Infinity] }])("refuses malformed cached vectors $embedding", ({ embedding }) => {
    expect(() => cachedEmbeddingResolver(cache({
      [sha("Original")]: { input: "Original", embedding, sourceIds: ["source"] },
    }))).toThrow();
  });

  test("refuses inconsistent vector dimensions before migration", () => {
    expect(() => cachedEmbeddingResolver(cache({
      [sha("First")]: { input: "First", embedding: [1, 2], sourceIds: ["first"] },
      [sha("Second")]: { input: "Second", embedding: [1], sourceIds: ["second"] },
    }))).toThrow("dimensions");
  });

  test("never falls back when cache coverage is incomplete", () => {
    const resolve = cachedEmbeddingResolver(cache({}));
    expect(() => resolve([{ context: "", text: "Missing" }])).toThrow("Missing exact imported embedding");
  });

  const missingHistory: SkillMigrationEntry = {
    slug: "objection", agentVersion: 1, current: false, required: false, status: "failed",
    contentHash: "original-package-hash", error: `Error: Missing exact imported embedding: ${sha("original input")}`,
  };

  test.each(["preflight", "apply"] as const)("accepts only missing original vectors for optional history during %s", (phase) => {
    expect(assertRestoreEntries([missingHistory], phase)).toEqual([missingHistory]);
  });

  test.each([
    { current: true, required: false },
    { current: false, required: true },
    { current: true, required: true },
  ])("refuses missing original vectors for current/required entries $current/$required", (flags) => {
    for (const phase of ["preflight", "apply", "check"] as const) {
      expect(() => assertRestoreEntries([{ ...missingHistory, ...flags }], phase, [missingHistory])).toThrow("refused");
    }
  });

  test.each([
    "Error: Cannot read original object",
    "Error: Package provenance conflicts",
    "Error: Embedding cache input checksum mismatch",
    "Error: Missing exact imported embedding: malformed",
    "Error: Corruption after Missing exact imported embedding: original",
  ])("never accepts unexpected historical errors: %s", (error) => {
    for (const phase of ["preflight", "apply", "check"] as const) {
      expect(() => assertRestoreEntries([{ ...missingHistory, error }], phase, [missingHistory])).toThrow("refused");
    }
  });

  test("allows only previously identified exact package history gaps in the final check", () => {
    const checked: SkillMigrationEntry = { ...missingHistory, status: "unmapped", error: undefined };
    const current: SkillMigrationEntry = { ...checked, agentVersion: 5, current: true, status: "verified" };
    expect(assertRestoreEntries([checked, current], "check", [missingHistory])).toEqual([checked]);
    expect(() => assertRestoreEntries([checked], "check")).toThrow("refused");
    expect(() => assertRestoreEntries([{ ...checked, contentHash: "different-package" }], "check", [missingHistory])).toThrow("refused");
    expect(() => assertRestoreEntries([{ ...checked, required: true }], "check", [missingHistory])).toThrow("refused");
    expect(() => assertRestoreEntries([{ ...checked, current: true }], "check", [missingHistory])).toThrow("refused");
  });

  test("accepts normal phase successes without declaring them unavailable", () => {
    expect(assertRestoreEntries([{ ...missingHistory, status: "unmapped", error: undefined }], "preflight")).toEqual([]);
    expect(assertRestoreEntries([{ ...missingHistory, status: "imported", error: undefined }], "apply")).toEqual([]);
    expect(assertRestoreEntries([{ ...missingHistory, status: "verified", error: undefined }], "check")).toEqual([]);
    expect(() => assertRestoreEntries([], "preflight")).toThrow("no package entries");
  });
});
