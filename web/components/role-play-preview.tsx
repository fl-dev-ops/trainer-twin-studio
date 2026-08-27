"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Layers,
  Pencil,
  Play,
  Scale,
  Search,
  Target,
  UserCheck,
  UserPlus,
  Users,
  Volume2,
} from "lucide-react";
import { toast } from "sonner";
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
  slug,
  availableUsers,
  assignedUserIds,
  onSave,
}: {
  slug: string;
  availableUsers: OrganizationUser[];
  assignedUserIds: string[];
  onSave: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>(assignedUserIds);
  const [search, setSearch] = useState("");

  useEffect(() => {
    setSelected(assignedUserIds);
  }, [assignedUserIds, open]);

  const filteredUsers = availableUsers.filter(
    (u) =>
      u.name.toLowerCase().includes(search.toLowerCase()) ||
      u.email.toLowerCase().includes(search.toLowerCase()),
  );

  function toggleUser(id: string) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  }

  function handleSave() {
    onSave(selected);
    setOpen(false);
    toast.success(`Updated user assignments (${selected.length} assigned)`);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm" className="w-full text-xs" />
        }
      >
        <UserPlus data-icon="inline-start" /> Assign Users
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Assign Users</DialogTitle>
          <DialogDescription>
            Select which learners can practice this role play.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 pt-1">
          <div className="relative">
            <Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
            <Input
              placeholder="Search learners by name or email..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>

          <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-lg border bg-muted/20 p-2">
            {filteredUsers.length === 0 ? (
              <div className="space-y-1 py-6 text-center text-xs text-muted-foreground">
                <p>No learners found.</p>
                <p className="text-[11px]">
                  Invite learners from the{" "}
                  <Link href="/users" className="text-foreground underline underline-offset-2">
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
                    className="flex cursor-pointer items-center justify-between gap-3 rounded-lg p-2 transition-colors hover:bg-accent/50"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
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
                      onCheckedChange={() => toggleUser(user.id)}
                    />
                  </label>
                );
              })
            )}
          </div>
        </div>

        <DialogFooter className="pt-2">
          <DialogClose render={<Button variant="outline" size="sm" />}>
            Cancel
          </DialogClose>
          <Button size="sm" onClick={handleSave}>
            Save Assignments
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RolePlayPreview({
  rolePlay,
  orgSlug,
  availableUsers = [],
  trainerName = "Vasanth",
}: {
  rolePlay: RolePlayData;
  orgSlug?: string;
  availableUsers?: OrganizationUser[];
  trainerName?: string;
}) {
  const stages = rolePlay.stages ?? [];
  const storageKey = `assigned_users_${rolePlay.slug}`;

  const [assignedIds, setAssignedIds] = useState<string[]>([]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        setAssignedIds(JSON.parse(stored));
      }
    } catch {
      setAssignedIds([]);
    }
  }, [storageKey]);

  function saveAssignments(ids: string[]) {
    setAssignedIds(ids);
    try {
      localStorage.setItem(storageKey, JSON.stringify(ids));
    } catch {
      // ignore
    }
  }

  const usersList: OrganizationUser[] = availableUsers;
  const assignedUsers = usersList.filter((u) => assignedIds.includes(u.id));

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-5xl space-y-6">
        {/* Top Navigation & Actions Bar */}
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon-sm"
              nativeButton={false}
              render={<Link href="/agents" />}
              aria-label="Back to role plays"
            >
              <ArrowLeft />
            </Button>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold tracking-tight sm:text-2xl">
                  {rolePlay.name}
                </h1>
                {rolePlay.status === "draft" ? (
                  <Badge variant="outline">Draft</Badge>
                ) : (
                  <Badge variant="success">Published</Badge>
                )}
              </div>
              <p className="font-mono text-xs text-muted-foreground mt-0.5">
                {rolePlay.slug}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
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
              <Play data-icon="inline-start" /> Test Role Play
            </Button>
          </div>
        </header>

        {/* 2-Column Layout */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Main Column */}
          <div className="space-y-6 lg:col-span-2">
            {/* Primary Overview Card */}
            <Card>
              <CardHeader className="pb-4">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <Target className="size-4 text-primary" />
                  <span>Objective & Opening</span>
                </div>
                <CardTitle className="mt-1 text-lg">
                  {rolePlay.objective || "Practice interview with guided feedback."}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {rolePlay.opening && (
                  <div className="rounded-xl bg-accent/40 p-4">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Opening Prompt
                    </p>
                    <p className="mt-1.5 text-sm font-medium italic text-foreground">
                      &ldquo;{rolePlay.opening}&rdquo;
                    </p>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3 pt-1 sm:grid-cols-3">
                  <div className="rounded-lg bg-muted/40 p-3">
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Clock3 className="size-3.5" /> Max Turns
                    </span>
                    <p className="mt-1 text-sm font-semibold">
                      {rolePlay.config?.turns?.maximum
                        ? `${rolePlay.config.turns.maximum} turns`
                        : "8 turns"}
                    </p>
                  </div>
                  <div className="rounded-lg bg-muted/40 p-3">
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Layers className="size-3.5" /> Structure
                    </span>
                    <p className="mt-1 text-sm font-semibold">
                      {stages.length
                        ? `${stages.length} Stage${stages.length > 1 ? "s" : ""}`
                        : "Single stage"}
                    </p>
                  </div>
                  <div className="col-span-2 rounded-lg bg-muted/40 p-3 sm:col-span-1">
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Scale className="size-3.5" /> Claim Handling
                    </span>
                    <p className="mt-1 text-sm font-semibold capitalize">
                      {rolePlay.config?.claim_handling || "Conceptual"}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Stages / Interview Rounds Breakdown */}
            {stages.length > 0 && (
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-base">Stages & Interview Rounds</CardTitle>
                      <CardDescription>
                        Step-by-step interview phases and evidence criteria
                      </CardDescription>
                    </div>
                    <Badge variant="outline">
                      {stages.length} Round{stages.length > 1 ? "s" : ""}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {stages.map((stage, idx) => {
                    const evidenceDefs = stage.config?.evidence?.definitions ?? {};
                    const evidenceKeys =
                      stage.config?.evidence?.keys ?? Object.keys(evidenceDefs);
                    const turnBudget = stage.config?.turns;

                    return (
                      <div
                        key={stage.id || idx}
                        className="rounded-xl bg-muted/30 p-4 transition-colors"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="grid size-6 place-items-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                                {idx + 1}
                              </span>
                              <h3 className="text-sm font-semibold">
                                {stage.name || `Stage ${idx + 1}`}
                              </h3>
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {stage.objective}
                            </p>
                          </div>
                          {turnBudget && (
                            <Badge variant="secondary" className="shrink-0 text-[11px]">
                              {turnBudget.minimum ?? 3}–{turnBudget.maximum ?? 5} turns
                            </Badge>
                          )}
                        </div>

                        {stage.opening && (
                          <div className="mt-3 rounded-lg bg-muted/60 p-2.5 text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">Opening: </span>
                            {stage.opening}
                          </div>
                        )}

                        {evidenceKeys.length > 0 && (
                          <div className="mt-3 space-y-1.5">
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                              Required Evidence & Assessment
                            </p>
                            <div className="grid gap-1.5 sm:grid-cols-2">
                              {evidenceKeys.map((key) => {
                                const desc = evidenceDefs[key];
                                return (
                                  <div
                                    key={key}
                                    className="flex items-start gap-2 rounded-lg bg-background/80 p-2.5 text-xs"
                                  >
                                    <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                                    <div>
                                      <p className="font-medium capitalize text-foreground">
                                        {key.replaceAll("_", " ")}
                                      </p>
                                      {desc && (
                                        <p className="mt-0.5 text-[11px] leading-tight text-muted-foreground">
                                          {desc}
                                        </p>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            )}
          </div>

          {/* Right Sidebar Column */}
          <div className="space-y-6">
            {/* Trainer Twin Card */}
            <Card className="overflow-hidden">
              <div className="bg-gradient-to-br from-primary/15 via-primary/5 to-transparent p-5 text-center">
                <div className="relative mx-auto size-24 overflow-hidden rounded-full border-2 border-background shadow-md">
                  <Image
                    src="/vasanth.png"
                    alt={trainerName}
                    width={96}
                    height={96}
                    className="size-full object-cover"
                    priority
                  />
                </div>
                <h2 className="mt-3 text-base font-bold">{trainerName}</h2>
                <p className="text-xs text-muted-foreground">AI Trainer Twin</p>
                <div className="mt-2.5 flex justify-center">
                  <Badge variant="secondary" className="gap-1 text-[11px]">
                    <Volume2 className="size-3" /> Voice Cloned
                  </Badge>
                </div>
              </div>
              <CardContent className="p-4 pt-3 text-xs text-muted-foreground">
                <p>
                  Conducts realistic, multi-turn interview role plays modeled after real
                  evaluation criteria.
                </p>
              </CardContent>
            </Card>

            {/* Role Play Configuration Metadata */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Specifications</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-xs">
                <div>
                  <span className="text-muted-foreground">Domain:</span>
                  <p className="mt-0.5 font-medium capitalize text-foreground">
                    {rolePlay.domainSlug?.replaceAll("-", " ") || "Software Engineering"}
                  </p>
                </div>

                <div>
                  <span className="text-muted-foreground">Knowledge Base:</span>
                  <p className="mt-0.5 font-medium text-foreground">
                    {rolePlay.knowledgeBaseName ||
                      (rolePlay.knowledgeBase
                        ? rolePlay.knowledgeBase
                        : "General Knowledge")}
                  </p>
                </div>

                <div>
                  <span className="text-muted-foreground">Voice Engine:</span>
                  <p className="mt-0.5 font-medium text-foreground">
                    {rolePlay.voiceName || "Default Trainer Voice"}
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Assign to Users Card */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm">Assign to Users</CardTitle>
                  <Badge variant="secondary" className="gap-1 text-[11px]">
                    <Users className="size-3" />
                    {assignedIds.length} Assigned
                  </Badge>
                </div>
                <CardDescription className="text-xs">
                  Grant learners access to practice this role play
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {assignedUsers.length > 0 ? (
                  <div className="space-y-1.5 rounded-lg bg-muted/40 p-2.5">
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
                      <p className="pt-0.5 text-[11px] text-muted-foreground">
                        +{assignedUsers.length - 3} more learners assigned
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="rounded-lg bg-muted/30 p-2.5 text-center text-xs text-muted-foreground">
                    No users assigned yet
                  </div>
                )}

                <AssignUsersDialog
                  slug={rolePlay.slug}
                  availableUsers={usersList}
                  assignedUserIds={assignedIds}
                  onSave={saveAssignments}
                />
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
