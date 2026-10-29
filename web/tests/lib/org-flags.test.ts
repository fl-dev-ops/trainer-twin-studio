import { describe, expect, test } from "bun:test";
import { parseHideRoleplay } from "@/lib/org";

describe("parseHideRoleplay", () => {
  test("only an explicit true hides role play", () => {
    expect(parseHideRoleplay('{"hideRoleplay":true,"accentColor":"#000"}')).toBe(true);
    expect(parseHideRoleplay('{"hideRoleplay":"true"}')).toBe(false);
    expect(parseHideRoleplay('{"accentColor":"#000"}')).toBe(false);
    expect(parseHideRoleplay(null)).toBe(false);
    expect(parseHideRoleplay("not json")).toBe(false);
  });
});
