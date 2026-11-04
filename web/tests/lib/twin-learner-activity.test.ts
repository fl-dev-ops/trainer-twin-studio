import { expect, test } from "bun:test";
import { learnerActivity } from "@/lib/twin/trpc";

const session = (email: string, at: string, rating: number | null) =>
  ({ user: { email }, startedAt: new Date(at), createdAt: new Date(at), feedbackRating: rating }) as unknown as Parameters<typeof learnerActivity>[1][number];
const assignment = (email: string, user: { name: string } | null) => ({ recipientEmail: email, minutesLimit: 30, minutesUsed: 12, accessUntil: null, user: user && { ...user, image: null } });

test("learner activity: per-learner sessions, last active, mean rating; active first, never-started last", () => {
  const rows = learnerActivity(
    [assignment("idle@x.com", null), assignment("ana@x.com", { name: "Ana" })],
    // Newest first, as the page loads them; email case differs from the assignment.
    [session("Ana@x.com", "2026-11-02T10:00:00Z", 5), session("other@x.com", "2026-11-01T10:00:00Z", 1), session("ana@x.com", "2026-10-30T10:00:00Z", 4)],
  );
  expect(rows.map((r) => r.email)).toEqual(["ana@x.com", "idle@x.com"]);
  expect(rows[0]).toMatchObject({ name: "Ana", pending: false, sessions: 2, lastAt: "2026-11-02T10:00:00.000Z", helpScore: 4.5, used: 12, minutes: 30 });
  expect(rows[1]).toMatchObject({ name: "idle@x.com", pending: true, sessions: 0, lastAt: null, helpScore: null });
});
