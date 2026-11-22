import { expect, test } from "bun:test";
import { scenarioItemId } from "@/lib/main-collection";

test("item ids fit the vector store's 128-byte cap: short ids unchanged, long scopes hashed and still unique", () => {
  expect(scenarioItemId("acme-call", 3, 7)).toBe("scenario_item_acme-call@v3#7");
  const scope = `skill:trainertwin-dev/kb/${"o".repeat(36)}/skills/latencytest-technical-system-design-solution-development/v1/attempt-${"a".repeat(36)}`;
  const id = scenarioItemId(scope, 1, 12);
  expect(Buffer.byteLength(id)).toBeLessThanOrEqual(128);
  expect(id).toMatch(/^scenario_item_h[0-9a-f]{40}#12$/);
  expect(scenarioItemId(scope, 1, 12)).toBe(id);
  expect(scenarioItemId(scope, 2, 12)).not.toBe(id);
});
