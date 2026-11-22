"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AudioLines, BookOpenText, KeyRound, LogOut, Users } from "lucide-react";
import { toast } from "sonner";
import { BillingIcon, CreditsIcon, SettingsIcon, SupportIcon } from "@/components/icons";
import { useSidebarCredits } from "@/components/credits/sidebar-credits";
import { SupportDialog } from "@/components/support-dialog";
import { avatarLabel, UserAvatar } from "@/components/user-avatar";
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
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { DEFAULT_LEARNER_MINUTES } from "@/lib/minutes-config";
import { cn } from "@/lib/utils";

const DOCS_URL =
  process.env.NEXT_PUBLIC_DOCS_URL ??
  (process.env.NODE_ENV === "development"
    ? "https://docs.trainertwin.localhost"
    : "https://docs.trainertwin.com");

/** A flat profile footer with account and studio actions in an upward-opening menu. */
export function SidebarAccountMenu() {
  const { data: session } = authClient.useSession();
  const [signingOut, setSigningOut] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const user = session?.user;
  const credits = useSidebarCredits();
  // Share the existing banner query rather than fetch the same billing overview twice.
  const { data: billing } = useQuery({ queryKey: ["billing.overview", "banner"], queryFn: () => api.billing.overview.query(), staleTime: 5 * 60_000, retry: false, enabled: Boolean(user) });

  if (!user) return null;

  const name = avatarLabel(user);
  const plan = billing?.billed ? (billing.plan === "paid" ? "Paid plan" : "Trial plan") : null;
  const remaining = credits ? `${credits.balanceMinutes.toLocaleString()} min` : null;
  const low = credits ? credits.balanceMinutes < DEFAULT_LEARNER_MINUTES : false;
  const subtitle = [plan, remaining && `${remaining} left`].filter(Boolean).join(" · ") || user.email;

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
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <SidebarMenuButton
              size="lg"
              variant="account"
              aria-label={`Account menu for ${name}`}
              aria-description={subtitle}
              tooltip={name}
              className="rounded-xl"
            />
          }
        >
          <UserAvatar user={user} size="md" />
          <span className="flex min-w-0 flex-1 flex-col text-left group-data-[collapsible=icon]:hidden">
            <span className="truncate font-normal leading-5">{name}</span>
            <span className={cn("truncate text-sm leading-5 text-muted-foreground", low && "text-caution")}>
              {subtitle}
            </span>
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent variant="account" side="top" align="start" sideOffset={8}>
          <DropdownMenuGroup>
            <DropdownMenuLabel className="font-normal">
              <span className="flex min-w-0 items-center gap-3">
                <UserAvatar user={user} size="md" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-base leading-5 text-foreground">{name}</span>
                  <span className="truncate text-sm leading-5">{user.email}</span>
                </span>
              </span>
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem variant="account" render={<Link href="/usage" />}>
              <CreditsIcon />
              <span>Usage</span>
              {remaining ? <span className={cn("ml-auto text-sm tabular-nums text-muted-foreground", low && "text-caution")}>{remaining}</span> : null}
            </DropdownMenuItem>
            <DropdownMenuItem variant="account" render={<Link href="/billing" />}>
              <BillingIcon />
              Billing
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem variant="account" render={<Link href="/voice" />}>
              <AudioLines />
              Voices
            </DropdownMenuItem>
            <DropdownMenuItem variant="account" render={<Link href="/settings?tab=team" />}>
              <Users />
              Team
            </DropdownMenuItem>
            <DropdownMenuItem variant="account" render={<Link href="/developer" />}>
              <KeyRound />
              Developer API
            </DropdownMenuItem>
            <DropdownMenuItem variant="account" render={<Link href="/settings" />}>
              <SettingsIcon />
              Settings
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem variant="account" onClick={() => setSupportOpen(true)}>
              <SupportIcon />
              Support
            </DropdownMenuItem>
            <DropdownMenuItem variant="account" render={<a href={DOCS_URL} target="_blank" rel="noreferrer" />}>
              <BookOpenText />
              Docs
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem variant="account" onClick={signOut} disabled={signingOut}>
              <LogOut />
              {signingOut ? "Signing out…" : "Log out"}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <SupportDialog open={supportOpen} onOpenChange={setSupportOpen} />
    </>
  );
}
