import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TwinSessionItem, type TwinSessionItemData } from "./twin-session-item";

const visitor: TwinSessionItemData = {
  id: "visitor-session",
  learner: "<Visitor>",
  learnerEmail: null,
  anonymous: true,
  agentSlug: "coach",
  agentName: "Coach",
  at: "2026-11-18T10:00:00.000Z",
  seconds: 90,
  questionsCount: 1,
  topics: ["Practice"],
  question: "How should I start?",
  answer: "Start with a question.",
  rating: null,
};

describe("twin visitor history", () => {
  test("renders the self-reported name safely without an account email", () => {
    const html = renderToStaticMarkup(<TwinSessionItem session={visitor} />);
    expect(html).toContain("&lt;Visitor&gt;");
    expect(html).toContain("Anonymous visitor");
    expect(html).toContain("self-reported name");
    expect(html).toContain("/twin/sessions/visitor-session");
    expect(html).not.toContain("<Visitor>");
    expect(html).not.toContain("mailto:");
  });

  test("keeps signed-in learners distinct from visitors", () => {
    const html = renderToStaticMarkup(<TwinSessionItem session={{ ...visitor, anonymous: false, learner: "Learner", learnerEmail: "learner@example.com" }} />);
    expect(html).toContain("Learner");
    expect(html).not.toContain("Anonymous visitor");
  });
});
