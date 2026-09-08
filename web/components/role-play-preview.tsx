"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowLeft,
  Pencil,
  Play,
  Search,
  UserCheck,
  UserPlus,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { MessageResponse } from "@/components/ai-elements/message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export type OrganizationUser = {
  id: string;
  name: string;
  email: string;
};

export type RolePlayData = {
  slug: string;
  name: string;
  objective?: string;
  instruction?: string;
  opening?: string;
  voiceId?: string;
  voiceName?: string;
  knowledgeBase?: string;
  knowledgeBaseName?: string;
  status?: "draft" | "published";
  version?: number;
  draftRevision?: number;
  stages?: Array<{
    id: string;
    name: string;
    objective: string;
    opening?: string;
    config?: {
      knowledge?: { tags?: string[] };
      claim_handling?: string;
      evidence?: {
        definitions?: Record<string, string>;
        keys?: string[];
        completion_keys?: string[];
      };
      turns?: { minimum?: number; maximum?: number };
    };
  }>;
  config?: {
    claim_handling?: string;
    context?: { mode?: string; required?: boolean };
    actions?: {
      allowed?: string[];
      default?: string;
      max_probes_per_lane?: number;
    };
    evidence?: { statuses?: string[] };
    turns?: { maximum?: number };
    rendering?: {
      maximum_words?: number;
      maximum_question_marks?: number;
      one_focal_ask?: boolean;
      deterministic_closing?: boolean;
    };
  };
};

