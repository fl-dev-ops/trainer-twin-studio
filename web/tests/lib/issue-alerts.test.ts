import { expect, test } from "bun:test";
import { alertIssueReport, ISSUE_REPORT_CC, ISSUE_REPORT_TO, posthogEventUrl, type IssueAlert } from "@/lib/issue-alerts";

// A user's "Report an issue" goes to PostHog (one Error tracking issue per report) and to the team's inbox, with the
// PostHog link to that very event, the session replay and the call.

process.env.NEXT_PUBLIC_POSTHOG_KEY ||= "phc_test";

const report: IssueAlert = {
  reportId: "rep-1",
  kind: "bug",
  message: "Twin session report · Olga\nReasons: Didn't understand me\nIt kept talking over me",
  pageUrl: "https://olga.trainertwin.com/t/abc",
  replayUrl: "https://us.posthog.com/project/phc_x/replay/s1?t=40",
  sessionId: "sess-1",
  user: { id: "u1", name: "Cathy", email: "cathy@example.com" },
  org: { id: "org-olga", name: "Olga", slug: "olga" },
};

function fakes(withPosthog = true) {
  const captured: { error: Error; distinctId?: string; props?: Record<string, unknown>; uuid?: string }[] = [];
  const emails: Parameters<typeof import("@/lib/email").sendIssueReportEmail>[0][] = [];
  let flushed = 0;
  const posthog = { captureException: (error: Error, distinctId?: string, props?: Record<string, unknown>, uuid?: string) => void captured.push({ error, distinctId, props, uuid }), flush: async () => void flushed++ };
  return {
    captured, emails, flushed: () => flushed,
    deps: {
      posthog: () => (withPosthog ? posthog : null) as never,
      sendIssueReportEmail: async (input: (typeof emails)[number]) => (emails.push(input), { success: true as const, data: null }) as never,
      findSession: async (id: string, orgId: string) => (orgId === "org-olga" && id === "sess-1" ? { id, agent: { kind: "TWIN" } } : null) as never,
    },
  };
}

test("one PostHog issue per report, and an email that links that event, the replay and the call", async () => {
  const f = fakes();
  await alertIssueReport(report, f.deps);
  expect(f.captured).toHaveLength(1);
  const [event] = f.captured;
  expect(event.distinctId).toBe("u1"); // the person the browser identified, so the replay sits on the same person
  expect(event.error.message).toBe("Twin session report · Olga");
  expect(event.props).toMatchObject({ $exception_fingerprint: "issue-report-rep-1", issue_report_id: "rep-1", session_id: "sess-1" });
  expect(f.flushed()).toBe(1);

  expect(f.emails).toHaveLength(1);
  const [mail] = f.emails;
  expect(mail.to).toBe(ISSUE_REPORT_TO);
  expect(mail.cc).toEqual(ISSUE_REPORT_CC);
  expect(mail.posthogEventUrl).toContain(`/events/${event.uuid}`);
  expect(mail.replayUrl).toBe(report.replayUrl);
  expect(mail.sessionUrl).toMatch(/^https:\/\/dash\..+\/twin\/sessions\/sess-1$/);
});

test("without PostHog the email still goes, without a PostHog link; an unknown call gets no session link", async () => {
  const f = fakes(false);
  await alertIssueReport({ ...report, sessionId: "someone-elses" }, f.deps);
  expect(f.emails[0].posthogEventUrl).toBeNull();
  expect(f.emails[0].sessionUrl).toBeNull();
});

test("PostHog event links use the app host and the project key", () => {
  expect(posthogEventUrl("e1", { NEXT_PUBLIC_POSTHOG_KEY: "phc_k", NEXT_PUBLIC_POSTHOG_HOST: "https://us.i.posthog.com" } as never))
    .toBe("https://us.posthog.com/project/phc_k/events/e1");
  expect(posthogEventUrl("e1", {} as never)).toBeNull();
});
