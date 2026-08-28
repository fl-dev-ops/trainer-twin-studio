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

  const member = await db.member.findFirst({
    where: { userId: session.user.id, role: { in: ["owner", "admin"] } },
    select: { organizationId: true },
  });
  if (!member) redirect("/auth/no-org");

  const row = await db.interviewSession.findFirst({
    where: { id, orgId: member.organizationId },
  });
  if (!row) notFound();

  const transcript = Array.isArray(row.transcript) ? (row.transcript as TranscriptEntry[]) : [];
  const evidence =
    row.evidence && typeof row.evidence === "object"
      ? (Object.entries(row.evidence as Record<string, unknown>) as [string, unknown][])
      : [];

  // The user who ran the session (if identified).
  const runner = row.userId
    ? await db.user.findUnique({ where: { id: row.userId }, select: { name: true, email: true } })
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
      <PageContainer size="narrow" className="flex flex-col gap-6">
        <Link
          href="/sessions"
          className="text-muted-foreground flex items-center gap-1 text-sm hover:underline"
        >
          <ArrowLeft className="size-4" /> All sessions
        </Link>

        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {row.agentSlug} <Badge variant="outline">v{row.agentVersion}</Badge>
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              {row.startedAt.toISOString().replace("T", " ").slice(0, 16)} · persona{" "}
              {row.personaSlug} v{row.personaVersion} · domain {row.domainSlug} v{row.domainVersion}
              {runner ? ` · ${runner.name} (${runner.email})` : ""}
            </p>
          </div>
          <Badge>{row.status}</Badge>
        </div>

        {row.s3AudioKey ? (
          <Card>
            <CardHeader>
              <CardTitle>Recording</CardTitle>
              <CardDescription>Stereo mix — user left, trainer right.</CardDescription>
            </CardHeader>
            <CardContent>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <audio controls preload="none" src={`/api/sessions/${row.id}/audio`} className="w-full">
                Your browser does not support audio playback.
              </audio>
            </CardContent>
          </Card>
        ) : null}

        {evidence.length > 0 ? (
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
        ) : null}

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