function AssignUsersDialog({
  availableUsers,
  assignedUserIds,
  disabled,
  saving,
  onSave,
}: {
  availableUsers: OrganizationUser[];
  assignedUserIds: string[];
  disabled: boolean;
  saving: boolean;
  onSave: (ids: string[]) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>(assignedUserIds);
  const [search, setSearch] = useState("");

  const filteredUsers = availableUsers.filter(
    (user) =>
      user.name.toLowerCase().includes(search.toLowerCase()) ||
      user.email.toLowerCase().includes(search.toLowerCase()),
  );

  function handleOpenChange(next: boolean) {
    if (next) {
      setSelected(assignedUserIds);
      setSearch("");
    }
    setOpen(next);
  }

  function toggleUser(id: string) {
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  async function handleSave() {
    try {
      await onSave(selected);
      setOpen(false);
    } catch {
      // The parent reports the server error and keeps the dialog open for retry.
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm" className="w-full text-xs" disabled={disabled} />
        }
      >
        <UserPlus data-icon="inline-start" /> {disabled ? "Publish to assign" : "Assign learners"}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Assign Users</DialogTitle>
          <DialogDescription>
            Select which users can run this scenario.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div className="relative">
            <Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
            <Input
              placeholder="Search users by name or email..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
              disabled={saving}
            />
          </div>

          <div className="max-h-72 space-y-2 overflow-y-auto rounded-xl border bg-muted/20 p-2.5">
            {filteredUsers.length === 0 ? (
              <div className="space-y-1.5 py-8 text-center text-xs text-muted-foreground">
                <p className="font-medium">No users found</p>
                <p className="text-[11px]">
                  Invite users from the{" "}
                  <Link
                    href="/users"
                    className="text-foreground underline underline-offset-2 hover:text-primary"
                  >
                    Users page
                  </Link>
                  .
                </p>
              </div>
            ) : (
              filteredUsers.map((user) => {
                const isChecked = selected.includes(user.id);
                return (
                  <label
                    key={user.id}
                    className="flex cursor-pointer items-center justify-between gap-3 rounded-lg p-2.5 transition-colors hover:bg-accent/50"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                        {user.name.slice(0, 1).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium">{user.name}</p>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {user.email}
                        </p>
                      </div>
                    </div>
                    <Checkbox
                      checked={isChecked}
                      disabled={saving}
                      onCheckedChange={() => toggleUser(user.id)}
                    />
                  </label>
                );
              })
            )}
          </div>
        </div>

        <DialogFooter className="pt-3">
          <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button size="sm" disabled={saving} onClick={handleSave}>
            {saving ? "Saving…" : "Save assignments"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RolePlayPreview({
  rolePlay,
  availableUsers = [],
  assignedUserIds = [],
}: {
  rolePlay: RolePlayData;
  availableUsers?: OrganizationUser[];
  assignedUserIds?: string[];
}) {
  const [assignedIds, setAssignedIds] = useState<string[]>(assignedUserIds);
  const [savingAssignments, setSavingAssignments] = useState(false);

  async function saveAssignments(memberIds: string[]) {
    setSavingAssignments(true);
    try {
      const response = await fetch(
        `/api/role-play/${encodeURIComponent(rolePlay.slug)}/assignments`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ memberIds }),
        },
      );
      const result = await response.json().catch(() => null) as {
        memberIds?: string[];
        added?: number;
        removed?: number;
        emailFailures?: number;
        error?: string;
      } | null;
      if (!response.ok || !result?.memberIds) {
        throw new Error(result?.error ?? "Assignments could not be saved");
      }

      setAssignedIds(result.memberIds);
      if (result.emailFailures) {
        toast.warning(
          `Assignments saved, but ${result.emailFailures} notification email${result.emailFailures === 1 ? "" : "s"} could not be sent.`,
        );
      } else if ((result.added ?? 0) === 0 && (result.removed ?? 0) === 0) {
        toast.success("Assignments are already up to date");
      } else {
        toast.success(`${result.memberIds.length} learner${result.memberIds.length === 1 ? "" : "s"} assigned`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Assignments could not be saved");
      throw error;
    } finally {
      setSavingAssignments(false);
    }
  }

  const usersList: OrganizationUser[] = availableUsers;
  const assignedUsers = usersList.filter((u) => assignedIds.includes(u.id));

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-5 sm:p-8">
      <PageContainer size="wide">
        <Link
          href="/agents"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground hover:underline"
        >
          <ArrowLeft className="size-4" /> All scenarios
        </Link>

        <PageHeader
          className="mt-4 border-b pb-6"
          title={
            <span className="flex flex-wrap items-center gap-2.5 break-words">
              {rolePlay.name}
              {rolePlay.status === "draft" ? (
                <Badge variant="outline">Draft</Badge>
              ) : (
                <Badge variant="success">Published</Badge>
              )}
            </span>
          }
          description={`${rolePlay.slug} · ${rolePlay.status === "draft" ? `draft revision ${rolePlay.version}` : `published version ${rolePlay.version}`}`}
          actions={
            <>
              <Button variant="outline" nativeButton={false} render={<Link href={`/agents/${encodeURIComponent(rolePlay.slug)}/edit`} />}>
                <Pencil data-icon="inline-start" /> Edit scenario
              </Button>
              {rolePlay.status === "published" ? (
                <Button nativeButton={false} render={<Link href={`/talk?agent=${encodeURIComponent(rolePlay.slug)}`} />}>
                  <Play data-icon="inline-start" /> Test scenario
                </Button>
              ) : (
                <Button disabled>
                  <Play data-icon="inline-start" /> Publish to test
                </Button>
              )}
            </>
          }
        />

        {rolePlay.draftRevision && (
          <div className="mt-6 flex flex-col gap-3 rounded-xl border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium">Unpublished changes</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Draft revision {rolePlay.draftRevision} is newer than the published scenario shown here.
              </p>
            </div>
            <Button variant="outline" size="sm" nativeButton={false} render={<Link href={`/agents/${encodeURIComponent(rolePlay.slug)}/edit`} />}>
              Continue editing
            </Button>
          </div>
        )}

        <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-w-0 space-y-8">
            <section>
              <h2 className="text-lg font-semibold">Instructions</h2>
              <MessageResponse className="mt-3 max-h-[35rem] overflow-y-auto rounded-xl border bg-muted/50 p-4 text-base leading-relaxed">
                {rolePlay.instruction || rolePlay.objective || "No instructions captured for this scenario yet."}
              </MessageResponse>
            </section>

            {rolePlay.opening && (
              <section>
                <h2 className="text-lg font-semibold">First message</h2>
                <p className="mt-3 text-base leading-relaxed text-muted-foreground">{rolePlay.opening}</p>
              </section>
            )}
          </div>

          <div className="min-w-0">
            <Card>
              <CardHeader className="flex-row items-start justify-between gap-3">
                <div>
                  <CardTitle>Assigned learners</CardTitle>
                  <CardDescription>
                    {rolePlay.status === "published"
                      ? "Choose who can run this scenario."
                      : "Publish this scenario before assigning it."}
                  </CardDescription>
                </div>
                <Badge variant="secondary" className="gap-1 text-[11px]">
                  <Users className="size-3" />
                  {assignedIds.length}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-4">

                {assignedUsers.length > 0 ? (
                  <div className="space-y-2 rounded-xl bg-muted/40 p-3">
                    {assignedUsers.slice(0, 3).map((u) => (
                      <div
                        key={u.id}
                        className="flex items-center gap-2 text-xs"
                      >
                        <UserCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                        <span className="truncate font-medium">{u.name}</span>
                      </div>
                    ))}
                    {assignedUsers.length > 3 && (
                      <p className="pt-1 text-[11px] text-muted-foreground">
                        +{assignedUsers.length - 3} more learners assigned
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="rounded-xl bg-muted/30 p-3 text-center text-xs text-muted-foreground">
                    No users assigned yet
                  </div>
                )}

                <AssignUsersDialog
                  availableUsers={usersList}
                  assignedUserIds={assignedIds}
                  disabled={rolePlay.status !== "published"}
                  saving={savingAssignments}
                  onSave={saveAssignments}
                />
              </CardContent>
            </Card>
          </div>
        </div>
      </PageContainer>
    </div>
  );
}
