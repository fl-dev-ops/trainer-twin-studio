import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, Clock3, History } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { db } from "@/lib/db";
import { resolveSessionUser } from "@/lib/session-user";

export const dynamic = "force-dynamic";

type TranscriptEntry = { role: "user" | "trainer"; text: string };

function formatDate(date: Date) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export default async function LearnerSessionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { org, user, signInUrl } = await resolveSessionUser();
  if (!user) redirect(signInUrl);
  if (!org) notFound();

  const row = await db.interviewSession.findFirst({
    where: { id, orgId: org.id, userId: user.id },
  });
  if (!row) notFound();

  const transcript = Array.isArray(row.transcript)
    ? row.transcript.filter(
        (entry): entry is TranscriptEntry =>
          typeof entry === "object" &&
          entry !== null &&
          ((entry as { role?: unknown }).role === "user" ||
            (entry as { role?: unknown }).role === "trainer") &&
          typeof (entry as { text?: unknown }).text === "string",
      )
    : [];
  const evidence = row.evidence && typeof row.evidence === "object" && !Array.isArray(row.evidence)
    ? Object.entries(row.evidence as Record<string, unknown>)
    : [];
  const duration = row.endedAt
    ? Math.max(1, Math.round((row.endedAt.getTime() - row.startedAt.getTime()) / 60_000))
    : null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-muted/30 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          nativeButton={false}
          render={<Link href="/sessions" />}
        >
          <ArrowLeft data-icon="inline-start" /> All sessions
        </Button>

        <section className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="text-2xl font-semibold tracking-tight capitalize">
              {row.agentSlug.replaceAll("-", " ")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {formatDate(row.startedAt)} · {row.personaSlug.replaceAll("-", " ")}
            </p>
          </div>
          <Badge variant={row.status === "completed" ? "secondary" : "outline"}>
            {row.status}
          </Badge>
        </section>

        <div className="grid gap-4 sm:grid-cols-3">
          <Card size="sm">
            <CardHeader>
              <CardDescription>Duration</CardDescription>
              <CardTitle className="flex items-center gap-2">
                <Clock3 className="size-4" /> {duration ? `${duration} min` : "In progress"}
              </CardTitle>
            </CardHeader>
          </Card>
          <Card size="sm">
            <CardHeader>
              <CardDescription>Context</CardDescription>
              <CardTitle>{row.contextName ?? "No document"}</CardTitle>
            </CardHeader>
          </Card>
          <Card size="sm">
            <CardHeader>
              <CardDescription>Evidence areas</CardDescription>
              <CardTitle>{evidence.length}</CardTitle>
            </CardHeader>
          </Card>
        </div>

        {evidence.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Evidence coverage</CardTitle>
              <CardDescription>Coverage captured during this role play.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {evidence.map(([key, value]) => (
                <Badge key={key} variant="outline">
                  {key.replaceAll("_", " ")}: {String(value)}
                </Badge>
              ))}
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Transcript</CardTitle>
            <CardDescription>Your conversation with the trainer.</CardDescription>
          </CardHeader>
          <CardContent>
            {transcript.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon"><History /></EmptyMedia>
                  <EmptyTitle>No transcript captured</EmptyTitle>
                  <EmptyDescription>This session does not have a saved transcript.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="flex flex-col gap-3">
                {transcript.map((entry, index) => (
                  <div
                    key={`${entry.role}-${index}`}
                    className={entry.role === "user" ? "flex justify-end" : "flex justify-start"}
                  >
                    <div
                      className={
                        entry.role === "user"
                          ? "max-w-[85%] rounded-xl bg-primary px-3.5 py-2.5 text-sm text-primary-foreground"
                          : "max-w-[85%] rounded-xl border bg-background px-3.5 py-2.5 text-sm"
                      }
                    >
                      <p className="mb-1 text-xs font-medium opacity-70">
                        {entry.role === "user" ? "You" : "Trainer"}
                      </p>
                      <p>{entry.text}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
