import Link from "next/link";
import { ArrowUpRight, BookOpen, MessagesSquare, UserRound } from "lucide-react";
import { redirect } from "next/navigation";
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
import { getSessionOrg } from "@/lib/org";

export const dynamic = "force-dynamic";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  active: "default",
  completed: "secondary",
  abandoned: "outline",
};

export default async function DashboardPage() {
  const org = await getSessionOrg();
  if (!org) redirect("/auth/no-org");
  const [personas, agents, kbs, sessions] = await Promise.all([
    db.persona.count({ where: { orgId: org.id } }),
    db.agent.count({ where: { orgId: org.id } }),
    db.knowledgeBase.count({ where: { orgId: org.id } }),
    db.interviewSession.findMany({ where: { orgId: org.id, deletedAt: null }, orderBy: { startedAt: "desc" }, take: 8 }),
  ]);

  const stats = [
    { label: "Personas", value: personas, href: "/personas", icon: UserRound },
    { label: "Scenarios", value: agents, href: "/agents", icon: MessagesSquare },
    { label: "Knowledge bases", value: kbs, href: "/knowledge", icon: BookOpen },
  ];

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto p-5 sm:p-8">
      <PageContainer size="narrow" className="flex flex-col gap-6">
      <PageHeader
        className="border-b pb-6"
        title="Dashboard"
        description="Build and version personas and scenarios, then review their sessions."
        actions={
          <Button nativeButton={false} render={<Link href="/talk" />}>
            Start session <ArrowUpRight data-icon="inline-end" />
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
              <Link href="/talk" className="underline">
                Run your first interview
              </Link>
              .
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Persona</TableHead>
                  <TableHead>Scenario</TableHead>
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
                    <TableCell className="text-muted-foreground">{session.contextName ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {(session.startedAt ?? session.createdAt).toISOString().replace("T", " ").slice(0, 16)}
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
    </main>
  );
}
