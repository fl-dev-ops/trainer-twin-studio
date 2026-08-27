"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  AudioLines,
  BookOpen,
  // Gauge,
  History,
  MessagesSquare,
  Mic,
  // Shapes,
  Sparkles,
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
  SidebarProvider,
} from "@/components/ui/sidebar";

const NAV = [
  {
    label: "Workspace",
    items: [
      { title: "Copilot", href: "/", icon: Sparkles },
      { title: "Users", href: "/users", icon: Users },
      { title: "Knowledge", href: "/knowledge", icon: BookOpen },
      { title: "Sessions", href: "/sessions", icon: History },
    ],
  },
  {
    label: "Voice",
    items: [
      { title: "Voices", href: "/voice", icon: AudioLines },
      { title: "Voice Cloning", href: "/voice/cloning", icon: Mic },
    ],
  },
  {
    label: "Trainer library",
    items: [
      { title: "Role Plays", href: "/agents", icon: MessagesSquare },
      { title: "Personas", href: "/personas", icon: UserRound },
    ],
  },
  // {
  //   label: "Advanced",
  //   items: [
  //     { title: "Overview", href: "/overview", icon: Gauge },
  //     { title: "Domains", href: "/domains", icon: Shapes },
  //   ],
  // },
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
                <span className="text-xs text-muted-foreground">Interview studio</span>
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
