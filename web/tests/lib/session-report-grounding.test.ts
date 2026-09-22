import { describe, expect, it } from "bun:test";
import { formatSessionReportGrounding } from "../../../lib/session-report-grounding";

describe("formatSessionReportGrounding", () => {
  it("includes scenario criteria and recorded evidence", () => {
    const snapshot = {
      persona: { id: "persona", version: 1, data: { name: "Interviewer", style: {}, decision_preferences: {} } },
      agent: {
        id: "agent",
        version: 1,
        data: {
          name: "Resume Deep Dive",
          objective: "Establish what the candidate owned.",
          opening: "Describe one project.",
          config: {
            actions: { allowed: ["probe_required_evidence", "close_session"], default: "probe_required_evidence" },
            rendering: { maximum_words: 45, maximum_question_marks: 1, one_focal_ask: true, deterministic_closing: true },
            turns: { maximum: 8 },
          },
          stages: [{
            id: "ownership",
            name: "Ownership",
            objective: "Clarify personal contribution.",
            opening: "What did you own?",
            config: {
              evidence: {
                definitions: { ownership: "Specific personal decisions and actions." },
                keys: ["ownership"],
                completion_keys: ["ownership"],
              },
              turns: { minimum: 1, maximum: 4 },
            },
          }],
        },
      },
      domain: { slug: "engineering", version: 1, data: {} },
    };

    const result = formatSessionReportGrounding(snapshot, { ownership: "partial" });

    expect(result).toContain("Scenario objective: Establish what the candidate owned.");
    expect(result).toContain("Ownership: Clarify personal contribution.");
    expect(result).toContain("ownership: Specific personal decisions and actions.");
    expect(result).toContain('"ownership": "partial"');
  });

  it("still includes evidence when an older snapshot cannot be compiled", () => {
    expect(formatSessionReportGrounding({}, { clarity: "weak" })).toContain('"clarity": "weak"');
  });
});
