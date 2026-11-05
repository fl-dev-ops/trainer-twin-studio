import { randomUUID } from "node:crypto";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { db } from "@/lib/db";
import { sendIssueReportEmail } from "@/lib/email";
import { getPostHogServer } from "@/lib/posthog-server";

/** Who hears about a user's "Report an issue". */
export const ISSUE_REPORT_TO = "devops@foreverlearning.in";
export const ISSUE_REPORT_CC = ["harini@foreverlearning.in", "cathy@foreverlearning.in"];

export type IssueAlert = {
  reportId: string;
  kind: string;
  message: string;
  pageUrl: string | null;
  /** The browser's PostHog session replay at the time of the report (posthog-js get_session_replay_url). */
  replayUrl: string | null;
  /** The call it is about (learner twin calls), for a studio link. */
  sessionId: string | null;
  user: { id: string; name: string; email: string };
  org: { id: string; name: string; slug: string } | null;
};

/**
 * PostHog's app link to one event. The project's public key stands in for its id (PostHog redirects /project/phc_…),
 * and the app lives on us.posthog.com where events are sent to us.i.posthog.com.
 */
export function posthogEventUrl(uuid: string, env = process.env) {
  const key = env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return null;
  const app = (env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com").replace("://us.i.", "://us.").replace("://eu.i.", "://eu.");
  return `${app}/project/${key}/events/${uuid}`;
}

const defaultDeps = { posthog: getPostHogServer, sendIssueReportEmail, findSession: (id: string, orgId: string) =>
  db.interviewSession.findFirst({ where: { id, orgId }, select: { id: true, agent: { select: { kind: true } } } }) };

/**
 * Sends a saved issue report to PostHog (an exception, so it shows under Error tracking → Issues, one issue per report)
 * and emails the team with the PostHog link and the session replay. Runs after the response (after()), so the person
 * reporting — maybe mid-call — never waits on it; failures are logged, the report itself is already saved.
 */
export async function alertIssueReport(input: IssueAlert, deps = defaultDeps) {
  const uuid = randomUUID();
  const posthog = deps.posthog();
  if (posthog) {
    const error = new Error(input.message.split("\n").find((line) => line.trim())?.slice(0, 200) ?? "Issue reported");
    error.name = `User report (${input.kind})`;
    posthog.captureException(error, input.user.id, {
      $exception_fingerprint: `issue-report-${input.reportId}`,
      issue_report_id: input.reportId,
      issue_kind: input.kind,
      issue_message: input.message,
      $current_url: input.pageUrl,
      replay_url: input.replayUrl,
      session_id: input.sessionId,
      org_slug: input.org?.slug ?? null,
      reporter_email: input.user.email,
    }, uuid);
    await posthog.flush().catch((error: unknown) => console.error("[issues] PostHog flush failed", error));
  }

  const session = input.sessionId && input.org ? await deps.findSession(input.sessionId, input.org.id) : null;
  const sessionUrl = session ? `https://dash.${BASE_DOMAIN}/${session.agent.kind === "TWIN" ? "twin" : "roleplay"}/sessions/${session.id}` : null;
  const sent = await deps.sendIssueReportEmail({
    to: ISSUE_REPORT_TO,
    cc: ISSUE_REPORT_CC,
    kind: input.kind,
    reporter: { name: input.user.name, email: input.user.email },
    org: input.org?.name ?? null,
    message: input.message,
    pageUrl: input.pageUrl,
    sessionUrl,
    posthogEventUrl: posthog ? posthogEventUrl(uuid) : null,
    replayUrl: input.replayUrl,
  });
  if (!sent.success) console.error("[issues] Issue report email failed", input.reportId, sent.error);
}
