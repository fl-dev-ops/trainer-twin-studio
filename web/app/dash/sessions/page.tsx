import { History } from "lucide-react";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { getSessionOrg } from "@/lib/org";
import { Badge } from "@/components/ui/badge";
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
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  active: "default",
  completed: "secondary",
  abandoned: "outline",
};

export default async function SessionsPage() {
  const org = await getSessionOrg();
  if (!org) redirect("/auth/no-org");
  const sessions = await db.interviewSession.findMany({
    where: { orgId: org.id },
    orderBy: { startedAt: "desc" },
    take: 100,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
      <PageContainer size="narrow" className="flex flex-col gap-6">
      <PageHeader
        title="Sessions"
        description="Every run, pinned to the exact resource versions that produced it."
      />

      <Card>
        <CardHeader>
          <CardTitle>Scenario sessions</CardTitle>
          <CardDescription>
            Click a session to review its transcript, evidence coverage and recording.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <History />
                </EmptyMedia>
                <EmptyTitle>No sessions yet</EmptyTitle>
                <EmptyDescription>
                  <Link href="/talk" className="underline">
                    Start a voice session
                  </Link>{" "}
                  to see it here.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Persona</TableHead>
                  <TableHead>Scenario</TableHead>
                  <TableHead>Domain</TableHead>
                  <TableHead>Context</TableHead>
                  <TableHead>Recording</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => (
                  <TableRow key={session.id}>
                    <TableCell className="text-muted-foreground">
                      {session.startedAt.toISOString().replace("T", " ").slice(0, 16)}
                    </TableCell>
                    <TableCell className="font-medium">
                      <Link href={`/sessions/${session.id}`} className="underline underline-offset-4">
                        {session.personaSlug}
                      </Link>{" "}
                      <Badge variant="outline">v{session.personaVersion}</Badge>
                    </TableCell>
                    <TableCell>
                      {session.agentSlug} <Badge variant="outline">v{session.agentVersion}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {session.domainSlug} <Badge variant="outline">v{session.domainVersion}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{session.contextName ?? "—"}</TableCell>
                    <TableCell>
                      {session.s3AudioKey ? (
                        <Badge variant="secondary">audio</Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[session.status] ?? "outline"}>{session.status}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      </PageContainer>
    </div>
  );
}
