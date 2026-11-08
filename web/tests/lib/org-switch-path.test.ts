import { expect, test } from "bun:test";
import { pathAfterOrgSwitch } from "@/lib/org-switch-path";

test("list and section pages stay put, query included", () => {
  expect(pathAfterOrgSwitch("/settings", "?tab=team")).toBe("/settings?tab=team");
  expect(pathAfterOrgSwitch("/users", "")).toBe("/users");
  expect(pathAfterOrgSwitch("/users/review", "")).toBe("/users/review");
  expect(pathAfterOrgSwitch("/twin/sessions", "?q=a")).toBe("/twin/sessions?q=a");
  expect(pathAfterOrgSwitch("/twin/brain/avatar", "")).toBe("/twin/brain/avatar");
  expect(pathAfterOrgSwitch("/voice/cloning/new", "")).toBe("/voice/cloning/new");
  expect(pathAfterOrgSwitch("/", "")).toBe("/");
});

test("a single record's page falls back to its list, without the record's query", () => {
  expect(pathAfterOrgSwitch("/users/uIRJs4Y5E2BzvSVrJQDNiuXnRrsZsibN", "")).toBe("/users");
  expect(pathAfterOrgSwitch("/twin/sessions/cmw6n6rui000h08i4p8ov4yjd", "")).toBe("/twin/sessions");
  expect(pathAfterOrgSwitch("/twin/olga/calibration/abc", "?turn=2")).toBe("/twin");
  expect(pathAfterOrgSwitch("/agents/some-scenario/edit", "")).toBe("/agents");
  expect(pathAfterOrgSwitch("/knowledge/olga-knowledge", "")).toBe("/knowledge");
  expect(pathAfterOrgSwitch("/roleplay/sessions/x1", "")).toBe("/roleplay/sessions");
});
