import { describe, expect, test } from "bun:test";
import { describeChanges, fieldName, suggestedNames } from "../agent/lib/changes";

describe("approval card wording", () => {
  test("fields are named for the trainer, not by their keys", () => {
    expect(fieldName("voiceId")).toBe("voice");
    expect(fieldName("uploadTitle")).toBe("upload title");
    expect(suggestedNames(["voiceId", "voiceLabel", "uploadTitle"])).toBe("voice, upload title");
  });
  test("one line per change, strings unquoted, suggestions marked", () => {
    expect(describeChanges({ voiceId: "oliver", about: "Calm,\n  direct.", active: false, skip: undefined }, undefined, ["voiceId"]))
      .toBe("\nvoice → oliver (suggested)\nabout → Calm, direct.\nactive → off");
    expect(describeChanges({})).toBe("");
  });
});
