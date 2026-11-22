import { expect, test } from "bun:test";
import { skillFiles, skillPackageHash, verifySkillEnvelope } from "@/lib/skills";

const files = { "SKILL.md": "# Buyer\n", "scenario.json": '{"name":"Buyer"}\n', "items.json": "[]\n" };
const envelope = () => ({
  format: "builder-roleplay", contentHash: skillPackageHash("builder-roleplay", files),
  files, skillText: files["SKILL.md"], manifest: { name: "Buyer" }, itemCount: 0,
});

test("package hash ignores file map insertion order, not original bytes or format", () => {
  expect(skillPackageHash("builder-roleplay", Object.fromEntries(Object.entries(files).reverse()))).toBe(envelope().contentHash);
  expect(skillPackageHash("builder-roleplay", { ...files, "items.json": "[]" })).not.toBe(envelope().contentHash);
  expect(skillPackageHash("authored-roleplay", files)).not.toBe(envelope().contentHash);
  expect(skillPackageHash("builder-roleplay", { ...files, "patterns.md": "" })).not.toBe(envelope().contentHash);
  expect(envelope().contentHash).toMatch(/^[a-f0-9]{64}$/);
});

test("zero examples and exact original file strings are valid", () => {
  expect(verifySkillEnvelope(envelope())).toEqual(files);
});

test.each([
  { skillText: "changed" }, { manifest: { name: "changed" } }, { itemCount: 1 },
  { contentHash: "changed" }, { format: "unknown" }, { format: "twin" },
  { files: { ...files, "items.json": "null" } }, { files: { ...files, "scenario.json": "invalid" } },
])("refuses skill_package_unavailable for an inconsistent envelope: %j", (change) => {
  expect(() => verifySkillEnvelope({ ...envelope(), ...change })).toThrow("This skill package is not available.");
});

test.each([
  null, [], { "SKILL.md": "# Only" }, { ...files, "../secret": "no" },
  { ...files, "items.json": [] }, { ...files, "changes.json": "{}" },
].map((value) => ({ value })))("refuses skill_package_unavailable for unsafe or incomplete files: %j", ({ value }) => {
  expect(() => skillFiles(value)).toThrow("This skill package is not available.");
});
