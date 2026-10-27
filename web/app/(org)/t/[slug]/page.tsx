import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { TwinLearnerFlow, type LearnerAccess } from "@/components/twin/twin-learner-flow";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { db } from "@/lib/db";
import { isStudioRole } from "@/lib/org";
import { resolveSessionUser } from "@/lib/session-user";
import { presignedGetUrl } from "@/lib/s3";
import { resolveTwinPath, TwinAccessError, twinAssignmentCode } from "@/lib/twin-access";

export const dynamic = "force-dynamic";

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * A twin's readable link: /t/<username> (the trainer's main twin) or /t/<slug> (a skill twin). Everything happens on
 * this page, never on the auth pages: what the twin is, signing in (Google), the person's access and minutes, the call
 * and its summary with feedback. Only people in this org with an active assignment can talk; they use their own
 * minutes. Studio members (admin, team) have no assignment and try twins in the studio instead.
 */
export default async function TwinLinkPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ start?: string }> }) {
  const [{ slug }, { start }] = await Promise.all([params, searchParams]);
  const host = (await headers()).get("host") ?? "";
  const { org, user } = await resolveSessionUser();

  const twin = org ? await resolveTwinPath(org.id, org.slug, slug) : null;
  if (!org || !twin) {
    return (
      <main className="grid min-h-svh place-items-center p-4">
        <Card className="w-full max-w-md text-center">
          <CardHeader>
            <CardTitle>Twin not found</CardTitle>
            <CardDescription>This link doesn&apos;t open a twin. Ask your trainer for a new one.</CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  const agent = await db.agent.findUniqueOrThrow({
    where: { id: twin.agentId },
    select: {
      slug: true,
      name: true,
      data: true,
      persona: { select: { name: true, data: true, avatar: { select: { s3ImageKey: true } } } },
    },
  });

  if (user) {
    const membership = await db.member.findFirst({ where: { organizationId: org.id, userId: user.id }, select: { role: true } });
    if (isStudioRole(membership?.role)) {
      const port = host.includes(":") ? `:${host.split(":")[1]}` : "";
      redirect(`https://dash.${BASE_DOMAIN}${port}/talk?agent=${encodeURIComponent(agent.slug)}`);
    }
  }

  // Signed in: their access to this twin (minutes left), or why they can't talk to it.
  let access: LearnerAccess = null;
  if (user) {
    try {
      const found = await twinAssignmentCode({ orgId: org.id, user, agentId: twin.agentId });
      access = { ok: true, name: user.name || user.email, email: user.email, code: found.code, minutesLeft: Math.floor(found.secondsLeft / 60), minutesTotal: found.minutesLimit };
    } catch (error) {
      if (!(error instanceof TwinAccessError)) throw error;
      access = { ok: false, name: user.name || user.email, email: user.email, reason: error.message };
    }
  }

  // Presigned here: the avatar route is for org members, and visitors on this page may not be signed in yet.
  const photoKey = agent.persona.avatar?.s3ImageKey;
  const photoUrl = photoKey ? await presignedGetUrl(photoKey, 3600).catch(() => null) : null;
  const persona = agent.persona.data && typeof agent.persona.data === "object" ? (agent.persona.data as Record<string, unknown>) : {};
  const data = agent.data && typeof agent.data === "object" ? (agent.data as Record<string, unknown>) : {};
  return (
    <TwinLearnerFlow
      path={`/t/${encodeURIComponent(slug)}`}
      trainer={{ name: text(persona.name) ?? agent.persona.name, title: text(persona.role), photoUrl }}
      twin={{ slug: agent.slug, name: agent.name, description: text(data.objective) }}
      access={access}
      // Back from Google sign-in (?start=1): straight to their access.
      startAtAccess={start !== undefined && access !== null}
    />
  );
}
