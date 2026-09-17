import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SessionView } from "@/components/session-view";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { signInUrl } from "@/lib/base-domain";
import { db } from "@/lib/db";
import { resolveSessionUser } from "@/lib/session-user";
import { listAgentContextRequired, listAgentContextUploads, listScenarioIntroVideos } from "@/lib/specs";

export const dynamic = "force-dynamic";

export default async function SharedSessionPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const host = (await headers()).get("host") ?? "";
  const { org, user } = await resolveSessionUser();
  if (!user) redirect(signInUrl(host, `/s/${encodeURIComponent(code)}`));

  const assignment = org ? await db.rolePlayAssignment.findUnique({
    where: { shareCode: code },
    select: {
      id: true,
      orgId: true,
      status: true,
      expiresAt: true,
      member: { select: { userId: true } },
      deployment: {
        select: {
          agent: { select: { slug: true, name: true, persona: { select: { slug: true } } } },
        },
      },
      organization: { select: { name: true, logo: true } },
    },
  }) : null;
  const spent = assignment
    ? (await db.interviewSession.count({
        where: { assignmentId: assignment.id, status: { in: ["completed", "abandoned"] } },
      })) > 0
    : false;
  const usable = assignment
    && assignment.orgId === org?.id
    && assignment.member.userId === user.id
    && assignment.status === "pending"
    && !spent
    && assignment.expiresAt > new Date();
  if (!usable) {
    return (
      <main className="grid min-h-svh place-items-center p-4">
        <Card className="w-full max-w-md text-center">
          <CardHeader>
            <CardTitle>Invalid session link</CardTitle>
            <CardDescription>This practice link is not assigned to your account, has expired, or has already been completed.</CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }
  const agent = assignment.deployment.agent;
  const [introVideos, agentContextRequired, agentContextUploads] = await Promise.all([
    listScenarioIntroVideos(org.id, [agent.slug]),
    listAgentContextRequired(org.id, [agent.slug]),
    listAgentContextUploads(org.id, [agent.slug]),
  ]);
  return (
    <SessionView
      personas={[agent.persona.slug]}
      agents={[agent.slug]}
      scenarioName={agent.name}
      userName={user.name}
      organizationName={assignment.organization.name}
      organizationLogo={/^data:image\/(?:png|jpeg|webp);base64,/.test(assignment.organization.logo ?? "") ? assignment.organization.logo : null}
      agentPersonas={{ [agent.slug]: agent.persona.slug }}
      agentContextRequired={agentContextRequired}
      agentContextUploads={agentContextUploads}
      introVideos={introVideos}
      autoStart
      contexts={[]}
      sessionCode={code}
    />
  );
}
