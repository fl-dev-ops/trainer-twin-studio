import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("@/lib/use-refresh", () => ({ useRefresh: () => () => {} }));
mock.module("@/components/calibration/calibration-call", () => ({ CalibrationCall: () => null }));
const { TwinLearnerFlow } = await import("@/components/twin/twin-learner-flow");
const trainer = { name: "Trainer", title: null, bio: null, photoUrl: null };
const twin = { name: "Twin", slug: "twin", description: null };

test.each([0, 3, 4, 5, 30])("twin start button requires at least five minutes (%s left)", (minutesLeft) => {
  const html = renderToStaticMarkup(<TwinLearnerFlow path="twin" trainer={trainer} twin={twin} access={{ ok: true, preview: false, name: "Learner", email: "learner@example.com", code: "code", minutesLeft, minutesTotal: 30 }} />);
  const button = html.match(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*?Start voice call[\s\S]*?<\/button>/i)?.[0];
  expect(button).toBeDefined();
  expect(button!.includes('disabled=""')).toBe(minutesLeft < 5);
});

test("studio preview starts without a learner minute balance", () => {
  const html = renderToStaticMarkup(<TwinLearnerFlow path="twin" trainer={trainer} twin={twin} access={{ ok: true, preview: true, name: "Trainer", email: "trainer@example.com" }} />);
  const button = html.match(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*?Start voice call[\s\S]*?<\/button>/i)?.[0];
  expect(button).toBeDefined();
  expect(button).not.toContain('disabled=""');
});
