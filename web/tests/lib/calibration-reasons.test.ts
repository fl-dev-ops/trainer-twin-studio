import { expect, test } from "bun:test";
import { OFF_REASONS, isOffReason, offReasonLabel } from "@/lib/twin/calibration-reasons";

test("four reasons, shown by label; an older answer's own label shows as saved", () => {
  expect(OFF_REASONS.map((reason) => reason.code)).toEqual(["advice", "facts", "style", "scope"]);
  expect(isOffReason("facts")).toBe(true);
  expect(isOffReason("Too generic")).toBe(false);
  expect(offReasonLabel("style")).toBe("How it's said");
  expect(offReasonLabel("Not my method")).toBe("Not my method");
});
