import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SwitchAccountButton } from "@/components/auth/switch-account-button";
import { HomeRedirect } from "@/components/session/home-redirect";
import { TwinSession } from "@/components/session/twin-session";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BASE_DOMAIN, signInUrl } from "@/lib/base-domain";
import { db } from "@/lib/db";
import { isStudioRole } from "@/lib/org";
import { resolveSessionUser } from "@/lib/session-user";
import { resolveTwinPath, TwinAccessError, twinAssignmentCode } from "@/lib/twin-access";

export const dynamic = "force-dynamic";

/**
 * A twin's readable link: /t/<username> (the trainer's main twin, all skills) or /t/<slug> (a skill twin).
 * Opens only for people in this org with an active assignment on the twin; they talk on their own minutes.
 * Studio members (admin, team) have no assignment and try twins in the studio instead.
 */
export default async function TwinLinkPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const host = (await headers()).get("host") ?? "";
  const { org, user } = await resolveSessionUser();
  if (!user) redirect(signInUrl(host, `/t/${encodeURIComponent(slug)}`));

  const twin = org ? await resolveTwinPath(org.id, org.slug, slug) : null;
  if (!org || !twin) return <Unavailable title="Twin not found" message="This link doesn't open a twin." />;

  const membership = await db.member.findFirst({ where: { organizationId: org.id, userId: user.id }, select: { role: true } });
  if (isStudioRole(membership?.role)) {
    const agent = await db.agent.findUniqueOrThrow({ where: { id: twin.agentId }, select: { slug: true } });
    const port = host.includes(":") ? `:${host.split(":")[1]}` : "";
    redirect(`https://dash.${BASE_DOMAIN}${port}/talk?agent=${encodeURIComponent(agent.slug)}`);
  }

  const code = await twinAssignmentCode({ orgId: org.id, user, agentId: twin.agentId }).catch((error: unknown) => {
    if (error instanceof TwinAccessError) return error;
    throw error;
  });
  if (code instanceof TwinAccessError) {
    return (
      <Unavailable
        title="Twin not available"
        message={`${code.message}. You are signed in as ${user.email}.`}
        returnTo={signInUrl(host, `/t/${encodeURIComponent(slug)}`)}
      />
    );
  }
  return <TwinSession orgId={org.id} agentId={twin.agentId} code={code} userName={user.name} />;
}

function Unavailable({ title, message, returnTo }: { title: string; message: string; returnTo?: string }) {
  return (
    <main className="grid min-h-svh place-items-center p-4">
      <Card className="w-full max-w-md text-center">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>
            {message}
            <HomeRedirect />
          </CardDescription>
        </CardHeader>
        {returnTo ? (
          <CardContent>
            <SwitchAccountButton returnTo={returnTo} />
          </CardContent>
        ) : null}
      </Card>
    </main>
  );
}
