"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { CopyButton } from "@/components/users/copy-button";
import { InviteUser } from "@/components/users/invite-user";
import { authClient } from "@/lib/auth-client";
import { BASE_DOMAIN } from "@/lib/base-domain";

export type TeamMember = {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
  disabledAt: string | null;
};
export type TeamInvitation = { id: string; email: string; role: string; expiresAt: string };

const ROLE_LABEL: Record<string, string> = { admin: "Admin", team: "Team", user: "User" };
const inviteUrl = (id: string) => `https://auth.${BASE_DOMAIN}/invite?token=${id}`;
const day = (iso: string) => new Date(iso).toLocaleDateString();
const PILL = "rounded-full border-0 px-2.5 font-medium";
const AMBER = `${PILL} bg-amber-500/15 text-amber-700 dark:text-amber-300`;
const BLUE = `${PILL} bg-blue-500/15 text-blue-700 dark:text-blue-300`;
const ROSE = `${PILL} bg-rose-500/15 text-rose-700 dark:text-rose-300`;
// Divided rows (no boxes): avatar · name / email · status pill · actions on the right.
const ROW = "rounded-none border-0 px-0 py-3";

function Initial({ text }: { text: string }) {
  return (
    <ItemMedia className="translate-y-0! self-center!">
      <span aria-hidden className="grid size-9 place-items-center rounded-full bg-(--brand)/15 text-sm font-semibold text-(--brand)">
        {text.charAt(0).toUpperCase()}
      </span>
    </ItemMedia>
  );
}

/**
 * Org members and pending invites, split into the studio team (admin, team) and users (learners).
 * One admin per org (fixed); members are disabled, never removed. Better Auth enforces both server-side too.
 */
export function TeamSection(props: {
  organizationId: string;
  currentUserId: string;
  members: TeamMember[];
  invitations: TeamInvitation[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function run(key: string, action: () => Promise<{ error?: { message?: string } | null } | Response>, done: string) {
    setBusy(key);
    const result = await action();
    setBusy(null);
    const error = result instanceof Response
      ? (result.ok ? null : ((await result.json().catch(() => null)) as { error?: string } | null)?.error ?? "Something went wrong")
      : result.error ? (result.error.message ?? "Something went wrong") : null;
    if (error) {
      toast.error(error);
      return;
    }
    toast.success(done);
    router.refresh();
  }

  const setRole = (member: TeamMember, role: string) =>
    run(member.id, () => authClient.organization.updateMemberRole({ memberId: member.id, role: role as "team" | "user", organizationId: props.organizationId }), `${member.name} is now ${ROLE_LABEL[role]}`);
  const setDisabled = (member: TeamMember, disabled: boolean) => {
    if (disabled && !window.confirm(`Disable ${member.name}? They are signed out, lose their twin and role-play access, and any live session ends. Their history is kept.`)) return;
    return run(
      member.id,
      () => fetch(`/api/members/${member.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ disabled }) }),
      disabled ? `${member.name} disabled` : `${member.name} enabled`,
    );
  };
  const resend = (invitation: TeamInvitation) =>
    run(invitation.id, () => authClient.organization.inviteMember({ email: invitation.email, role: invitation.role as "team" | "user", organizationId: props.organizationId, resend: true }), "Invitation sent again");
  const cancel = (invitation: TeamInvitation) =>
    run(invitation.id, () => authClient.organization.cancelInvitation({ invitationId: invitation.id }), "Invitation cancelled");

  function memberItems(members: TeamMember[]) {
    return members.map((member) => {
      const you = member.userId === props.currentUserId;
      const locked = you || member.role === "admin";
      return (
        <Item key={member.id} role="listitem" size="sm" className={ROW}>
          <Initial text={member.name || member.email} />
          <ItemContent className={member.disabledAt ? "opacity-60" : undefined}>
            <ItemTitle className="text-[15px]">
              {member.name}
              {you ? <span className="font-normal text-muted-foreground">(you)</span> : null}
            </ItemTitle>
            <ItemDescription className="line-clamp-none flex flex-wrap items-center gap-1.5">
              <span>{member.email}</span>
              {member.disabledAt ? (
                <>· <Badge className={ROSE}>Disabled {day(member.disabledAt)}</Badge></>
              ) : member.role === "admin" ? (
                <>· <Badge className={BLUE}>Admin</Badge></>
              ) : null}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            {locked || member.disabledAt ? null : (
              <NativeSelect
                size="sm"
                aria-label={`Role of ${member.name}`}
                value={member.role}
                disabled={busy === member.id}
                onChange={(event) => setRole(member, event.target.value)}
              >
                <NativeSelectOption value="team">Team</NativeSelectOption>
                <NativeSelectOption value="user">User</NativeSelectOption>
              </NativeSelect>
            )}
            {locked ? null : (
              <Button variant="outline" size="sm" disabled={busy === member.id} onClick={() => setDisabled(member, !member.disabledAt)}>
                {member.disabledAt ? "Enable" : "Disable"}
              </Button>
            )}
          </ItemActions>
        </Item>
      );
    });
  }

  function invitationItems(invitations: TeamInvitation[]) {
    return invitations.map((invitation) => (
      <Item key={invitation.id} role="listitem" size="sm" className={ROW}>
        <Initial text={invitation.email} />
        <ItemContent>
          <ItemTitle className="text-[15px]">{invitation.email.split("@")[0]}</ItemTitle>
          <ItemDescription className="line-clamp-none flex flex-wrap items-center gap-1.5">
            <span>{invitation.email}</span>· <Badge className={AMBER}>Invite sent</Badge>
            <span className="text-xs">expires {day(invitation.expiresAt)}</span>
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <CopyButton value={inviteUrl(invitation.id)} label="Copy link" />
          <Button variant="outline" size="sm" disabled={busy === invitation.id} onClick={() => resend(invitation)}>Resend</Button>
          <Button variant="ghost" size="sm" disabled={busy === invitation.id} onClick={() => cancel(invitation)}>Cancel</Button>
        </ItemActions>
      </Item>
    ));
  }

  const groups = [
    { title: "Team", role: "team", studio: true },
    { title: "Users", role: "user", studio: false },
  ] as const;

  return (
    <div className="mt-6 grid gap-6">
      {groups.map((group) => {
        const members = props.members.filter((member) => (member.role !== "user") === group.studio);
        const invitations = props.invitations.filter((invitation) => (invitation.role !== "user") === group.studio);
        return (
          <Card key={group.title}>
            <CardHeader>
              <CardTitle>
                {group.title} <span className="text-muted-foreground font-normal">· {members.filter((m) => !m.disabledAt).length}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <InviteUser organizationId={props.organizationId} role={group.role} />
              {members.length || invitations.length ? (
                <ItemGroup className="gap-0 divide-y divide-(--border)">
                  {memberItems(members)}
                  {invitationItems(invitations)}
                </ItemGroup>
              ) : (
                <p className="text-sm text-muted-foreground">No one yet.</p>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
