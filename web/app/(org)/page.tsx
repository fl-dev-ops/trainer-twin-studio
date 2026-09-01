import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowUpRight, Clock3, MessagesSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
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
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Learner portal: assigned role plays first, followed by the public library. */
export default async function LearnerHome() {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "";
  const slug = host.split(":")[0].split(".")[0];
  const [org, session] = await Promise.all([
    db.organization.findUnique({ where: { slug }, select: { id: true } }),
    auth.api.getSession({ headers: requestHeaders }),
  ]);
  if (!org) redirect("/auth/sign-in");

  const member = session
    ? await db.member.findFirst({
        where: { organizationId: org.id, userId: session.user.id },
        select: { id: true },
      })
    : null;
  const agentSelect = {
    id: true,
    slug: true,
    name: true,
    version: true,
    domainSlug: true,
    data: true,
  } as const;
  const [agents, assignmentRows] = await Promise.all([
    db.agent.findMany({
      where: { orgId: org.id, visibility: "public" },
      orderBy: [{ order: "asc" }, { name: "asc" }],
      select: agentSelect,
    }),
    member
      ? db.rolePlayAssignment.findMany({
          where: { orgId: org.id, memberId: member.id },
          orderBy: { assignedAt: "desc" },
          select: { agent: { select: agentSelect } },
        })
      : Promise.resolve([]),
  ]);

  const assignedAgents = assignmentRows.map(({ agent }) => agent);
  const assignedIds = new Set(assignedAgents.map(({ id }) => id));
  const libraryAgents = agents.filter(({ id }) => !assignedIds.has(id));
  const sections = [
    assignedAgents.length
      ? {
          title: "Assigned to you",
          description: "Role plays selected by your trainer.",
          assigned: true,
          agents: assignedAgents,
        }
      : null,
    libraryAgents.length
      ? {
          title: assignedAgents.length ? "More role plays" : "Role Play Library",
          description: "Choose a guided interview and practice at your own pace.",
          assigned: false,
          agents: libraryAgents,
        }
      : null,
  ].filter((section): section is NonNullable<typeof section> => section !== null);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-muted/30 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
        {sections.length === 0 ? (
          <Empty className="min-h-72 border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><MessagesSquare /></EmptyMedia>
              <EmptyTitle>No role plays available</EmptyTitle>
              <EmptyDescription>Your trainer has not published any role plays yet.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          sections.map((section) => (
            <section key={section.title} className="flex flex-col gap-4" aria-labelledby={`${section.assigned ? "assigned" : "library"}-heading`}>
              <div className="flex flex-col gap-1">
                <h2 id={`${section.assigned ? "assigned" : "library"}-heading`} className="text-2xl font-semibold tracking-tight">
                  {section.title}
                </h2>
                <p className="text-sm text-muted-foreground">{section.description}</p>
              </div>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {section.agents.map((agent) => {
                  const data = agent.data as { objective?: unknown };
                  const objective = typeof data.objective === "string"
                    ? data.objective
                    : "Practice with a guided AI interview trainer.";

                  return (
                    <Card key={agent.id} className="min-h-60 transition-colors hover:bg-accent/40">
                      <CardHeader>
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <span className="grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
                            <MessagesSquare className="size-5" aria-hidden="true" />
                          </span>
                          {section.assigned ? <Badge variant="secondary">Assigned</Badge> : null}
                        </div>
                        <CardTitle>{agent.name}</CardTitle>
                        <CardDescription className="line-clamp-3 leading-5">{objective}</CardDescription>
                      </CardHeader>
                      <CardContent className="mt-auto">
                        <p className="truncate text-xs text-muted-foreground">
                          {agent.domainSlug.replaceAll("-", " ")}
                        </p>
                      </CardContent>
                      <CardFooter className="justify-between gap-3">
                        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Clock3 className="size-3.5" aria-hidden="true" /> Guided session
                        </span>
                        <Button size="sm" nativeButton={false} render={<Link href={`/session/${agent.slug}`} />}>
                          Start practice <ArrowUpRight data-icon="inline-end" />
                        </Button>
                      </CardFooter>
                    </Card>
                  );
                })}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
