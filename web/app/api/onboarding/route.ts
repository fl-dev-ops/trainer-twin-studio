import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { familyOrigin } from "@/lib/base-domain";
import { auth } from "@/lib/auth";
import { errorResponse, refusals } from "@/lib/errors";
import { foundOrg, slugRefusal } from "@/lib/onboarding";
import {
  createNotionOAuthState,
  notionAuthorizationUrl,
} from "@/lib/notion-oauth";
import { getOrCreateOrgKnowledgeBase } from "@/lib/org-knowledge";
import { startYouTubeOAuth } from "@/lib/youtube-oauth";

export const runtime = "nodejs";

/** Live slug availability for the onboarding form. */
export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("slug")?.toLowerCase() ?? "";
  if (!slug) return NextResponse.json({ available: false });
  const refusal = await slugRefusal(slug);
  return NextResponse.json({ available: !refusal, reason: refusal?.message ?? null });
}

const bodySchema = z.object({
  token: z.string(),
  orgName: z.string().trim().min(1).max(80),
  websiteUrl: z.string().trim().max(2048).refine((value) => {
    if (!value) return true;
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }).optional().default(""),
  slug: z.string().trim().toLowerCase(),
  knowledgeConnector: z.enum(["none", "notion", "youtube"]).default("none"),
});

/** Founder onboarding (specs/people.md rule 20): exchange a setup token for a fresh organization. */
export async function POST(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) throw refusals.signedOut();
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw refusals.invalidInput("Fill in your organization's name, website and subdomain.");
    const org = await foundOrg({
      token: parsed.data.token,
      user: session.user,
      name: parsed.data.orgName,
      slug: parsed.data.slug,
      websiteUrl: parsed.data.websiteUrl ? new URL(parsed.data.websiteUrl).toString() : null,
    });
    const dashboard = familyOrigin((await headers()).get("host") ?? "", "dash");
    // The org exists from here on: nothing below undoes it (rule 20).
    try {
      // A founder may already belong to other orgs: the studio opens in the new one (sets the session cookie).
      await auth.api.setActiveOrganization({ headers: await headers(), body: { organizationId: org.id } });
    } catch (error) {
      console.error("Could not switch to the new organization:", error);
    }
    return NextResponse.json({ redirect: await connectorStart(parsed.data.knowledgeConnector, org.id, session.user.id, dashboard), slug: org.slug });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Where the founder goes next: the chosen knowledge connector's sign-in, else the studio. */
async function connectorStart(connector: "none" | "notion" | "youtube", orgId: string, userId: string, dashboard: string) {
  if (connector === "none") return `${dashboard}/`;
  try {
    if (connector === "youtube") return await startYouTubeOAuth(orgId, userId);
    const kb = await getOrCreateOrgKnowledgeBase(orgId);
    return notionAuthorizationUrl(await createNotionOAuthState(orgId, userId, kb.id));
  } catch (error) {
    console.error("Could not start onboarding connector:", error);
    return `${dashboard}/twin/knowledge?error=${encodeURIComponent("Workspace created, but the connector could not be started")}`;
  }
}
