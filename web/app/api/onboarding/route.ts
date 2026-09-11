import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { auth } from "@/lib/auth";
import { ChromaTenantService } from "@/lib/chroma-tenant";
import { db } from "@/lib/db";
import {
  createNotionOAuthState,
  notionAuthorizationUrl,
} from "@/lib/notion-oauth";
import { getOrCreateOrgKnowledgeBase } from "@/lib/org-knowledge";
import { validateOrgSlug } from "@/lib/slugs";
import { startYouTubeOAuth } from "@/lib/youtube-oauth";

export const runtime = "nodejs";

function familyOrigin(requestHost: string | null, name: string) {
  // Preserve the port so local proxies (portless :NNNN) keep working.
  const port = requestHost?.includes(":")
    ? `:${requestHost.split(":")[1]}`
    : "";
  return `https://${name}.${BASE_DOMAIN}${port}`;
}

/** Live slug availability for the onboarding form. */
export async function GET(request: Request) {
  const slug =
    new URL(request.url).searchParams.get("slug")?.toLowerCase() ?? "";
  if (!slug) return NextResponse.json({ available: false });
  const problem = validateOrgSlug(slug);
  if (problem) return NextResponse.json({ available: false, reason: problem });
  const taken = await db.organization.findUnique({
    where: { slug },
    select: { id: true },
  });
  return NextResponse.json({
    available: !taken,
    reason: taken ? "That subdomain is taken" : null,
  });
}

const bodySchema = z.object({
  token: z.string().min(10),
  orgName: z.string().trim().min(1).max(80),
  slug: z.string().trim().toLowerCase(),
  knowledgeConnector: z.enum(["none", "notion", "youtube"]).default("none"),
});

/** Founder onboarding: exchange an invite token for a fresh organization. */
export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session)
    return NextResponse.json({ error: "Sign in first" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const invite = await db.founderInvite.findUnique({
    where: { token: parsed.data.token },
  });
  if (!invite || invite.acceptedAt) {
    return NextResponse.json(
      { error: "This invite is invalid or already used" },
      { status: 400 },
    );
  }
  if (
    invite.email &&
    invite.email.toLowerCase() !== session.user.email.toLowerCase()
  ) {
    return NextResponse.json(
      { error: "This invite belongs to a different email address" },
      { status: 403 },
    );
  }

  const { orgName, slug } = parsed.data;
  const problem = validateOrgSlug(slug);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  if (
    await db.organization.findUnique({ where: { slug }, select: { id: true } })
  ) {
    return NextResponse.json(
      { error: "That subdomain is taken" },
      { status: 409 },
    );
  }

  let createdOrgId: string | undefined;
  try {
    const [, org] = await db.$transaction([
      db.founderInvite.update({
        where: { token: invite.token },
        data: { acceptedAt: new Date() },
      }),
      db.organization.create({
        data: {
          id: randomUUID(),
          name: orgName,
          slug,
          createdAt: new Date(),
          members: {
            create: {
              id: randomUUID(),
              userId: session.user.id,
              role: "owner",
              createdAt: new Date(),
            },
          },
        },
      }),
    ]);
    createdOrgId = org.id;
    await ChromaTenantService.createOrgDatabase(org.id);
    const dashboard = familyOrigin((await headers()).get("host"), "dash");
    let redirect = `${dashboard}/`;

    if (parsed.data.knowledgeConnector !== "none") {
      try {
        if (parsed.data.knowledgeConnector === "notion") {
          const kb = await getOrCreateOrgKnowledgeBase(org.id);
          const state = await createNotionOAuthState(
            org.id,
            session.user.id,
            kb.id,
          );
          redirect = notionAuthorizationUrl(state);
        } else {
          redirect = await startYouTubeOAuth(org.id, session.user.id);
        }
      } catch (connectorError) {
        console.error("Could not start onboarding connector:", connectorError);
        redirect = `${dashboard}/knowledge?error=${encodeURIComponent("Workspace created, but the connector could not be started")}`;
      }
    }

    return NextResponse.json({ redirect, slug: org.slug });
  } catch {
    if (createdOrgId) {
      await ChromaTenantService.deleteOrgDatabase(createdOrgId).catch(() => {});
      await db.organization
        .delete({ where: { id: createdOrgId } })
        .catch(() => {});
    }
    await db.founderInvite
      .update({
        where: { token: invite.token },
        data: { acceptedAt: null },
      })
      .catch(() => {});
    return NextResponse.json(
      { error: "Could not create the organization" },
      { status: 500 },
    );
  }
}
