"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { UserAvatar } from "@/components/user-avatar";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { InviteUser } from "@/components/users/invite-user";
import { DEFAULT_LEARNER_MINUTES } from "@/lib/minutes-config";
import { useRefresh } from "@/lib/use-refresh";
import { SearchInput } from "@/components/search-input";

export type TeamMember = {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
  disabledAt: string | null;
};

const ROLE_LABEL: Record<string, string> = { admin: "Admin", team: "Team", user: "User" };
const day = (iso: string) => new Date(iso).toLocaleDateString();
// Divided rows (no boxes): avatar · name / email · status badge · actions on the right.
function Initial({ name, email }: { name?: string | null; email: string }) {
  return (
    <ItemMedia className="translate-y-0! self-center!">
      <UserAvatar user={{ name, email }} size="lg" />
    </ItemMedia>
  );
}

/**
 * The org's people (lib/org-people.ts), split into the studio team (admin, team) and users (learners). Someone added is
 * a member right away and just signs in (specs/people.md). One admin per org (fixed); members are disabled, never
 * removed. Roles are shown, not edited here.
 */
export function TeamSection(props: {
  currentUserId: string;
  members: TeamMember[];
}) {
  const refresh = useRefresh();
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState<Record<string, string>>({});
  const [inviting, setInviting] = useState<"team" | "user" | null>(null);

  async function run(key: string, action: () => Promise<Response>, done: string) {
    setBusy(key);
    const result = await action();
    setBusy(null);
    const error = result.ok ? null : ((await result.json().catch(() => null)) as { error?: string } | null)?.error ?? "Something went wrong";
    if (error) {
      toast.error(error);
      return;
    }
    toast.success(done);
    refresh();
  }

  const setDisabled = (member: TeamMember, disabled: boolean) => {
    if (disabled && !window.confirm(`Disable ${member.name}? They are signed out, lose their twin and role-play access, and any live session ends. Their history is kept.`)) return;
    return run(
      member.id,
      () => fetch(`/api/members/${member.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ disabled }) }),
      disabled ? `${member.name} disabled` : `${member.name} enabled`,
    );
  };

  function memberItems(members: TeamMember[]) {
    return members.map((member) => {
      const you = member.userId === props.currentUserId;
      const locked = you || member.role === "admin";
      // A learner's row opens their page (/users/<id>): the name is the link, stretched over the row.
      const learner = member.role === "user";
      return (
        <Item key={member.id} role="listitem" size="row" className={learner ? "relative" : undefined} data-disabled={member.disabledAt ? true : undefined}>
          <Initial name={member.name} email={member.email} />
          <ItemContent>
            <ItemTitle className="text-body">
              {learner ? (
                <Link
                  href={`/users/${member.userId}`}
                  className="outline-none after:absolute after:inset-0 after:rounded-lg hover:underline focus-visible:after:ring-3 focus-visible:after:ring-ring/50"
                >
                  {member.name}
                </Link>
              ) : member.name}
              {you ? <span className="font-normal text-muted-foreground">(you)</span> : null}
            </ItemTitle>
            <ItemDescription className="line-clamp-none flex flex-wrap items-center gap-1.5">
              <span>{member.email}</span>
              {member.disabledAt ? (
                <>· <Badge variant="error">Disabled {day(member.disabledAt)}</Badge></>
              ) : null}
            </ItemDescription>
          </ItemContent>
          <ItemActions className="relative">
            <Badge variant="secondary">{ROLE_LABEL[member.role] ?? member.role}</Badge>
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

  const groups = [
    { title: "Team", role: "team", studio: true, invite: "Add team members", hint: "Team members run the studio: twins, role plays, sessions and settings." },
    { title: "Users", role: "user", studio: false, invite: "Add users", hint: `Users practise with the twins and role plays you give them. Each new user gets ${DEFAULT_LEARNER_MINUTES} credits (1 credit = 1 min of practice) from your organization's credits.` },
  ] as const;
  const matches = (needle: string, ...fields: string[]) => fields.some((field) => field.toLowerCase().includes(needle));

  return (
    <div className="grid gap-6">
      {groups.map((group) => {
        const all = props.members.filter((member) => (member.role !== "user") === group.studio);
        const needle = (query[group.role] ?? "").trim().toLowerCase();
        const members = all.filter((member) => matches(needle, member.name, member.email));
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
                    Add
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                      <DialogTitle>{group.invite}</DialogTitle>
                      <DialogDescription>{group.hint} Add one or more emails, separated by commas. They&apos;re in right away and get an email; they sign in with Google or an email code.</DialogDescription>
                    </DialogHeader>
                    <InviteUser role={group.role} onDone={() => setInviting(null)} />
                  </DialogContent>
                </Dialog>
              </CardAction>
            </CardHeader>
            <CardContent className="grid gap-3">
              {all.length ? (
                <SearchInput
                  aria-label={`Search ${group.title.toLowerCase()}`}
                  placeholder="Search by name or email"
                  value={query[group.role] ?? ""}
                  onChange={(event) => setQuery((current) => ({ ...current, [group.role]: event.target.value }))}
                />
              ) : null}
              {members.length ? (
                <ItemGroup divided>
                  {memberItems(members)}
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
