import Link from "next/link";
import { ArrowUpRight, BookOpen, MessagesSquare, Shapes, UserRound } from "lucide-react";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { db } from "@/lib/db";
import { resolveSessionUser } from "@/lib/session-user";
import { dashLink } from "@/lib/tenant-link";

export const dynamic = "force-dynamic";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  active: "default",
  completed: "secondary",
  abandoned: "outline",
};

export default async function DashboardPage() {
  const { org } = await resolveSessionUser();
  const basePath = org?.basePath;

  const [personas, agents, domains, kbs, sessions] = await Promise.all([
    db.persona.count(),
    db.agent.count(),
    db.domain.count(),
    db.knowledgeBase.count(),
    db.interviewSession.findMany({ orderBy: { startedAt: "desc" }, take: 8 }),
  ]);

  const stats = [
    { label: "Personas", value: personas, href: dashLink("/personas", basePath), icon: UserRound },
    { label: "Scenarios", value: agents, href: dashLink("/agents", basePath), icon: MessagesSquare },
    { label: "Domains", value: domains, href: dashLink("/domains", basePath), icon: Shapes },
    { label: "Knowledge bases", value: kbs, href: dashLink("/knowledge", basePath), icon: BookOpen },
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
      <PageContainer size="narrow" className="flex flex-col gap-6">
      <PageHeader
        title="Dashboard"
        description="Build and version personas and scenarios, then review their sessions."
        actions={
          <Button nativeButton={false} render={<Link href={dashLink("/talk", basePath)} />}>
            Start session <ArrowUpRight data-icon="inline-end" />
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Link key={stat.label} href={stat.href}>
            <Card className="transition-colors hover:bg-accent/60">
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-1.5">
                  <stat.icon className="size-3.5" /> {stat.label}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-semibold tracking-tight">{stat.value}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent sessions</CardTitle>
          <CardDescription>Recent runs across your published scenarios.</CardDescription>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No sessions yet.{" "}
              <Link href={dashLink("/talk", basePath)} className="underline">
                Run your first interview
              </Link>
              .
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Persona</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Domain</TableHead>
                  <TableHead>Context</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => (
                  <TableRow key={session.id}>
                    <TableCell className="font-medium">
                      {session.personaSlug} <Badge variant="outline">v{session.personaVersion}</Badge>
                    </TableCell>
                    <TableCell>
                      {session.agentSlug} <Badge variant="outline">v{session.agentVersion}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{session.domainSlug}</TableCell>
                    <TableCell className="text-muted-foreground">{session.contextName ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {session.startedAt.toISOString().replace("T", " ").slice(0, 16)}
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
