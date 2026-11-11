import { errorResponse, refusals } from "@/lib/errors";
import { headers } from "next/headers";
import { after, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { portalSlug } from "@/lib/base-domain";
import { db } from "@/lib/db";
import { alertIssueReport } from "@/lib/issue-alerts";
import { getOrgBySlug, getSessionOrg } from "@/lib/org";

const bodySchema = z
  .object({
    kind: z.enum(["bug", "feature", "other"]).default("bug"),
    message: z.string().trim().min(5).max(5000),
    // A web page link only (it becomes a link in the alert email: practice rule 28).
    url: z.string().trim().max(2048).regex(/^https?:\/\//i, "A link must start with http:// or https://").optional().nullable(),
    // The browser's PostHog session replay, and the call the report is about (learner twin calls).
    replayUrl: z.string().trim().url().startsWith("https://").max(2048).optional().nullable(),
    sessionId: z.string().trim().max(100).optional().nullable(),
  })
  .strict();

export async function POST(request: Request) {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(refusals.invalidInput(parsed.error.issues[0]?.path[0] === "url" ? parsed.error.issues[0].message : "Please describe the issue (5–5000 characters)"));
  }

  // Attribute the report to the reporter's organization: trainers belong via
// membership; learners on an org subdomain are resolved from the host slug
// (mirrors resolveSessionUser in lib/session-user.ts).
const host = requestHeaders.get("host") ?? "";
const portalOrg = host ? await getOrgBySlug(portalSlug(host)) : null;
const homeOrg = portalOrg ? null : await getSessionOrg();

const orgId = portalOrg?.id ?? homeOrg?.id ?? null;
const report = await db.issueReport.create({
  data: {
    kind: parsed.data.kind,
    message: parsed.data.message,
    url: parsed.data.url ?? null,
    userAgent: requestHeaders.get("user-agent")?.slice(0, 500) ?? null,
    userId: session.user.id,
    orgId,
  },
  select: { id: true },
});

  // PostHog + the team's email after the response: reporting (maybe mid-call) never waits on them.
  after(async () => {
    const org = orgId ? await db.organization.findUnique({ where: { id: orgId }, select: { id: true, name: true, slug: true } }) : null;
    await alertIssueReport({
      reportId: report.id,
      kind: parsed.data.kind,
      message: parsed.data.message,
      pageUrl: parsed.data.url ?? null,
      replayUrl: parsed.data.replayUrl ?? null,
      sessionId: parsed.data.sessionId ?? null,
      user: { id: session.user.id, name: session.user.name, email: session.user.email },
      org,
    }).catch((error: unknown) => console.error("[issues] Alert failed", report.id, error));
  });

  return NextResponse.json({ id: report.id }, { status: 201 });
}