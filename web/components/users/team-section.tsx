"use client";

import { useRouter } from "next/navigation";
import { Plus, Search } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { CopyButton } from "@/components/users/copy-button";
import { InviteUser } from "@/components/users/invite-user";
import type { AwaitingUser } from "@/lib/awaiting-users";
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
const ROSE = `${PILL} bg-rose-500/15 text-rose-700 dark:text-rose-300`;
const ROLE = `${PILL} bg-muted text-muted-foreground`;
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
 * Org members and pending invites, split into the studio team (admin, team) and users (learners). Users also lists
 * people given a twin or role play by email who haven't opened their link yet (`awaiting`).
 * One admin per org (fixed); members are disabled, never removed. Roles are shown, not edited here.
 */
export function TeamSection(props: {
  organizationId: string;
  currentUserId: string;
  members: TeamMember[];
  invitations: TeamInvitation[];
  awaiting: AwaitingUser[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState<Record<string, string>>({});
  const [inviting, setInviting] = useState<"team" | "user" | null>(null);

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
              ) : null}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Badge className={ROLE}>{ROLE_LABEL[member.role] ?? member.role}</Badge>
            {locked ? null : (
              <Button variant="ghost" size="sm" disabled={busy === member.id} onClick={() => setDisabled(member, !member.disabledAt)}>
                {member.disabledAt ? "Enable" : "Disable"}
              </Button>
            )}
          </ItemActions>
        </Item>
      );
    });
  }

  /** Assigned by email from a twin or role play; they join when they open their personal link and sign in. */
  function awaitingItems(people: AwaitingUser[]) {
    return people.map((person) => (
      <Item key={person.email} role="listitem" size="sm" className={ROW}>
        <Initial text={person.email} />
        <ItemContent>
          <ItemTitle className="text-[15px]">{person.email.split("@")[0]}</ItemTitle>
          <ItemDescription className="line-clamp-none flex flex-wrap items-center gap-1.5">
            <span>{person.email}</span>· <Badge className={AMBER}>Invite sent</Badge>
            <span className="text-xs">Assigned: {person.assigned.join(", ")}</span>
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Badge className={ROLE}>{ROLE_LABEL.user}</Badge>
        </ItemActions>
      </Item>
    ));
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
          <Badge className={ROLE}>{ROLE_LABEL[invitation.role] ?? invitation.role}</Badge>
          <CopyButton value={inviteUrl(invitation.id)} label="Copy link" />
          <Button variant="outline" size="sm" disabled={busy === invitation.id} onClick={() => resend(invitation)}>Resend</Button>
          <Button variant="ghost" size="sm" disabled={busy === invitation.id} onClick={() => cancel(invitation)}>Cancel</Button>
        </ItemActions>
      </Item>
    ));
  }

  const groups = [
    { title: "Team", role: "team", studio: true, invite: "Invite team member", hint: "Team members run the studio: twins, role plays, sessions and settings." },
    { title: "Users", role: "user", studio: false, invite: "Invite user", hint: "Users practise with the twins and role plays you give them." },
  ] as const;
  const matches = (needle: string, ...fields: string[]) => fields.some((field) => field.toLowerCase().includes(needle));

  return (
    <div className="mt-6 grid gap-6">
      {groups.map((group) => {
        const all = props.members.filter((member) => (member.role !== "user") === group.studio);
        const pending = props.invitations.filter((invitation) => (invitation.role !== "user") === group.studio);
        const assigned = group.studio ? [] : props.awaiting;
        const needle = (query[group.role] ?? "").trim().toLowerCase();
        const members = all.filter((member) => matches(needle, member.name, member.email));
        const invitations = pending.filter((invitation) => matches(needle, invitation.email));
        const waiting = assigned.filter((person) => matches(needle, person.email));
        return (
          <Card key={group.title}>
            <CardHeader>
              <CardTitle>
                {group.title} <span className="text-muted-foreground font-normal">· {all.filter((m) => !m.disabledAt).length}</span>
              </CardTitle>
              <CardAction>
                <Dialog open={inviting === group.role} onOpenChange={(open) => setInviting(open ? group.role : null)}>
                  <DialogTrigger render={<Button size="sm" />}>
                    <Plus />
                    Invite
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                      <DialogTitle>{group.invite}</DialogTitle>
                      <DialogDescription>{group.hint} Add one or more emails, separated by commas; each person gets a sign-up link.</DialogDescription>
                    </DialogHeader>
                    <InviteUser organizationId={props.organizationId} role={group.role} onDone={() => setInviting(null)} />
                  </DialogContent>
                </Dialog>
              </CardAction>
            </CardHeader>
            <CardContent className="grid gap-3">
              {all.length || pending.length || assigned.length ? (
                <div className="relative">
                  <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    type="search"
                    aria-label={`Search ${group.title.toLowerCase()}`}
                    placeholder="Search by name or email"
                    value={query[group.role] ?? ""}
                    onChange={(event) => setQuery((current) => ({ ...current, [group.role]: event.target.value }))}
                    className="pl-9"
                  />
                </div>
              ) : null}
              {members.length || invitations.length || waiting.length ? (
                <ItemGroup className="gap-0 divide-y divide-(--border)">
                  {memberItems(members)}
                  {invitationItems(invitations)}
                  {awaitingItems(waiting)}
                </ItemGroup>
              ) : (
                <p className="text-sm text-muted-foreground">{needle ? "No one matches that search." : "No one yet."}</p>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
