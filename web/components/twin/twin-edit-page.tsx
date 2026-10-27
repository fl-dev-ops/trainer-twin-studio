"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, Check, Search } from "lucide-react";
import { toast } from "sonner";
import { twinClient } from "@/lib/twin/client";
import type { TwinOutputs } from "@/lib/twin/trpc";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SwitchToggle } from "@/components/switch-toggle";

type LearnerAssign = TwinOutputs["assignments"]["list"][number];

const AVATAR_TONES = [
  "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  "bg-orange-500/15 text-orange-600 dark:text-orange-400",
];

export function TwinEditPage({
  twin,
  learners,
  defaultMinutes,
  defaultTab = "general",
}: {
  twin: Pick<TwinOutputs["agents"]["get"], "slug" | "name" | "description" | "settings">;
  learners: LearnerAssign[];
  defaultMinutes: number;
  /** /edit opens on General, /assign on Learners. All tabs share one Save. */
  defaultTab?: "general" | "conversation" | "learners";
}) {
  const id = twin.slug;
  const router = useRouter();

  // General fields
  const [name, setName] = useState(twin.name);
  const [description, setDescription] = useState(twin.description ?? "");

  // Before conversation start
  const [preScreenshare, setPreScreenshare] = useState(twin.settings.preScreenshare);
  const [preUpload, setPreUpload] = useState(twin.settings.preUpload);
  const [uploadTitle, setUploadTitle] = useState(twin.settings.uploadTitle);
  const [uploadInstruction, setUploadInstruction] = useState(twin.settings.uploadInstruction);

  // During conversation
  const [duringUpload, setDuringUpload] = useState(twin.settings.duringUpload);

  // Assign learners (selection is by email). Assigning only: existing assignments are not changed here.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [minutes, setMinutes] = useState(String(defaultMinutes));
  const [query, setQuery] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const assignedCount = learners.filter((l) => l.assigned).length;
  const minutesValue = Number(minutes);
  const minutesValid = Number.isInteger(minutesValue) && minutesValue >= 1 && minutesValue <= 10_000;

  const filtered = learners.filter(
    (l) =>
      l.name.toLowerCase().includes(query.toLowerCase()) ||
      l.email.toLowerCase().includes(query.toLowerCase())
  );

  function togglePick(learnerId: string) {
    setSelectedIds((prev) =>
      prev.includes(learnerId) ? prev.filter((i) => i !== learnerId) : [...prev, learnerId]
    );
  }

  async function handleSave() {
    setSaving(true);
    let settingsSaved = false;
    try {
      await twinClient.agents.update.mutate({
        slug: id,
        name,
        description,
        settings: { preScreenshare, preUpload, duringUpload, uploadTitle, uploadInstruction },
      });
      settingsSaved = true;
      if (selectedIds.length) {
        // Already-active people are skipped server-side, so retrying after a failure sends no second invite.
        const result = await twinClient.assignments.assign.mutate({ slug: id, emails: selectedIds, minutes: minutesValue });
        if (result.blocked) toast.warning(`${result.blocked} learner(s) belong to another organization and were not assigned.`);
        if (result.emailFailures) toast.warning(`${result.emailFailures} invite email(s) could not be sent.`);
        setSelectedIds([]);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save";
      // The selection is kept so assigning can be retried.
      toast.error(settingsSaved ? `Settings saved, but the learners were not assigned: ${message}` : message);
    } finally {
      setSaving(false);
      if (settingsSaved) router.refresh();
    }
  }

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] px-4 md:px-0 pt-5 pb-16">
        {/* Header Back navigation */}
        <header className="flex min-h-10 items-center justify-between gap-4">
          <Link
            href={`/twin/${id}`}
            className="inline-flex items-center gap-2 text-sm text-(--foreground) hover:text-muted-foreground transition-colors"
          >
            <ArrowLeft className="size-4" />
            <span>Back</span>
          </Link>
        </header>

        <div className="mt-6">
          <h1 className="m-0 text-[20px] font-semibold leading-7 tracking-[-0.015em]">
            Configure twin agent
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Set conversation permissions and manage learner access for this twin.
          </p>
        </div>

        <div className="mt-6 flex flex-col gap-4">
        <Tabs defaultValue={defaultTab} className="gap-4">
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="conversation">Conversation</TabsTrigger>
            <TabsTrigger value="learners">
              Learners
              {selectedIds.length > 0 ? <span className="text-(--brand) tabular-nums">· {selectedIds.length}</span> : null}
            </TabsTrigger>
          </TabsList>

        {/* Card 1: name and description */}
        <TabsContent value="general">
        <article className="flex flex-col gap-6 rounded-[16px] border border-(--card-border) bg-card p-6 shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="bot-name" className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Bot name
              </label>
              <input
                id="bot-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-10 rounded-lg border border-(--border) bg-transparent px-3 text-sm text-(--foreground) outline-none focus:border-(--brand) focus:ring-1 focus:ring-(--brand)"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="bot-desc" className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Description
              </label>
              <textarea
                id="bot-desc"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="rounded-lg border border-(--border) bg-transparent p-3 text-sm text-(--foreground) outline-none focus:border-(--brand) focus:ring-1 focus:ring-(--brand)"
              />
            </div>
          </div>

        </article>
        </TabsContent>

        {/* Card 2: before and during conversation settings */}
        <TabsContent value="conversation">
        <article className="flex flex-col gap-6 rounded-[16px] border border-(--card-border) bg-card p-6 shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]">
          {/* Section: Before conversation start */}
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="m-0 text-sm font-semibold uppercase tracking-wide text-(--foreground)">
                Before conversation start
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Permissions and configuration presented to the learner before the call begins.
              </p>
            </div>

            <div className="flex flex-col divide-y divide-(--border) rounded-[12px] border border-(--border) bg-(--sidebar) px-4">
              <div className="flex items-center justify-between gap-4 py-3.5">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">Enable screenshare</span>
                  <span className="text-xs text-muted-foreground">
                    Learners share their entire screen when the conversation starts, so the twin can follow along.
                  </span>
                </div>
                <SwitchToggle
                  checked={preScreenshare}
                  onChange={setPreScreenshare}
                  label="Enable screenshare before conversation start"
                />
              </div>

              <div className="flex items-center justify-between gap-4 py-3.5">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">Enable upload or Upload file configuration</span>
                  <span className="text-xs text-muted-foreground">
                    Allow learners to upload documents or select files prior to the session.
                  </span>
                </div>
                <SwitchToggle
                  checked={preUpload}
                  onChange={setPreUpload}
                  label="Enable upload before conversation start"
                />
              </div>

              {preUpload ? (
                <div className="flex flex-col gap-3 py-3.5">
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="upload-title" className="text-xs font-medium text-muted-foreground">
                      Upload title
                    </label>
                    <input
                      id="upload-title"
                      type="text"
                      maxLength={80}
                      value={uploadTitle}
                      placeholder="e.g. Listing brochure, Client brief"
                      onChange={(e) => setUploadTitle(e.target.value)}
                      className="h-9 rounded-lg border border-(--border) bg-card px-3 text-sm text-(--foreground) outline-none focus:border-(--brand) focus:ring-1 focus:ring-(--brand)"
                    />
                    <span className="text-xs text-muted-foreground">Shown on the upload card before the conversation.</span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="upload-instruction" className="text-xs font-medium text-muted-foreground">
                      What to upload
                    </label>
                    <input
                      id="upload-instruction"
                      type="text"
                      maxLength={300}
                      value={uploadInstruction}
                      placeholder="e.g. Upload the property brochure you want to discuss."
                      onChange={(e) => setUploadInstruction(e.target.value)}
                      className="h-9 rounded-lg border border-(--border) bg-card px-3 text-sm text-(--foreground) outline-none focus:border-(--brand) focus:ring-1 focus:ring-(--brand)"
                    />
                    <span className="text-xs text-muted-foreground">Tells the learner which file to add. Uploading stays optional.</span>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {/* Section: During a conversation */}
          <div className="flex flex-col gap-4 border-t border-(--border) pt-6">
            <div>
              <h2 className="m-0 text-sm font-semibold uppercase tracking-wide text-(--foreground)">
                During a conversation
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                In-session controls available while the learner is speaking with the twin.
              </p>
            </div>

            <div className="flex flex-col divide-y divide-(--border) rounded-[12px] border border-(--border) bg-(--sidebar) px-4">
              <div className="flex items-center justify-between gap-4 py-3.5">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">Enable upload</span>
                  <span className="text-xs text-muted-foreground">
                    Learners can upload an image or a document for clarification during conversation.
                  </span>
                </div>
                <SwitchToggle
                  checked={duringUpload}
                  onChange={setDuringUpload}
                  label="Enable upload during conversation"
                />
              </div>
            </div>
          </div>

        </article>
        </TabsContent>

        {/* Card 3: assign learners */}
        <TabsContent value="learners">
        <article id="assign" className="flex flex-col gap-6 rounded-[16px] border border-(--card-border) bg-card p-6 shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]">
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h2 className="m-0 text-sm font-semibold uppercase tracking-wide text-(--foreground)">
                  Assign learners
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Give learners practice access to this twin agent.
                </p>
              </div>
              <span className="text-xs text-muted-foreground">
                <span className="text-(--foreground) font-semibold">{assignedCount}</span> assigned
                {selectedIds.length > 0 && <span className="text-(--brand)"> · {selectedIds.length} newly selected</span>}
              </span>
            </div>

            {/* Minutes for the people being assigned now */}
            <div className="flex items-center justify-between gap-4">
              <label htmlFor="assign-minutes" className="text-sm font-medium">
                Minutes per selected learner
              </label>
              <input
                id="assign-minutes"
                type="number"
                inputMode="numeric"
                min={1}
                max={10_000}
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                aria-invalid={!minutesValid}
                className="h-9 w-28 rounded-lg border border-(--border) bg-transparent px-3 text-sm tabular-nums text-(--foreground) outline-none focus:border-(--brand) focus:ring-1 focus:ring-(--brand) aria-invalid:border-destructive"
              />
            </div>

            {/* Search box */}
            <div className="relative">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <input
                type="search"
                placeholder="Search by name or email"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-10 w-full rounded-full border border-(--border) bg-(--sidebar) pl-10 pr-4 text-sm text-(--foreground) outline-none focus:border-(--brand) focus:ring-1 focus:ring-(--brand)"
              />
            </div>

            {/* Learner checklist */}
            <div className="flex flex-col overflow-hidden rounded-[12px] border border-(--border)">
              {filtered.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  {learners.length ? "No one matches that search." : "No learners in your organization yet."}
                </p>
              ) : (
                filtered.map((u, i) => {
                  const isSelected = selectedIds.includes(u.email);
                  return (
                    <label
                      key={u.email}
                      className={cn(
                        "flex items-center justify-between gap-3 p-3.5 px-4 cursor-pointer transition-colors hover:bg-(--sidebar)",
                        i > 0 && "border-t border-(--border)",
                        u.assigned && "opacity-80"
                      )}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <input
                          type="checkbox"
                          checked={u.assigned || isSelected}
                          disabled={u.assigned}
                          onChange={() => togglePick(u.email)}
                          className="size-4 rounded accent-(--brand) cursor-pointer"
                        />
                        <span
                          className={cn(
                            "grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold",
                            AVATAR_TONES[i % AVATAR_TONES.length]
                          )}
                          aria-hidden
                        >
                          {u.name.charAt(0).toUpperCase()}
                        </span>
                        <div className="flex flex-col min-w-0">
                          <span className="text-sm font-semibold truncate text-(--foreground)">{u.name}</span>
                          <span className="text-xs text-muted-foreground truncate">{u.email}</span>
                        </div>
                      </div>

                      <div className="shrink-0">
                        {u.assigned ? (
                          <span className="inline-flex items-center rounded-full bg-(--sidebar) border border-(--border) px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                            Assigned · {u.minutesUsed} of {u.minutes} min used
                          </span>
                        ) : isSelected ? (
                          <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                            Selected ({minutesValid ? minutesValue : "?"} min)
                          </span>
                        ) : null}
                      </div>
                    </label>
                  );
                })
              )}
            </div>
          </div>

        </article>
        </TabsContent>
        </Tabs>

          {/* Action buttons */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <Link
              href={`/twin/${id}`}
              className="inline-flex h-9 items-center rounded-full px-4 text-sm font-medium text-muted-foreground hover:text-(--foreground)"
            >
              Cancel
            </Link>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving || !name.trim() || (selectedIds.length > 0 && !minutesValid)}
              className="inline-flex h-9 items-center gap-2 rounded-full bg-(--brand) px-5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {saved && <Check className="size-4" />}
              <span>{saved ? "Saved" : "Save changes"}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
