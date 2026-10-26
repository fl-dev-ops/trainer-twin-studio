"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import { useTheme } from "next-themes";
import { History, LogOut, PanelLeft, Settings, UserCheck, UserCog, Users } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { authClient } from "@/lib/auth-client";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { cn } from "@/lib/utils";

const COLLAPSED_KEY = "trainertwin:rail-collapsed";
const COLLAPSED_EVENT = "trainertwin-rail-collapsed";
let memoryCollapsed = false;

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    // Storage unavailable (private windows): use the in-memory choice.
    return memoryCollapsed;
  }
}

function storeCollapsed(next: boolean) {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
  } catch {
    // Storage unavailable: fall back to the in-memory choice.
  }
  memoryCollapsed = next;
  window.dispatchEvent(new Event(COLLAPSED_EVENT));
}

function subscribeCollapsed(onChange: () => void) {
  window.addEventListener(COLLAPSED_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(COLLAPSED_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

const noopSubscribe = () => () => {};

const NAV = [
  { title: "Scenarios", href: "/agents", icon: UserCheck },
  { title: "Role play sessions", href: "/sessions", icon: History },
  { title: "Roleplay users", href: "/learners", icon: Users },
  { title: "Persona", href: "/personas", icon: UserCog },
] as const;

/** Sales orgs' sidebar (V4 "Role play" rail): collapses to icons from the logo, theme toggle beside it. */
export function RoleplaySidebar() {
  const pathname = usePathname();
  const collapsed = useSyncExternalStore(subscribeCollapsed, readCollapsed, () => false);
  const toggle = () => storeCollapsed(!collapsed);

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <aside
      aria-label="Main"
      className={cn(
        "flex h-svh shrink-0 flex-col bg-sidebar px-3 pt-4 pb-3 text-sidebar-foreground transition-[width] duration-200 ease-out motion-reduce:transition-none",
        collapsed ? "w-[72px]" : "w-[248px]",
      )}
    >
      <div className={cn("flex gap-2", collapsed ? "flex-col items-center" : "items-center justify-between")}>
        <RailTip label={collapsed ? "Expand menu" : undefined}>
          <button
            type="button"
            onClick={toggle}
            aria-pressed={collapsed}
            aria-label={collapsed ? "Expand menu" : "Collapse menu"}
            className={cn("group/lockup relative flex items-center gap-2 rounded-lg p-1 hover:bg-sidebar-accent", collapsed && "size-10 justify-center")}
          >
            <Image src="/trainertwin-mark.svg" alt="" width={22} height={17} priority
              className={cn(collapsed && "group-hover/lockup:opacity-0")} />
            {collapsed ? (
              <PanelLeft className="absolute size-5 opacity-0 transition-opacity group-hover/lockup:opacity-100" aria-hidden />
            ) : (
              <span className="text-base font-semibold tracking-[-0.02em]">TrainerTwin</span>
            )}
          </button>
        </RailTip>
        <RailThemeToggle collapsed={collapsed} />
      </div>

      {collapsed ? <hr className="mx-auto my-4 w-8 border-foreground/10" /> : null}

      <nav aria-label="Sections" className={cn("flex flex-col gap-1", collapsed ? "items-center" : "mt-5")}>
        {!collapsed ? (
          <p className="px-2 pb-1 text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">Role play</p>
        ) : null}
        {NAV.map((item) => (
          <RailLink key={item.href} href={item.href} label={item.title} icon={<item.icon className="size-[18px]" />}
            active={isActive(item.href)} collapsed={collapsed} />
        ))}
      </nav>

      <div className={cn("mt-auto flex flex-col gap-3", collapsed && "items-center")}>
        <RailLink href="/profile" label="Settings" icon={<Settings className="size-[18px]" />}
          active={isActive("/profile")} collapsed={collapsed} />
        <RailUser collapsed={collapsed} />
      </div>
    </aside>
  );
}

function RailLink({ href, label, icon, active, collapsed }: {
  href: string;
  label: string;
  icon: ReactNode;
  active: boolean;
  collapsed: boolean;
}) {
  return (
    <RailTip label={collapsed ? label : undefined}>
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        aria-label={collapsed ? label : undefined}
        className={cn(
          "flex h-8 items-center gap-2.5 rounded-lg text-sm transition-colors",
          collapsed ? "w-10 justify-center" : "w-full px-2",
          active ? "bg-card font-medium text-primary shadow-xs" : "text-sidebar-foreground/85 hover:bg-sidebar-accent hover:text-sidebar-foreground",
        )}
      >
        {icon}
        {collapsed ? null : <span className="truncate">{label}</span>}
      </Link>
    </RailTip>
  );
}

/** Tooltip shown beside an icon while the rail is collapsed (white pill, no arrow, as in V4). */
function RailTip({ label, children }: { label?: string; children: ReactElement }) {
  if (!label) return children;
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="right" sideOffset={8}
        className="border bg-popover text-popover-foreground shadow-sm [&_[data-side]]:hidden">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function RailThemeToggle({ collapsed }: { collapsed: boolean }) {
  const { resolvedTheme, setTheme } = useTheme();
  // The theme is only known in the browser; render a placeholder on the server.
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  if (!mounted) return <span className="inline-block size-8" />;
  const dark = resolvedTheme === "dark";
  const label = dark ? "Switch to light" : "Switch to dark";
  return (
    <RailTip label={collapsed ? label : undefined}>
      <button type="button" onClick={() => setTheme(dark ? "light" : "dark")} aria-pressed={dark} aria-label={label}
        className="grid size-8 place-items-center rounded-lg text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground">
        {dark ? (
          <svg viewBox="0 0 16 16" className="size-4" aria-hidden><path d="M9.2 2.2a5.2 5.2 0 1 0 4.6 7.6 4.4 4.4 0 0 1-4.6-7.6Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>
        ) : (
          <svg viewBox="0 0 16 16" className="size-4" aria-hidden><circle cx="8" cy="8" r="2.25" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        )}
      </button>
    </RailTip>
  );
}

/** The signed-in trainer: photo and name; opens Settings or signs out. */
function RailUser({ collapsed }: { collapsed: boolean }) {
  const { data: session } = authClient.useSession();
  const [signingOut, setSigningOut] = useState(false);
  const user = session?.user;
  if (!user) return null;

  async function signOut() {
    setSigningOut(true);
    const { error } = await authClient.signOut();
    if (error) {
      toast.error(error.message ?? "Could not sign out");
      setSigningOut(false);
      return;
    }
    const port = window.location.port ? `:${window.location.port}` : "";
    window.location.assign(`https://auth.${BASE_DOMAIN}${port}/sign-in`);
  }

  const photo = user.image ? (
    // eslint-disable-next-line @next/next/no-img-element -- profile photos are arbitrary URLs
    <img src={user.image} alt="" className="size-8 shrink-0 rounded-full object-cover" />
  ) : (
    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-sm font-semibold">
      {user.name.charAt(0).toUpperCase() || "U"}
    </span>
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
          aria-label={collapsed ? user.name : undefined}
          title={collapsed ? user.name : undefined}
          className={cn(
            "flex items-center gap-3 rounded-xl text-left text-sm",
            collapsed ? "size-10 justify-center rounded-full" : "w-full bg-card p-2.5 shadow-xs hover:bg-card/80",
          )}
        >
          {photo}
          {collapsed ? null : <span className="min-w-0 truncate font-medium">{user.name}</span>}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-56">
        <DropdownMenuItem render={<Link href="/profile" />}>
          <Settings /> Settings
        </DropdownMenuItem>
        <DropdownMenuItem onClick={signOut} disabled={signingOut}>
          <LogOut /> {signingOut ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
