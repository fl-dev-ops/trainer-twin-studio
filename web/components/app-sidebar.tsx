"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
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

export function AppSidebar() {
  const pathname = usePathname();

  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link href="/" />}>
              <span className="grid size-8 place-items-center">
                <Image src="/trainertwin-mark.svg" alt="" width={25} height={19} priority />
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
                  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton render={<Link href={item.href} />} isActive={active} tooltip={item.title}>
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
            <SidebarAccountMenu profileHref="/profile" isActive={pathname === "/profile"} />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
