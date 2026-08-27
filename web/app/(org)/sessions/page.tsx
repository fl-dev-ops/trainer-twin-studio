import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowUpRight, History } from "lucide-react";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { db } from "@/lib/db";
import { resolveSessionUser } from "@/lib/session-user";

export const dynamic = "force-dynamic";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  active: "default",
  completed: "secondary",
  abandoned: "outline",
};

function formatDate(date: Date) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export default async function LearnerSessionsPage() {
  const { org, user, signInUrl } = await resolveSessionUser();
  if (!user) redirect(signInUrl);
  if (!org) notFound();

  const sessions = await db.interviewSession.findMany({
    where: { orgId: org.id, userId: user.id },
    orderBy: { startedAt: "desc" },
    take: 100,
  });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-muted/30 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <section className="flex flex-col gap-1">
          <h2 className="text-2xl font-semibold tracking-tight">Past Sessions</h2>
          <p className="text-sm text-muted-foreground">
            Review your previous role plays, transcripts, and evidence coverage.
          </p>
        </section>

        <Card>
          <CardHeader>
            <CardTitle>Session history</CardTitle>
            <CardDescription>Select a session to open its full preview.</CardDescription>
          </CardHeader>
          <CardContent>
            {sessions.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon"><History /></EmptyMedia>
                  <EmptyTitle>No past sessions</EmptyTitle>
                  <EmptyDescription>
                    Complete a role play and it will appear here.
                  </EmptyDescription>
                </EmptyHeader>
                <Button nativeButton={false} render={<Link href="/" />}>
                  Browse role plays <ArrowUpRight data-icon="inline-end" />
                </Button>
              </Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Role play</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead>Context</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead><span className="sr-only">Preview</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sessions.map((session) => (
                    <TableRow key={session.id}>
                      <TableCell className="font-medium">
                        {session.agentSlug.replaceAll("-", " ")}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDate(session.startedAt)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {session.contextName ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[session.status] ?? "outline"}>
                          {session.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          nativeButton={false}
                          render={<Link href={`/sessions/${session.id}`} />}
                        >
                          Preview <ArrowUpRight data-icon="inline-end" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
