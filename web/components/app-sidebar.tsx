"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { getClientBasePath, tenantLink, dashLink } from "@/lib/tenant-link";
import {
  AudioLines,
  BookOpen,
  History,
  MessagesSquare,
  UserRound,
  Users,
} from "lucide-react";
import { SidebarAccountMenu } from "@/components/sidebar-account-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

const NAV = [
  {
    label: "Activity",
    items: [{ title: "Sessions", href: "/sessions", icon: History }],
  },
  {
    label: "Create",
    items: [{ title: "Scenarios", href: "/agents", icon: MessagesSquare }],
  },
  {
    label: "Library",
    items: [
      { title: "Personas", href: "/personas", icon: UserRound },
      { title: "Voices", href: "/voice", icon: AudioLines },
      { title: "Knowledge", href: "/knowledge", icon: BookOpen },
    ],
  },
  {
    label: "Organization",
    items: [{ title: "Users", href: "/users", icon: Users }],
  },
];

export function AppSidebar({ basePath: serverBasePath }: { basePath?: string | null }) {
  const pathname = usePathname();
  const basePath = serverBasePath ?? getClientBasePath();
  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link href={dashLink("/", basePath)} />}>
              <span className="grid size-8 place-items-center">
                <Image src={tenantLink("/trainertwin-mark.svg", basePath)} alt="" width={25} height={19} priority />
              </span>
              <span className="flex flex-col group-data-[collapsible=icon]:hidden">
                <span className="font-semibold">TrainerTwin</span>
                <span className="text-xs text-muted-foreground">Digital twin studio</span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {NAV.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const targetHref = dashLink(item.href, basePath);
                  const active = pathname === targetHref || pathname.startsWith(`${targetHref}/`);
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton render={<Link href={targetHref} />} isActive={active} tooltip={item.title}>
                        <item.icon />
                        <span>{item.title}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarAccountMenu profileHref={dashLink("/profile", basePath)} isActive={pathname.endsWith("/profile")} />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
