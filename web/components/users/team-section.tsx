"use client";

import { MoreHorizontal, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { UserAvatar } from "@/components/user-avatar";
import { Button } from "@/components/ui/button";
import { PageSection, SECTION_CARD } from "@/components/page-section";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CreditsPager, usePage } from "@/components/credits/credits-pager";
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
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
/** One group's people, 20 a page, as a table like Usage's "Twins and role plays": who, email, role, when added, and a menu. */
function MembersTable({ members, empty, currentUserId, busy, onToggle }: {
  members: TeamMember[];
  empty: string;
  currentUserId: string;
  busy: string | null;
  onToggle: (member: TeamMember) => void;
}) {
  const { rows, ...pager } = usePage(members);
  return (
    <div className={`${SECTION_CARD} overflow-hidden`}>
      {rows.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="hidden sm:table-cell">Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead className="hidden sm:table-cell">Added</TableHead>
              <TableHead><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((member) => {
              const you = member.userId === currentUserId;
              const locked = you || member.role === "admin";
              const learner = member.role === "user";
              return (
                <TableRow key={member.id} className={learner ? "relative" : undefined} data-disabled={member.disabledAt ? true : undefined}>
                  <TableCell>
                    <span className={`flex min-w-0 items-center gap-3 ${member.disabledAt ? "opacity-60" : ""}`}>
                      <UserAvatar user={{ name: member.name, email: member.email }} size="sm" />
                      {learner ? (
                        // A learner's row opens their page (/users/<id>): the name is the link, stretched over the row.
                        <Link href={`/users/${member.userId}`} className="truncate font-medium outline-none after:absolute after:inset-0 hover:underline focus-visible:after:ring-2 focus-visible:after:ring-ring">
                          {member.name}
                        </Link>
                      ) : <span className="truncate font-medium">{member.name}</span>}
                      {you ? <span className="shrink-0 text-muted-foreground">(you)</span> : null}
                      {member.disabledAt ? <Badge variant="error" title={`Disabled ${day(member.disabledAt)}`}>Disabled</Badge> : null}
                    </span>
                  </TableCell>
                  <TableCell className="hidden max-w-56 truncate text-muted-foreground sm:table-cell">{member.email}</TableCell>
                  <TableCell><Badge variant="secondary">{ROLE_LABEL[member.role] ?? member.role}</Badge></TableCell>
                  <TableCell className="hidden text-muted-foreground tabular-nums sm:table-cell">{day(member.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    {locked ? null : (
                      <DropdownMenu>
                        <DropdownMenuTrigger render={<Button variant="subtle" size="icon-sm" className="relative" aria-label={`More for ${member.name}`} disabled={busy === member.id} />}>
                          <MoreHorizontal />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem variant={member.disabledAt ? "default" : "destructive"} onClick={() => onToggle(member)}>
                            {member.disabledAt ? "Enable" : "Disable"}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : (
        <p className="m-0 px-5 py-6 text-center text-sm text-muted-foreground">{empty}</p>
      )}
      <CreditsPager {...pager} />
    </div>
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

  const groups = [
    { title: "Team", role: "team", studio: true, invite: "Add team members", hint: "Team members run the studio: twins, role plays, sessions and settings." },
    { title: "Users", role: "user", studio: false, invite: "Add users", hint: `Users practise with the twins and role plays you give them. Each new user gets ${DEFAULT_LEARNER_MINUTES} credits (1 credit = 1 min of practice) from your organization's credits.` },
  ] as const;
  const matches = (needle: string, ...fields: string[]) => fields.some((field) => field.toLowerCase().includes(needle));

  return (
    <div className="flex flex-col gap-10">
      {groups.map((group) => {
        const all = props.members.filter((member) => (member.role !== "user") === group.studio);
        const needle = (query[group.role] ?? "").trim().toLowerCase();
        const members = all.filter((member) => matches(needle, member.name, member.email));
        return (
          <PageSection
            key={group.title}
            label={group.title}
            title={<>{group.title} <span className="text-muted-foreground font-normal">· {all.filter((m) => !m.disabledAt).length}</span></>}
            description={group.hint}
            action={(
              <>
                {all.length ? (
                  <div className="w-56 max-w-full">
                    <SearchInput
                      aria-label={`Search ${group.title.toLowerCase()}`}
                      placeholder="Search by name or email"
                      value={query[group.role] ?? ""}
                      onChange={(event) => setQuery((current) => ({ ...current, [group.role]: event.target.value }))}
                    />
                  </div>
                ) : null}
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
              </>
            )}
          >
            <MembersTable
              members={members}
              empty={needle ? "No one matches that search." : "No one yet."}
              currentUserId={props.currentUserId}
              busy={busy}
              onToggle={(member) => void setDisabled(member, !member.disabledAt)}
            />
          </PageSection>
        );
      })}
    </div>
  );
}
