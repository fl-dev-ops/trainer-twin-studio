import { headers } from "next/headers";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowUpRight, Bot, Clock3, Library } from "lucide-react";
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
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { SidebarAccountMenu } from "@/components/sidebar-account-menu";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Learner portal: public role plays for the organization on this subdomain. */
export default async function LearnerHome() {
  const host = (await headers()).get("host") ?? "";
  const slug = host.split(":")[0].split(".")[0];
  const org = await db.organization.findUnique({
    where: { slug },
    select: { id: true, name: true, logo: true },
  });
  if (!org) redirect("/auth/sign-in");
  const logo = /^data:image\/(?:png|jpeg|webp);base64,/.test(org.logo ?? "") ? org.logo : null;

  const agents = await db.agent.findMany({
    where: { orgId: org.id, visibility: "public" },
    orderBy: { name: "asc" },
    select: { slug: true, name: true, version: true, domainSlug: true, data: true },
  });

  return (
    <SidebarProvider>
      <Sidebar variant="inset" collapsible="offcanvas">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" render={<Link href="/" />} isActive>
                <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-md">
                  {logo ? (
                    <Image
                      src={logo}
                      alt=""
                      width={32}
                      height={32}
                      className="size-full object-cover"
                      unoptimized
                      priority
                    />
                  ) : (
                    <Image src="/trainertwin-mark.svg" alt="" width={25} height={19} priority />
                  )}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-semibold">{org.name}</span>
                  <span className="text-xs text-muted-foreground">Learner portal</span>
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton render={<Link href="/" />} isActive>
                    <Library />
                    <span>Role Play Library</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarAccountMenu />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset className="h-svh overflow-hidden">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4 sm:px-6">
          <SidebarTrigger />
          <h1 className="text-base font-semibold">Role Play</h1>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto bg-muted/30 p-4 sm:p-6 lg:p-8">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            <section className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <h2 className="text-2xl font-semibold tracking-tight">Role Play Library</h2>
                <Badge variant="secondary">{agents.length}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                Choose a guided interview and practice at your own pace.
              </p>
            </section>

            {agents.length === 0 ? (
              <Empty className="min-h-72 border">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><Bot /></EmptyMedia>
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
                            <Bot className="size-5" aria-hidden="true" />
                          </span>
                          <Badge variant="outline">v{agent.version}</Badge>
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
      </SidebarInset>
    </SidebarProvider>
  );
}
