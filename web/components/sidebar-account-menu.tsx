"use client";

import Link from "next/link";
import { useState } from "react";
import { AudioLines, BookOpenText, KeyRound, LogOut, UserCog, Users } from "lucide-react";
import { toast } from "sonner";
import { UserAvatar } from "@/components/user-avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { authClient } from "@/lib/auth-client";
import { BASE_DOMAIN } from "@/lib/base-domain";

const DOCS_URL =
  process.env.NEXT_PUBLIC_DOCS_URL ??
  (process.env.NODE_ENV === "development"
    ? "https://docs.trainertwin.localhost"
    : "https://docs.trainertwin.com");

/** Footer user card. Its menu also holds studio pages that are not in the main nav. */
export function SidebarAccountMenu() {
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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <SidebarMenuButton
            size="lg"
            tooltip={user.name}
            className={cn(
              // Reference "rail-user" card: 48px tall, 1px card border, 12px radius,
              // resting shadow, surface-sunken hover; collapses to a bare 32px photo.
              "h-12 gap-3 rounded-[12px] bg-card px-2 pr-3 text-sm shadow-[0_1px_2px_rgb(30_28_25/0.04),0_2px_8px_rgb(30_28_25/0.05)]",
              "border border-(--card-border) hover:bg-(--sidebar) hover:text-foreground data-open:bg-card dark:data-open:bg-card",
              "group-data-[collapsible=icon]:h-8! group-data-[collapsible=icon]:p-0! group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:shadow-none",
            )}
          />
        }
      >
        <UserAvatar user={user} size="md" />
        <span className="min-w-0 flex-1 truncate font-medium group-data-[collapsible=icon]:hidden">{user.name}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="truncate font-normal text-muted-foreground">{user.email}</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem render={<Link href="/personas" />}>
            <UserCog />
            Personas
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href="/voice" />}>
            <AudioLines />
            Voices
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href="/settings#team" />}>
            <Users />
            Team
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href="/developer" />}>
            <KeyRound />
            Developer API
          </DropdownMenuItem>
          <DropdownMenuItem render={<a href={DOCS_URL} target="_blank" rel="noreferrer" />}>
            <BookOpenText />
            Docs
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={signOut} disabled={signingOut}>
            <LogOut />
            {signingOut ? "Signing out…" : "Log out"}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
