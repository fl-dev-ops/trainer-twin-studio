"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  BrandMark,
  PersonaIcon,
  RoleplayIcon,
  SessionsIcon,
  SetupIcon,
  TwinIcon,
  UsersIcon,
} from "@/components/icons";
import { OrgSwitcher, type SwitchableOrg } from "@/components/org-switcher";
import { SidebarAccountMenu } from "@/components/sidebar-account-menu";
import { ThemeToggle } from "@/components/theme-toggle";
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
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";

const NAV_GROUPS = [
  {
    label: "Twin",
    items: [
      { title: "Twin agents", href: "/twin", icon: SetupIcon },
      { title: "Twin sessions", href: "/twin/sessions", icon: SessionsIcon },
      { title: "Twin users", href: "/twin/users", icon: UsersIcon },
      // Knowledge opens from the brain canvas, so it lights this item too.
      {
        title: "Twin’s brain",
        href: "/twin/brain",
        icon: TwinIcon,
        also: ["/twin/knowledge"],
      },
    ],
  },
  {
    label: "Role play",
    items: [
      { title: "Scenarios", href: "/roleplay", icon: RoleplayIcon },
      {
        title: "Role play sessions",
        href: "/roleplay/sessions",
        icon: SessionsIcon,
      },
      { title: "Roleplay users", href: "/roleplay/users", icon: UsersIcon },
      { title: "Personas", href: "/personas", icon: PersonaIcon },
    ],
  },
  {
    label: "People",
    items: [
      { title: "Users", href: "/users", icon: UsersIcon },
      { title: "Team", href: "/settings?tab=team", icon: UsersIcon },
    ],
  },
];

type NavItem = {
  title: string;
  href: string;
  icon: typeof TwinIcon;
  also?: string[];
};
const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);
const NAV_HREFS = [
  ...NAV_ITEMS.flatMap((item) => [item.href, ...(item.also ?? [])]),
  "/usage",
  "/billing",
  "/settings",
].map((href) => href.split("?")[0]);

const matches = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);

/** Only the most specific link is active: /twin/sessions lights "Twin sessions", not "Twin agents" too. */
function isActive(pathname: string, href: string, tab: string | null) {
  const [path, query] = href.split("?");
  if (query && new URLSearchParams(query).get("tab") !== tab) return false;
  const own = [
    path,
    ...(NAV_ITEMS.find((item) => item.href === href)?.also ?? []),
  ];
  const hit = own
    .filter((path) => matches(pathname, path))
    .sort((a, b) => b.length - a.length)[0];
  if (!hit) return false;
  return !NAV_HREFS.some(
    (other) =>
      !own.includes(other) &&
      other.length > hit.length &&
      matches(pathname, other),
  );
}

/** The brand doubles as the sidebar toggle on desktop and mobile. */
function Brand() {
  const { state, isMobile } = useSidebar();
  const collapsed = !isMobile && state === "collapsed";
  return (
    <div className="flex min-h-8 items-center justify-between gap-2 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:items-center">
      <SidebarTrigger
        size={collapsed ? "icon" : "default"}
        aria-label="Toggle menu"
        variant={"ghost"}
      >
        <BrandMark className="fill-brand" />
        <span className="text-base font-semibold leading-none tracking-title group-data-[collapsible=icon]:hidden">
          TrainerTwin
        </span>
      </SidebarTrigger>
      <ThemeToggle />
    </div>
  );
}

/** hideRoleplay: a twin-only org (org metadata flag) gets no Role play group. */
export function AppSidebar({
  hideRoleplay = false,
  orgs = [],
  orgId = null,
}: {
  hideRoleplay?: boolean;
  orgs?: SwitchableOrg[];
  orgId?: string | null;
}) {
  const pathname = usePathname();
  const tab = useSearchParams().get("tab");
  const groups = hideRoleplay
    ? NAV_GROUPS.filter((group) => group.label !== "Role play")
    : NAV_GROUPS;

  return (
    <Sidebar variant="sidebar" collapsible="icon">
      <SidebarHeader>
        <Brand />
        {orgs.length >= 2 ? (
          <SidebarMenu>
            <SidebarMenuItem>
              <OrgSwitcher orgs={orgs} orgId={orgId} />
            </SidebarMenuItem>
          </SidebarMenu>
        ) : null}
      </SidebarHeader>
      <SidebarContent className="group-data-[collapsible=icon]:overflow-y-auto">
        <nav aria-label="Sections" className="flex flex-col gap-4">
          {groups.map((group) => (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu className="gap-1">
                  {group.items.map((item) => (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        render={<Link href={item.href} />}
                        isActive={isActive(pathname, item.href, tab)}
                        aria-label={item.title}
                        aria-current={
                          isActive(pathname, item.href, tab) ? "page" : undefined
                        }
                        tooltip={item.title}
                        variant="nav"
                      >
                        <item.icon />
                        <span>{item.title}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>
      <SidebarFooter>
        <SidebarAccountMenu />
      </SidebarFooter>
    </Sidebar>
  );
}
