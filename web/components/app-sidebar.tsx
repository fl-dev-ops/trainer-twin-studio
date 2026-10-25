"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { RoleplayIcon, SessionsIcon, SettingsIcon, TwinIcon, UsersIcon } from "@/components/icons";
import { SidebarAccountMenu } from "@/components/sidebar-account-menu";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

const NAV = [
  // All learner sessions: role play and twin.
  { title: "Sessions", href: "/sessions", icon: SessionsIcon },
  // Every scenario, twin role play or not.
  { title: "Roleplay", href: "/agents", icon: RoleplayIcon },
  // The twin's knowledge.
  { title: "Twin", href: "/knowledge", icon: TwinIcon },
  // Every learner.
  { title: "Users", href: "/learners", icon: UsersIcon },
];

/** Prototype rail: white pill + brand text/icon for the active item, quiet text otherwise. */
const navButton = cn(
  "h-7 gap-2 rounded-md px-2 text-[13px] font-medium text-sidebar-foreground/80 hover:bg-sidebar-accent/60",
  "[&_svg]:size-4 [&_svg]:text-sidebar-foreground/70",
  "data-active:bg-card data-active:text-primary data-active:shadow-xs data-active:hover:bg-card",
  "data-active:[&_svg]:text-(--brand)",
);

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function Brand() {
  const { state, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";
  return (
    <div className="flex items-center justify-between gap-2 group-data-[collapsible=icon]:flex-col">
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={collapsed ? "Expand menu" : "Collapse menu"}
        aria-expanded={!collapsed}
        className="flex h-9 items-center gap-2 rounded-lg px-1 outline-hidden ring-sidebar-ring focus-visible:ring-2"
      >
        <Image src="/trainertwin-mark.svg" alt="" width={20} height={15} priority />
        <span className="text-[15px] font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
          TrainerTwin
        </span>
      </button>
      <ThemeToggle />
    </div>
  );
}

export function AppSidebar() {
  const pathname = usePathname();

  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader className="pt-3">
        <Brand />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {NAV.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    render={<Link href={item.href} />}
                    isActive={isActive(pathname, item.href)}
                    tooltip={item.title}
                    className={navButton}
                  >
                    <item.icon />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="gap-2 pb-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link href="/profile" />}
              isActive={isActive(pathname, "/profile")}
              tooltip="Settings"
              className={navButton}
            >
              <SettingsIcon />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarAccountMenu />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
