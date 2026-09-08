import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SessionView } from "@/components/session-view";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { signInUrl } from "@/lib/base-domain";
import { db } from "@/lib/db";
import { resolveSessionUser } from "@/lib/session-user";
import { listUploads } from "@/lib/specs";

export const dynamic = "force-dynamic";

export default async function SharedSessionPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const host = (await headers()).get("host") ?? "";
  const { org, user } = await resolveSessionUser();
  if (!user) redirect(signInUrl(host, `/s/${encodeURIComponent(code)}`));

  const session = org ? await db.interviewSession.findUnique({
    where: { shareCode: code },
    select: {
      orgId: true,
      userId: true,
      status: true,
      agent: { select: { slug: true, persona: { select: { slug: true } } } },
    },
  }) : null;
  if (!session || session.orgId !== org?.id || session.userId !== user.id || session.status !== "assigned") {
    return (
      <main className="grid min-h-svh place-items-center p-4">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Invalid session URL</CardTitle>
            <CardDescription>This practice link is not assigned to your account, has expired, or has already been completed.</CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }
  const contexts = await listUploads(org.id);
  return (
    <SessionView
      personas={[session.agent.persona.slug]}
      agents={[session.agent.slug]}
      agentPersonas={{ [session.agent.slug]: session.agent.persona.slug }}
      contexts={contexts.map((context) => ({ id: context.id, name: context.name, size: context.size }))}
      sessionCode={code}
    />
  );
}
