"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import {
  ArrowLeft,
  Clock,
  FileText,
  MessageSquare,
  Pencil,
  Play,
  Search,
  Target,
  UserCheck,
  UserPlus,
  Users,
  Volume2,
} from "lucide-react";
import { toast } from "sonner";
import { PageContainer } from "@/components/page-container";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
  domainSlug?: string;
  objective?: string;
  opening?: string;
  voiceId?: string;
  voiceName?: string;
  knowledgeBase?: string;
  knowledgeBaseName?: string;
  status?: "draft" | "published";
  version?: number;
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
  trainerName = "Trainer",
}: {
  rolePlay: RolePlayData;
  availableUsers?: OrganizationUser[];
  assignedUserIds?: string[];
  trainerName?: string;
}) {
  const stages = rolePlay.stages ?? [];
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
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6 sm:p-8 lg:p-10">
      <PageContainer size="wide" className="flex flex-col gap-8">
        {/* Top Navigation & Actions Bar */}
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3.5">
            <Button
              variant="ghost"
              size="icon-sm"
              nativeButton={false}
              render={<Link href="/agents" />}
              aria-label="Back to scenarios"
            >
              <ArrowLeft />
            </Button>
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
                  {rolePlay.name}
                </h1>
                {rolePlay.status === "draft" ? (
                  <Badge variant="outline">Draft</Badge>
                ) : (
                  <Badge variant="success">Published</Badge>
                )}
              </div>
              <p className="font-mono text-xs text-muted-foreground mt-1">
                {rolePlay.slug}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link href={`/agents/${encodeURIComponent(rolePlay.slug)}/edit`} />}
            >
              <Pencil data-icon="inline-start" /> Edit Spec
            </Button>
            <Button
              nativeButton={false}
              render={<Link href={`/talk?agent=${encodeURIComponent(rolePlay.slug)}`} />}
            >
              <Play data-icon="inline-start" /> Test Scenario
            </Button>
          </div>
        </header>

        {/* 2-Column Layout with generous spacing */}
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
          {/* Main Column */}
          <div className="space-y-8 lg:col-span-2">
            {/* Primary Overview Card */}
            <Card className="p-6 sm:p-7">
              <div>
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <Target className="size-4 text-primary" />
                  <span>Objective</span>
                </div>
                <h2 className="mt-2 text-lg font-semibold leading-snug">
                  {rolePlay.objective || "Practice interview with guided feedback."}
                </h2>
              </div>
            </Card>

            {/* Stages / Interview Rounds Breakdown */}
            {stages.length > 0 && (
              <section className="space-y-4">
                {/*<div className="px-4">
                  <h2 className="text-lg font-semibold tracking-tight">
                    Stages & Interview Rounds
                  </h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Step-by-step interview phases and evidence criteria
                  </p>
                </div>*/}

                <div className="space-y-6">
                  {stages.map((stage, idx) => {
                    const evidenceDefs = stage.config?.evidence?.definitions ?? {};
                    const evidenceKeys =
                      stage.config?.evidence?.keys ?? Object.keys(evidenceDefs);

                    return (
                      <div
                        key={stage.id || idx}
                        className="rounded-2xl bg-muted/30 p-6 space-y-4 transition-colors border"
                      >
                        <div className="space-y-1">
                          <h3 className="text-base font-semibold text-foreground">
                            {stage.name || `Stage ${idx + 1}`}
                          </h3>
                          <p className="text-sm text-muted-foreground leading-relaxed">
                            {stage.objective}
                          </p>
                        </div>

                        {evidenceKeys.length > 0 && (
                          <div className="space-y-3 pt-2">
                            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                              Required Evidence & Assessment
                            </p>
                            <div className="grid gap-3 sm:grid-cols-2">
                              {evidenceKeys.map((key) => {
                                const desc = evidenceDefs[key];
                                return (
                                  <div
                                    key={key}
                                    className="rounded-xl bg-background/90 p-4 shadow-xs"
                                  >
                                    <p className="text-sm font-semibold capitalize text-foreground">
                                      {key.replaceAll("_", " ")}
                                    </p>
                                    {desc && (
                                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                                        {desc}
                                      </p>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </div>

          {/* Right Sidebar Column */}
          <div className="space-y-8">
            {/* Trainer Twin Card with Integrated Stats */}
            <Card className="overflow-hidden p-0! gap-0! space-y-0!">
              <div className="bg-linear-to-br from-primary/15 via-primary/5 to-transparent p-5 text-center">
                <div className="relative mx-auto size-20 overflow-hidden rounded-full border-2 border-background shadow-sm">
                  <Image
                    src="/vasanth.png"
                    alt={trainerName}
                    width={80}
                    height={80}
                    className="size-full object-cover"
                    priority
                  />
                </div>
                <h2 className="mt-3 text-base font-bold">{trainerName}</h2>
                <p className="text-xs text-muted-foreground mt-0.5">AI Trainer Twin</p>
                <div className="mt-2.5 flex justify-center">
                  <Badge variant="secondary" className="gap-1 px-2 py-0.5 text-[11px]">
                    <Volume2 className="size-3" /> Voice Cloned
                  </Badge>
                </div>
              </div>

              <CardContent className="p-5 space-y-4 border-t">
                {/* Stats Rows */}
                <div className="space-y-2.5">
                  {/* Hours of interviews */}
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <div className="grid size-7 place-items-center rounded-lg bg-indigo-100 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400">
                        <Clock className="size-3.5" />
                      </div>
                      <span className="text-xs text-muted-foreground">
                        of interviews
                      </span>
                    </div>
                    <span className="text-sm font-semibold text-foreground">
                      10.5 hrs
                    </span>
                  </div>

                  {/* Turns */}
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <div className="grid size-7 place-items-center rounded-lg bg-amber-100 text-amber-600 dark:bg-amber-950/60 dark:text-amber-400">
                        <MessageSquare className="size-3.5" />
                      </div>
                      <span className="text-xs text-muted-foreground">
                        Turns
                      </span>
                    </div>
                    <span className="text-sm font-semibold text-foreground">
                      3,143
                    </span>
                  </div>

                  {/* Words */}
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <div className="grid size-7 place-items-center rounded-lg bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-400">
                        <FileText className="size-3.5" />
                      </div>
                      <span className="text-xs text-muted-foreground">
                        words
                      </span>
                    </div>
                    <span className="text-sm font-semibold text-foreground">
                      109,790
                    </span>
                  </div>
                </div>

                <p className="text-xs leading-relaxed text-muted-foreground border-t pt-3.5">
                  Runs realistic, multi-turn scenarios using the configured behavior and evaluation criteria.
                </p>
              </CardContent>
            </Card>

            {/* Assign to Users Card */}
            <Card className="p-6">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold">Assign to Users</h3>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {rolePlay.status === "published"
                        ? "Assign this role play to learners"
                        : "Publish this role play before assigning it"}
                    </p>
                  </div>
                  <Badge variant="secondary" className="gap-1 text-[11px]">
                    <Users className="size-3" />
                    {assignedIds.length}
                  </Badge>
                </div>

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
              </div>
            </Card>
          </div>
        </div>
      </PageContainer>
    </div>
  );
}
