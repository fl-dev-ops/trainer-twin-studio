"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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

  function memberRows(members: TeamMember[]) {
    return members.map((member) => {
      const you = member.userId === props.currentUserId;
      const locked = you || member.role === "admin";
      return (
        <TableRow key={member.id} className={member.disabledAt ? "opacity-60" : undefined}>
          <TableCell>
            <span className="block font-medium">
              {member.name}
              {you ? <span className="text-muted-foreground font-normal"> (you)</span> : null}
            </span>
            <span className="block text-sm text-muted-foreground">{member.email}</span>
          </TableCell>
          <TableCell className="text-sm text-muted-foreground">
            {member.disabledAt ? <Badge variant="outline">Disabled {day(member.disabledAt)}</Badge> : `Joined ${day(member.createdAt)}`}
          </TableCell>
          <TableCell>
            {locked || member.disabledAt ? (
              <span className="text-sm">{ROLE_LABEL[member.role] ?? member.role}</span>
            ) : (
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
          </TableCell>
          <TableCell className="text-right">
            {locked ? null : (
              <Button variant="outline" size="sm" disabled={busy === member.id} onClick={() => setDisabled(member, !member.disabledAt)}>
                {member.disabledAt ? "Enable" : "Disable"}
              </Button>
            )}
          </TableCell>
        </TableRow>
      );
    });
  }

  function invitationRows(invitations: TeamInvitation[]) {
    return invitations.map((invitation) => (
      <TableRow key={invitation.id}>
        <TableCell>
          <span className="block font-medium">{invitation.email}</span>
          <span className="block text-sm text-muted-foreground">Invited</span>
        </TableCell>
        <TableCell className="text-sm text-muted-foreground">Expires {day(invitation.expiresAt)}</TableCell>
        <TableCell className="text-sm">{ROLE_LABEL[invitation.role] ?? invitation.role}</TableCell>
        <TableCell>
          <div className="flex justify-end gap-2">
            <CopyButton value={inviteUrl(invitation.id)} label="Copy link" />
            <Button variant="outline" size="sm" disabled={busy === invitation.id} onClick={() => resend(invitation)}>Resend</Button>
            <Button variant="ghost" size="sm" disabled={busy === invitation.id} onClick={() => cancel(invitation)}>Cancel</Button>
          </div>
        </TableCell>
      </TableRow>
    ));
  }

  const groups = [
    { title: "Team", hint: "Run the studio: twins, role plays, sessions and settings.", role: "team", studio: true },
    { title: "Users", hint: "Practise with twins and role plays. Disabled people cannot sign in.", role: "user", studio: false },
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
              <CardDescription>{group.hint}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <InviteUser organizationId={props.organizationId} role={group.role} />
              {members.length || invitations.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Person</TableHead>
                      <TableHead className="w-40">Status</TableHead>
                      <TableHead className="w-28">Role</TableHead>
                      <TableHead className="w-48" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {memberRows(members)}
                    {invitationRows(invitations)}
                  </TableBody>
                </Table>
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
