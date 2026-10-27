"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Copy, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { twinClient } from "@/lib/twin/client";
import type { TwinOutputs } from "@/lib/twin/trpc";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SwitchToggle } from "@/components/switch-toggle";
import { AssignDialog } from "@/components/assign-dialog";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/user-avatar";

type LearnerAssign = TwinOutputs["assignments"]["list"][number];

/**
 * Copies the twin's /t/ share link. Same call and cache as the Share dialog; fetched on click, so viewing the page never
 * creates a link. The link opens only for learners assigned to the twin.
 */
function CopyShareLinkButton({ slug }: { slug: string }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<"idle" | "busy" | "copied">("idle");
  async function copy() {
    setState("busy");
    try {
      const { url } = await queryClient.fetchQuery({
        queryKey: ["twin-share-link", slug],
        queryFn: () => twinClient.agents.shareLink.mutate({ slug }),
        staleTime: Infinity,
      });
      await navigator.clipboard.writeText(url);
      setState("copied");
      toast.success("Link copied. Only learners assigned to this twin can open it.");
      setTimeout(() => setState("idle"), 2000);
    } catch {
      setState("idle");
      toast.error("Could not copy the share link. Try again.");
    }
  }
  return (
    // Same shape as "Save changes" below; only the colours differ.
    <button
      type="button"
      onClick={() => void copy()}
      disabled={state === "busy"}
      className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full bg-secondary px-5 text-sm font-medium text-secondary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
    >
      {state === "copied" ? <Check className="size-4" /> : <Copy className="size-4" />}
      <span>{state === "copied" ? "Copied" : "Copy link"}</span>
    </button>
  );
}

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

  const [assignOpen, setAssignOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const assigned = learners.filter((l) => l.assigned);
  const assignable = learners.filter((l) => !l.assigned);

  /** The dialog's Assign: minutes per person; already-active people are skipped server-side. */
  async function assignLearners(emails: string[], minutes: number | null) {
    try {
      const result = await twinClient.assignments.assign.mutate({ slug: id, emails, minutes: minutes ?? defaultMinutes });
      toast.success(`${emails.length} ${emails.length === 1 ? "learner" : "learners"} assigned`);
      if (result.blocked) toast.warning(`${result.blocked} learner(s) belong to another organization and were not assigned.`);
      if (result.emailFailures) toast.warning(`${result.emailFailures} invite email(s) could not be sent.`);
      router.refresh();
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not assign");
      return false;
    }
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
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save");
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

        <div className="mt-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="m-0 text-[20px] font-semibold leading-7 tracking-[-0.015em]">
              Configure twin agent
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Set conversation permissions and manage learner access for this twin.
            </p>
          </div>
          <CopyShareLinkButton slug={id} />
        </div>

        <div className="mt-6 flex flex-col gap-4">
        <Tabs defaultValue={defaultTab} className="gap-4">
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="conversation">Conversation</TabsTrigger>
            <TabsTrigger value="learners">
              Learners
              <span className="text-muted-foreground tabular-nums">· {assigned.length}</span>
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

        {/* Card 3: learners assigned to this twin; Assign opens the shared dialog */}
        <TabsContent value="learners">
        <article id="assign" className="flex flex-col gap-4 rounded-[16px] border border-(--card-border) bg-card p-6 shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="m-0 text-sm font-semibold uppercase tracking-wide text-(--foreground)">Learners</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {assigned.length} assigned. Each gets their own minutes with this twin.
              </p>
            </div>
            <Button onClick={() => setAssignOpen(true)} className="bg-(--brand) text-white hover:bg-[#e04d00]">
              <UserPlus data-icon="inline-start" /> Assign learners
            </Button>
          </div>
          {assigned.length ? (
            <ul className="m-0 flex list-none flex-col overflow-hidden rounded-[12px] border border-(--border) p-0">
              {assigned.map((u, i) => (
                <li key={u.email} className={cn("flex items-center justify-between gap-3 px-4 py-3", i > 0 && "border-t border-(--border)")}>
                  <span className="flex min-w-0 items-center gap-3">
                    <UserAvatar user={u} className="size-8 text-xs" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-semibold">{u.name}</span>
                      <span className="truncate text-xs text-muted-foreground">{u.email}</span>
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {u.minutesUsed} of {u.minutes} min used
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 rounded-[12px] border border-dashed border-(--border) p-6 text-center text-sm text-muted-foreground">Nobody is assigned yet.</p>
          )}
          <AssignDialog
            variant="twin"
            open={assignOpen}
            onOpenChange={setAssignOpen}
            title={twin.name}
            assignedCount={assigned.length}
            people={assignable}
            defaultMinutes={defaultMinutes}
            onAssign={assignLearners}
          />
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
              disabled={saving || !name.trim()}
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
