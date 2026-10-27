"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandMark, PersonaIcon, RoleplayIcon, SessionsIcon, SettingsIcon, SetupIcon, TwinIcon, UsersIcon } from "@/components/icons";
import { SidebarAccountMenu } from "@/components/sidebar-account-menu";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Sidebar,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

/**
 * Rail port of the reference sidebar (trainertwin-beta app.css `.rail`):
 * 248px expanded / 72px collapsed, sunken background, uppercase group labels,
 * 32px nav rows with white active pills, and a card-style user row at the foot.
 */
const NAV_GROUPS = [
  {
    label: "Twin",
    items: [
      { title: "Twin agents", href: "/twin", icon: SetupIcon },
      { title: "Twin sessions", href: "/twin/sessions", icon: SessionsIcon },
      { title: "Twin users", href: "/twin/users", icon: UsersIcon },
      // Knowledge opens from the brain canvas, so it lights this item too.
      { title: "Twin’s brain", href: "/twin/brain", icon: TwinIcon, also: ["/twin/knowledge"] },
    ],
  },
  {
    label: "Role play",
    items: [
      { title: "Scenarios", href: "/roleplay", icon: RoleplayIcon },
      { title: "Role play sessions", href: "/roleplay/sessions", icon: SessionsIcon },
      { title: "Roleplay users", href: "/roleplay/users", icon: UsersIcon },
      { title: "Personas", href: "/personas", icon: PersonaIcon },
    ],
  },
];

/** Reference nav-item metrics: 32px row, 8px radius, 14px/20px text, 20px icon. */
const navButton = cn(
  "min-h-8 px-2 text-sm font-normal text-(--text-secondary)",
  "hover:bg-(--tone-control) hover:text-foreground",
  "[&_svg]:size-5 [&_svg]:shrink-0 [&_svg]:text-(--text-secondary) [&_svg]:transition-colors",
  "data-active:bg-card data-active:font-medium data-active:text-primary data-active:shadow-[0_1px_2px_rgb(30_28_25/0.06)] data-active:hover:bg-card",
  "data-active:[&_svg]:text-(--brand)",
  "dark:data-active:text-foreground dark:data-active:[&_svg]:text-foreground",
  // Collapsed: 40px square row, centered (reference overrides the ui 32px collapse).
  "group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:min-h-0! group-data-[collapsible=icon]:p-0!",
  "group-data-[collapsible=icon]:justify-center",
);

type NavItem = { title: string; href: string; icon: typeof TwinIcon; also?: string[] };
const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);
const NAV_HREFS = [...NAV_ITEMS.flatMap((item) => [item.href, ...(item.also ?? [])]), "/settings"];

const matches = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

/** Only the most specific link is active: /twin/sessions lights "Twin sessions", not "Twin agents" too. */
function isActive(pathname: string, href: string) {
  const own = [href, ...(NAV_ITEMS.find((item) => item.href === href)?.also ?? [])];
  const hit = own.filter((path) => matches(pathname, path)).sort((a, b) => b.length - a.length)[0];
  if (!hit) return false;
  return !NAV_HREFS.some((other) => !own.includes(other) && other.length > hit.length && matches(pathname, other));
}

/** Brand lockup: mark + wordmark; clicking toggles the rail (reference behaviour). */
function Brand() {
  const { state, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";
  return (
    <div className="flex min-h-8 items-center justify-between gap-2 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:items-center">
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={collapsed ? "Expand menu" : "Collapse menu"}
        aria-expanded={!collapsed}
        className="flex h-8 items-center gap-1.5 rounded-md text-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring hover:text-(--text-secondary) group-data-[collapsible=icon]:w-10 group-data-[collapsible=icon]:justify-center"
      >
        <BrandMark className="size-5 shrink-0 text-primary" />
        <span className="text-base font-semibold leading-none tracking-[-0.02em] group-data-[collapsible=icon]:hidden">
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
    <Sidebar variant="sidebar" collapsible="icon" className="border-r-0">
      {/* Reference "rail-scroll": padded 16/12/12, children stacked with an 8px gap. */}
      <div className="flex h-full min-h-0 flex-col gap-2 px-3 pt-4 pb-3 group-data-[collapsible=icon]:px-2">
        <Brand />
        <nav aria-label="Sections" className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
          {NAV_GROUPS.map((group, index) => (
            <div key={group.label} className={index === 0 ? "mt-1" : "mt-3"}>
              <p className="px-2 text-[11px] leading-4 font-medium tracking-[0.08em] uppercase text-muted-foreground group-data-[collapsible=icon]:hidden">
                {group.label}
              </p>
              <SidebarMenu className="mt-2 gap-2">
                {group.items.map((item) => (
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
            </div>
          ))}
        </nav>
        {/* Reference "rail-foot": pinned to the bottom, 12px gap, 12px top padding. */}
        <div className="mt-auto flex flex-col gap-3 pt-3">
          <SidebarMenu className="gap-2">
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<Link href="/settings" />}
                isActive={isActive(pathname, "/settings")}
                tooltip="Settings"
                className={navButton}
              >
                <SettingsIcon />
                <span>Settings</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <SidebarAccountMenu />
        </div>
      </div>
    </Sidebar>
  );
}
