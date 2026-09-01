"use client";

import Link from "next/link";
import { useState } from "react";
import { KeyRound, LogOut, Moon, Palette, Sun, UserRound } from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { authClient } from "@/lib/auth-client";
import { BASE_DOMAIN } from "@/lib/base-domain";

export function SidebarAccountMenu({
  profileHref,
  isActive = false,
}: {
  profileHref?: string;
  isActive?: boolean;
}) {
  const { data: session } = authClient.useSession();
  const { resolvedTheme, setTheme } = useTheme();
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
        render={<SidebarMenuButton size="lg" isActive={isActive} tooltip="Profile" />}
      >
        <Avatar>
          {user.image ? <AvatarImage src={user.image} alt="" /> : null}
          <AvatarFallback>{user.name.charAt(0).toUpperCase() || "U"}</AvatarFallback>
        </Avatar>
        <span className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
          <span className="block truncate font-medium">{user.name}</span>
          <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-56">
        <DropdownMenuGroup>
          {profileHref ? (
            <DropdownMenuItem render={<Link href={profileHref} />}>
              <UserRound />
              Profile
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem render={<Link href="/developer" />}>
            <KeyRound />
            Developer API
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <div className="flex items-center justify-between gap-4 px-1.5 py-1.5">
          <span className="flex items-center gap-1.5 text-sm">
            <Palette className="size-4" />
            Theme
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={resolvedTheme === "dark" ? "Use light theme" : "Use dark theme"}
            onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          >
            {resolvedTheme === "dark" ? <Sun /> : <Moon />}
          </Button>
        </div>
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
