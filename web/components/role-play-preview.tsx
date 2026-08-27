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

        <div className="space-y-4 pt-2">
          <div className="relative">
            <Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
            <Input
              placeholder="Search learners by name or email..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>

          <div className="max-h-72 space-y-2 overflow-y-auto rounded-xl border bg-muted/20 p-2.5">
            {filteredUsers.length === 0 ? (
              <div className="space-y-1.5 py-8 text-center text-xs text-muted-foreground">
                <p className="font-medium">No learners found</p>
                <p className="text-[11px]">
                  Invite learners from the{" "}
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
                      onCheckedChange={() => toggleUser(user.id)}
                    />
                  </label>
                );
              })
            )}
          </div>
        </div>

        <DialogFooter className="pt-3">
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
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6 sm:p-8 lg:p-10">
      <div className="mx-auto max-w-5xl space-y-8">
        {/* Top Navigation & Actions Bar */}
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3.5">
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
              <Play data-icon="inline-start" /> Test Role Play
            </Button>
          </div>
        </header>

        {/* 2-Column Layout with generous spacing */}
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
          {/* Main Column */}
          <div className="space-y-8 lg:col-span-2">
            {/* Primary Overview Card */}
            <Card className="p-6 sm:p-7">
              <div className="space-y-6">
                <div>
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    <Target className="size-4 text-primary" />
                    <span>Objective & Opening</span>
                  </div>
                  <h2 className="mt-2 text-lg font-semibold leading-snug">
                    {rolePlay.objective || "Practice interview with guided feedback."}
                  </h2>
                </div>

                {rolePlay.opening && (
                  <div className="rounded-2xl bg-accent/40 p-5 sm:p-6">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Opening Prompt
                    </p>
                    <p className="mt-2 text-base font-normal italic leading-relaxed text-foreground">
                      &ldquo;{rolePlay.opening}&rdquo;
                    </p>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-4 pt-1 sm:grid-cols-3">
                  <div className="rounded-xl bg-muted/40 p-4">
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Clock3 className="size-3.5" /> Max Turns
                    </span>
                    <p className="mt-1.5 text-base font-semibold">
                      {rolePlay.config?.turns?.maximum
                        ? `${rolePlay.config.turns.maximum} turns`
                        : "8 turns"}
                    </p>
                  </div>
                  <div className="rounded-xl bg-muted/40 p-4">
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Layers className="size-3.5" /> Structure
                    </span>
                    <p className="mt-1.5 text-base font-semibold">
                      {stages.length
                        ? `${stages.length} Stage${stages.length > 1 ? "s" : ""}`
                        : "Single stage"}
                    </p>
                  </div>
                  <div className="col-span-2 rounded-xl bg-muted/40 p-4 sm:col-span-1">
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Scale className="size-3.5" /> Claim Handling
                    </span>
                    <p className="mt-1.5 text-base font-semibold capitalize">
                      {rolePlay.config?.claim_handling || "Conceptual"}
                    </p>
                  </div>
                </div>
              </div>
            </Card>

            {/* Stages / Interview Rounds Breakdown */}
            {stages.length > 0 && (
              <Card className="p-6 sm:p-7">
                <div className="space-y-6">
                  <div className="flex items-center justify-between pb-1">
                    <div>
                      <h2 className="text-lg font-semibold">Stages & Interview Rounds</h2>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Step-by-step interview phases and evidence criteria
                      </p>
                    </div>
                    <Badge variant="outline">
                      {stages.length} Round{stages.length > 1 ? "s" : ""}
                    </Badge>
                  </div>

                  <div className="space-y-6">
                    {stages.map((stage, idx) => {
                      const evidenceDefs = stage.config?.evidence?.definitions ?? {};
                      const evidenceKeys =
                        stage.config?.evidence?.keys ?? Object.keys(evidenceDefs);
                      const turnBudget = stage.config?.turns;

                      return (
                        <div
                          key={stage.id || idx}
                          className="rounded-2xl bg-muted/30 p-5 sm:p-6 space-y-4 transition-colors"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="space-y-1">
                              <div className="flex items-center gap-2.5">
                                <span className="grid size-6 place-items-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                                  {idx + 1}
                                </span>
                                <h3 className="text-base font-semibold">
                                  {stage.name || `Stage ${idx + 1}`}
                                </h3>
                              </div>
                              <p className="text-xs text-muted-foreground leading-relaxed pl-8.5">
                                {stage.objective}
                              </p>
                            </div>
                            {turnBudget && (
                              <Badge variant="secondary" className="shrink-0 text-xs px-2.5 py-1">
                                {turnBudget.minimum ?? 3}–{turnBudget.maximum ?? 5} turns
                              </Badge>
                            )}
                          </div>

                          {stage.opening && (
                            <div className="rounded-xl bg-muted/60 p-3.5 text-xs text-muted-foreground leading-relaxed">
                              <span className="font-semibold text-foreground">Opening: </span>
                              {stage.opening}
                            </div>
                          )}

                          {evidenceKeys.length > 0 && (
                            <div className="space-y-2.5 pt-1">
                              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                                Required Evidence & Assessment
                              </p>
                              <div className="grid gap-3 sm:grid-cols-2">
                                {evidenceKeys.map((key) => {
                                  const desc = evidenceDefs[key];
                                  return (
                                    <div
                                      key={key}
                                      className="flex items-start gap-2.5 rounded-xl bg-background/90 p-3 text-xs shadow-2xs"
                                    >
                                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                                      <div className="space-y-0.5">
                                        <p className="font-semibold capitalize text-foreground">
                                          {key.replaceAll("_", " ")}
                                        </p>
                                        {desc && (
                                          <p className="text-[11px] leading-snug text-muted-foreground">
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
                  </div>
                </div>
              </Card>
            )}
          </div>

          {/* Right Sidebar Column */}
          <div className="space-y-8">
            {/* Trainer Twin Card */}
            <Card className="overflow-hidden">
              <div className="bg-gradient-to-br from-primary/15 via-primary/5 to-transparent p-6 text-center">
                <div className="relative mx-auto size-28 overflow-hidden rounded-full border-2 border-background shadow-md">
                  <Image
                    src="/vasanth.png"
                    alt={trainerName}
                    width={112}
                    height={112}
                    className="size-full object-cover"
                    priority
                  />
                </div>
                <h2 className="mt-4 text-lg font-bold">{trainerName}</h2>
                <p className="text-xs text-muted-foreground mt-0.5">AI Trainer Twin</p>
                <div className="mt-3 flex justify-center">
                  <Badge variant="secondary" className="gap-1.5 px-2.5 py-1 text-xs">
                    <Volume2 className="size-3.5" /> Voice Cloned
                  </Badge>
                </div>
              </div>
              <CardContent className="p-5 pt-3 text-xs leading-relaxed text-muted-foreground">
                <p>
                  Conducts realistic, multi-turn interview role plays modeled after real
                  evaluation criteria.
                </p>
              </CardContent>
            </Card>

            {/* Role Play Configuration Metadata */}
            <Card className="p-6">
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-semibold">Specifications</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">Core runtime parameters</p>
                </div>
                <div className="space-y-3.5 text-xs pt-1">
                  <div>
                    <span className="text-muted-foreground">Domain:</span>
                    <p className="mt-1 font-semibold capitalize text-foreground">
                      {rolePlay.domainSlug?.replaceAll("-", " ") || "Software Engineering"}
                    </p>
                  </div>

                  <div>
                    <span className="text-muted-foreground">Knowledge Base:</span>
                    <p className="mt-1 font-semibold text-foreground">
                      {rolePlay.knowledgeBaseName ||
                        (rolePlay.knowledgeBase
                          ? rolePlay.knowledgeBase
                          : "General Knowledge")}
                    </p>
                  </div>

                  <div>
                    <span className="text-muted-foreground">Voice Engine:</span>
                    <p className="mt-1 font-semibold text-foreground">
                      {rolePlay.voiceName || "Default Trainer Voice"}
                    </p>
                  </div>
                </div>
              </div>
            </Card>

            {/* Assign to Users Card */}
            <Card className="p-6">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold">Assign to Users</h3>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Grant learners practice access
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
                  slug={rolePlay.slug}
                  availableUsers={usersList}
                  assignedUserIds={assignedIds}
                  onSave={saveAssignments}
                />
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
