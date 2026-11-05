"use client";

import { useState } from "react";
import { Building2, ChevronsUpDown } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { authClient } from "@/lib/auth-client";

export type SwitchableOrg = { id: string; name: string; slug: string };

/**
 * Sidebar org switcher, for people in two or more studio orgs (nothing otherwise): shows the org this page is in and
 * opens a list of the others. Switching makes it the session's active org and opens the studio home in it.
 */
export function OrgSwitcher({ orgs, orgId }: { orgs: SwitchableOrg[]; orgId: string | null }) {
  const [switching, setSwitching] = useState(false);
  if (orgs.length < 2) return null;
  const current = orgs.find((org) => org.id === orgId);

  async function switchOrg(id: string) {
    if (id === orgId || switching) return;
    setSwitching(true);
    const { error } = await authClient.organization.setActive({ organizationId: id });
    if (error) {
      toast.error(error.message ?? "Could not switch organization");
      setSwitching(false);
      return;
    }
    // A full load on purpose: the old org's pages and cached data (React Query) must not carry over.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/");
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<SidebarMenuButton variant="nav" tooltip={current?.name ?? "Organization"} disabled={switching} />}>
        <Building2 />
        <span className="min-w-0 flex-1 truncate">{switching ? "Switching…" : (current?.name ?? "Organization")}</span>
        <ChevronsUpDown className="ml-auto text-muted-foreground group-data-[collapsible=icon]:hidden" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Organization</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={orgId ?? ""} onValueChange={(value) => void switchOrg(String(value))}>
            {orgs.map((org) => (
              <DropdownMenuRadioItem key={org.id} value={org.id} disabled={switching} closeOnClick>
                <span className="truncate">{org.name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
