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
            className="h-11 gap-2.5 rounded-xl bg-card px-2 text-[13px] shadow-xs hover:bg-card data-open:bg-card"
          />
        }
      >
        <UserAvatar user={user} size="sm" />
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
          <DropdownMenuItem render={<Link href="/users" />}>
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
