import { describe, expect, test } from "bun:test";
import { decodeCopilotMessage, encodeCopilotMessage, matchingSkills, slashQuery } from "@/lib/copilot-message";

describe("copilot message tags", () => {
  test("skill and files round-trip; the typed text stays as typed", () => {
    const sent = encodeCopilotMessage({
      skill: "twin-creator",
      files: [{ id: "cmw3nma4t", title: 'Session 2 · "Objection" <Workbook> & notes' }],
      text: "Update Objection Handling with this",
    });
    expect(sent.startsWith('<use-skill name="twin-creator" />\n<selected-files>\n<file id="cmw3nma4t"')).toBe(true);
    expect(decodeCopilotMessage(sent)).toEqual({
      skill: "twin-creator",
      files: [{ id: "cmw3nma4t", title: 'Session 2 · "Objection" <Workbook> & notes' }],
      text: "Update Objection Handling with this",
    });
  });

  test("a plain message is unchanged both ways", () => {
    expect(encodeCopilotMessage({ files: [], text: "hello" })).toBe("hello");
    expect(decodeCopilotMessage("hello")).toEqual({ skill: undefined, files: [], text: "hello" });
  });

  test("an unknown skill tag is left as text", () => {
    expect(decodeCopilotMessage('<use-skill name="hack" />\nhi').skill).toBeUndefined();
  });

  test("the slash menu opens on '/' with an optional filter", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/role")).toBe("role");
    expect(slashQuery("hi /role")).toBeNull();
    expect(matchingSkills("role").map((s) => s.name)).toEqual(["roleplay-creator"]);
    expect(matchingSkills("").length).toBe(2);
  });
});
