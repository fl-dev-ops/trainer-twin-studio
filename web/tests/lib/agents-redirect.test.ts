import { expect, test } from "bun:test";
import { roleplayPathFor } from "@/lib/agents-redirect";

test("old /agents URLs land on the same role play under /roleplay", () => {
  expect(roleplayPathFor()).toBe("/roleplay");
  expect(roleplayPathFor("fidelity")).toBe("/roleplay");
  expect(roleplayPathFor("new", "edit")).toBe("/roleplay/new");
  expect(roleplayPathFor("acme-call")).toBe("/roleplay/acme-call");
  expect(roleplayPathFor("acme-call", "edit")).toBe("/roleplay/acme-call/edit");
  expect(roleplayPathFor("acme-call", "calibrate")).toBe("/roleplay/acme-call/calibrate");
  expect(roleplayPathFor("acme-call", "calibrations", "demo")).toBe("/roleplay/acme-call/calibrations/demo");
  expect(roleplayPathFor("acme-call", "something")).toBe("/roleplay/acme-call");
});
