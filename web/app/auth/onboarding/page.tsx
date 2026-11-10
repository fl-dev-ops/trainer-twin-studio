import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { signInUrl } from "@/lib/base-domain";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { FounderForm } from "@/components/auth/founder-form";
import { OnboardingHeader } from "@/components/auth/onboarding-header";

export const dynamic = "force-dynamic";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{
    t?: string;
    step?: string;
    connector?: string;
    connected?: string;
    error?: string;
  }>;
}) {
  const params = await searchParams;
  const token = params.t;

  const session = await auth.api.getSession({ headers: await headers() });
  // 1. A founder invite: an unused one starts a new organization, even for someone who already runs one.
  const invite = token
    ? await db.founderInvite.findUnique({
        where: { token },
        select: { acceptedAt: true, email: true },
      })
    : null;
  const newOrg = Boolean(invite && !invite.acceptedAt);
  // Founders sign in first (Google or an email code: there are no passwords), then come back here to set up.
  if (newOrg && !session) redirect(signInUrl((await headers()).get("host") ?? "", `/onboarding?t=${encodeURIComponent(token!)}`));

  // 2. Otherwise an admin continues setting up their organization (connectors): the one they're working in.
  let userOrg: { id: string; name: string; slug: string } | null = null;
  let initialConnections = { notion: false, youtube: false };

  if (session?.user && !newOrg) {
    const admins = await db.member.findMany({
      where: { userId: session.user.id, role: "admin", disabledAt: null },
      orderBy: { createdAt: "asc" },
      include: { organization: true },
    });
    const member = admins.find((m) => m.organizationId === session.session.activeOrganizationId) ?? admins[0];
    if (member) {
      userOrg = member.organization;
      const [notionConn, youtubeConn] = await Promise.all([
        db.notionConnection.findFirst({
          where: { orgId: member.organizationId },
        }),
        db.youTubeConnection.findFirst({
          where: { orgId: member.organizationId },
        }),
      ]);
      initialConnections = {
        notion: Boolean(notionConn),
        youtube: Boolean(youtubeConn),
      };
    }
  }

  const canOnboard = newOrg || Boolean(userOrg);

  return (
    <main className="min-h-svh w-full onboarding-canvas text-foreground flex flex-col antialiased">
      {/* 1. Transparent Header Component */}
      <OnboardingHeader />

      {/* 2. Main Content Canvas (Upper-middle optical placement) */}
      <div className="relative flex-1 w-full px-8 lg:px-16 xl:px-24 pt-12 sm:pt-20 lg:pt-24 pb-16 flex flex-col items-center justify-start">
        {canOnboard ? (
          <FounderForm
            token={token ?? ""}
            email={session?.user.email ?? invite?.email ?? ""}
            name={session?.user.name ?? ""}
            connectors={{
              notion: Boolean(process.env.NOTION_OAUTH_CLIENT_ID),
              youtube: Boolean(process.env.YOUTUBE_OAUTH_CLIENT_ID),
            }}
            initialStep={userOrg ? 3 : 1}
            initialConnections={initialConnections}
            defaultOrgName={userOrg?.name ?? ""}
            defaultSlug={userOrg?.slug ?? ""}
            oauthNotice={{
              connector: params.connector,
              connected: params.connected === "true",
              error: params.error,
            }}
          />
        ) : (
          <div className="max-w-md mx-auto text-center py-16">
            <div className="size-12 rounded-2xl bg-muted border border-border text-muted-foreground flex items-center justify-center mx-auto mb-4 text-xl">
              ✉
            </div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              Invite required
            </h1>
            <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
              This link is invalid or has already been used. Ask for a fresh
              founder invite from your administrator.
            </p>
            <div className="mt-6">
              <Link
                href="/sign-in"
                className="inline-flex items-center justify-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 px-4 py-2 text-xs font-medium transition-colors"
              >
                Go to Sign in
              </Link>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
