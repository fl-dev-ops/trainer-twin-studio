"use client";

import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { History, Library } from "lucide-react";
import { getClientBasePath, tenantLink } from "@/lib/tenant-link";
import { OrgAccentProvider } from "@/components/org-accent-provider";
import { SidebarAccountMenu } from "@/components/sidebar-account-menu";
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

const NAV = [
  { title: "Role Play Library", href: "/", icon: Library },
  { title: "Past Sessions", href: "/sessions", icon: History },
];
export function LearnerShell({
  children,
  orgName,
  logo,
  accentColor,
  basePath: serverBasePath,
}: {
  children: ReactNode;
  orgName: string;
  logo: string | null;
  accentColor: string | null;
  basePath?: string | null;
}) {
  const pathname = usePathname();
  const basePath = serverBasePath ?? getClientBasePath();

  if (pathname.startsWith("/session/"))
    return (
      <OrgAccentProvider accentColor={accentColor}>{children}</OrgAccentProvider>
    );

  const title = pathname.startsWith("/sessions") ? "Past Sessions" : "Role Play";

  return (
    <OrgAccentProvider accentColor={accentColor}>
      <SidebarProvider>
        <Sidebar variant="inset" collapsible="offcanvas">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton size="lg" render={<Link href={tenantLink("/", basePath)} />}>
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
                      <Image src={tenantLink("/trainertwin-mark.svg", basePath)} alt="" width={25} height={19} priority />
                    )}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-semibold">{orgName}</span>
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
                  {NAV.map((item) => {
                    const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                    return (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton
                          render={<Link href={tenantLink(item.href, basePath)} />}
                          isActive={active}
                          tooltip={item.title}
                        >
                          <item.icon />
                          <span>{item.title}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
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
            <h1 className="text-base font-semibold">{title}</h1>
          </header>
          {children}
        </SidebarInset>
      </SidebarProvider>
    </OrgAccentProvider>
  );
}
