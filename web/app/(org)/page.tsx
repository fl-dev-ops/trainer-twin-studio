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
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Learner portal: public role plays for the organization on this subdomain. */
export default async function LearnerHome() {
  const host = (await headers()).get("host") ?? "";
  const slug = host.split(":")[0].split(".")[0];
  const org = await db.organization.findUnique({ where: { slug }, select: { id: true } });
  if (!org) redirect("/auth/sign-in");

  const agents = await db.agent.findMany({
    where: { orgId: org.id, visibility: "public" },
    orderBy: [{ order: "asc" }, { name: "asc" }],
    select: { slug: true, name: true, version: true, domainSlug: true, data: true },
  });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-muted/30 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <section className="flex flex-col gap-1">
          <h2 className="text-2xl font-semibold tracking-tight">Role Play Library</h2>
          <p className="text-sm text-muted-foreground">
            Choose a guided interview and practice at your own pace.
          </p>
        </section>

        {agents.length === 0 ? (
          <Empty className="min-h-72 border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><MessagesSquare /></EmptyMedia>
              <EmptyTitle>No role plays available</EmptyTitle>
              <EmptyDescription>Your trainer has not published any role plays yet.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <section aria-label="Available role plays" className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {agents.map((agent) => {
              const data = agent.data as { objective?: unknown };
              const objective = typeof data.objective === "string"
                ? data.objective
                : "Practice with a guided AI interview trainer.";

              return (
                <Card key={agent.slug} className="min-h-60 transition-colors hover:bg-accent/40">
                  <CardHeader>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <span className="grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
                        <MessagesSquare className="size-5" aria-hidden="true" />
                      </span>
                    </div>
                    <CardTitle>{agent.name}</CardTitle>
                    <CardDescription className="line-clamp-3 leading-5">
                      {objective}
                    </CardDescription>
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
                    <Button
                      size="sm"
                      nativeButton={false}
                      render={<Link href={`/session/${agent.slug}`} />}
                    >
                      Start practice <ArrowUpRight data-icon="inline-end" />
                    </Button>
                  </CardFooter>
                </Card>
              );
            })}
          </section>
        )}
      </div>
    </div>
  );
}
