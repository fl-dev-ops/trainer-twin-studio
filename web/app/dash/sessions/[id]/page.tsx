import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageContainer } from "@/components/page-container";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { RoleplaySessionReport } from "@/components/roleplay/roleplay-session-report";
import { readRoleplaySession } from "@/lib/roleplay-sessions";
import { getTrainerOrg } from "@/lib/org";
import { orgCopy } from "@/lib/org-type";
import { getStoredRoleplay } from "@/lib/roleplay";
import { isSessionReport } from "@/lib/session-report";
import { agentDisplayName } from "@/lib/specs";
import { SessionReportCards } from "@/components/session-report-cards";

export const dynamic = "force-dynamic";

type TranscriptEntry = { role: "user" | "trainer"; text: string };

export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/auth/sign-in");

  const trainer = await getTrainerOrg();
  if (!trainer) redirect("/auth/no-org");
  if (trainer.type === "SALES") {
    const data = await readRoleplaySession(trainer.id, id);
    if (data) return <RoleplaySessionReport data={data} />;
  }

  const row = await db.interviewSession.findFirst({
    where: { id, orgId: trainer.id, deletedAt: null },
  });
  if (!row) notFound();

  const transcript = Array.isArray(row.transcript) ? (row.transcript as TranscriptEntry[]) : [];
  // The user who ran the session (if identified).
  const [runner, agent] = await Promise.all([
    row.userId
      ? db.user.findUnique({ where: { id: row.userId }, select: { name: true, email: true } })
      : null,
    db.agent.findUnique({ where: { id: row.agentId }, select: { slug: true, name: true, data: true, persona: { select: { name: true } } } }),
  ]);
  const copy = orgCopy(trainer.type);
  const scenarioName = agent ? agentDisplayName(agent.slug, agent.name) : row.agentSlug;
  const aiName = (agent && getStoredRoleplay(agent.data)?.client_name) ?? agent?.persona.name ?? "Trainer";
  const learnerName = runner?.name || "Learner";
  const report = isSessionReport(row.report) ? row.report : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
      <PageContainer size="narrow" className="flex flex-col gap-6">
        <Link
          href={`/agents/${encodeURIComponent(agent?.slug ?? row.agentSlug)}`}
          className="text-muted-foreground flex items-center gap-1 text-sm hover:underline"
        >
          <ArrowLeft className="size-4" /> Back to {copy.scenarioLower}
        </Link>

        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {scenarioName} <Badge variant="outline">v{row.agentVersion}</Badge>
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              {(row.startedAt ?? row.createdAt).toISOString().replace("T", " ").slice(0, 16)} · persona{" "}
              {row.personaSlug} v{row.personaVersion}
              {runner ? ` · ${runner.name} (${runner.email})` : ""}
            </p>
          </div>
          <Badge>{row.status}</Badge>
        </div>

        {row.videoEgressId || (row.evidence && typeof row.evidence === "object" && ((row.evidence as Record<string, unknown>).videoS3Key || (row.evidence as Record<string, unknown>).videoUrl)) ? (
          <Card>
            <CardHeader>
              <CardTitle>Session Recording</CardTitle>
              <CardDescription>
                Full screen recording with learner workspace, live code, system design sketches
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="aspect-video w-full rounded-xl overflow-hidden bg-black/95 border flex items-center justify-center">
                <video
                  controls
                  preload="metadata"
                  playsInline
                  src={`/api/sessions/${row.id}/video`}
                  className="h-full w-full object-contain"
                >
                  <p className="text-muted-foreground text-xs p-4">
                    Your browser does not support HTML5 video playback.
                  </p>
                </video>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {/*{evidence.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Evidence coverage</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {evidence.map(([key, value]) => (
                <Badge key={key} variant={value ? "default" : "outline"}>
                  {key}
                  {value ? ` ✓` : ""}
                </Badge>
              ))}
            </CardContent>
          </Card>
        ) : null}*/}

        {report ? <SessionReportCards report={report} /> : null}

        <Card>
          <CardHeader>
            <CardTitle>Transcript</CardTitle>
          </CardHeader>
          <CardContent>
            {transcript.length === 0 ? (
              <p className="text-muted-foreground text-sm">No transcript was captured.</p>
            ) : (
              <div className="flex flex-col gap-3">
                {transcript.map((entry, i) => (
                  <div
                    key={i}
                    className={entry.role === "user" ? "flex justify-end" : "flex justify-start"}
                  >
                    <div
                      className={
                        entry.role === "user"
                          ? "bg-primary text-primary-foreground max-w-[80%] rounded-xl px-3.5 py-2.5 text-sm"
                          : "border bg-background max-w-[80%] rounded-xl px-3.5 py-2.5 text-sm"
                      }
                    >
                      <p className="mb-0.5 text-xs font-semibold opacity-80">{entry.role === "user" ? learnerName : aiName}</p>
                      {entry.text}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </PageContainer>
    </div>
  );
}
