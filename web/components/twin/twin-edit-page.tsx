"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Copy, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { twinClient } from "@/lib/twin/client";
import type { TwinOutputs } from "@/lib/twin/trpc";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SwitchToggle } from "@/components/switch-toggle";
import { AssignDialog, PendingBadge } from "@/components/assign-dialog";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/user-avatar";
import { useRefresh } from "@/lib/use-refresh";
import { PageContainer } from "@/components/page-container";

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
    <Button variant="secondary" onClick={() => void copy()} disabled={state === "busy"}>
      {state === "copied" ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
      {state === "copied" ? "Copied" : "Copy link"}
    </Button>
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
  /** /edit opens on General, /assign on Learners. General saves with its button; the other tabs save as you go. */
  defaultTab?: "general" | "conversation" | "learners";
}) {
  const id = twin.slug;
  const refresh = useRefresh();

  // General fields
  const [name, setName] = useState(twin.name);
  const [description, setDescription] = useState(twin.description ?? "");

  // Conversation settings: saved on change (toggles) or on blur (text), one request at a time so the last one wins.
  const [settings, setSettings] = useState(twin.settings);
  const savedSettings = useRef(twin.settings);
  const settingsQueue = useRef(Promise.resolve());
  const { preScreenshare, preUpload, uploadTitle, uploadInstruction, duringUpload } = settings;

  const [assignOpen, setAssignOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const assigned = learners.filter((l) => l.assigned);
  const assignable = learners.filter((l) => !l.assigned);

  /** The dialog's Assign: minutes per person; already-active people are skipped server-side. */
  async function assignLearners(emails: string[], minutes: number | null) {
    try {
      const result = await twinClient.assignments.assign.mutate({ slug: id, emails, minutes: minutes ?? defaultMinutes });
      // Say what actually happened: assigned (and emailed), already had access, or blocked by another org.
      const done = result.added + result.reactivated;
      const people = (n: number) => `${n} ${n === 1 ? "learner" : "learners"}`;
      if (done) toast.success(`${people(done)} assigned and sent their link`);
      if (result.skipped) toast.info(`${people(result.skipped)} already had this twin`);
      if (result.blocked) toast.warning(`${people(result.blocked)} belong to another organization and were not assigned`);
      if (result.emailFailures) toast.warning(`${result.emailFailures} invite email(s) could not be sent.`);
      refresh();
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not assign");
      return false;
    }
  }

  /** Saves conversation settings with the twin's *saved* name and description, so General's unsaved edits stay unsaved. */
  function saveSettings(next: typeof settings) {
    setSettings(next);
    settingsQueue.current = settingsQueue.current.then(async () => {
      if (JSON.stringify(next) === JSON.stringify(savedSettings.current)) return;
      try {
        await twinClient.agents.update.mutate({ slug: id, name: twin.name, description: twin.description ?? "", settings: next });
        savedSettings.current = next;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not save");
        setSettings(savedSettings.current);
      }
    });
  }

  async function handleSave() {
    setSaving(true);
    let settingsSaved = false;
    try {
      await twinClient.agents.update.mutate({
        slug: id,
        name,
        description,
        settings: savedSettings.current,
      });
      settingsSaved = true;
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save");
    } finally {
      setSaving(false);
      if (settingsSaved) refresh();
    }
  }

  return (
    <PageContainer>
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
          <h1 className="m-0 text-title-m font-semibold leading-7 tracking-title">
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
      <article className="flex flex-col gap-6 rounded-tt-lg border border-(--card-border) bg-card p-6 shadow-card">
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
        <div className="flex items-center justify-end gap-3 pt-4">
          <Button variant="ghost" nativeButton={false} render={<Link href={`/twin/${id}`} />}>
            Cancel
          </Button>
          <Button variant="brand" onClick={() => void handleSave()} disabled={saving || !name.trim()}>
            {saved && <Check data-icon="inline-start" />}
            {saved ? "Saved" : "Save changes"}
          </Button>
        </div>
      </TabsContent>

      {/* Card 2: before and during conversation settings, saved as they change */}
      <TabsContent value="conversation">
      <article className="flex flex-col gap-6 rounded-tt-lg border border-(--card-border) bg-card p-6 shadow-card">
        {/* Section: Before conversation start */}
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="m-0 text-sm font-semibold uppercase tracking-wide text-(--foreground)">
              Before conversation start
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Permissions and configuration presented to the learner before the call begins. Changes save automatically.
            </p>
          </div>

          <div className="flex flex-col divide-y divide-(--border) rounded-tt-md border border-(--border) bg-(--sidebar) px-4">
            <div className="flex items-center justify-between gap-4 py-3.5">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">Enable screenshare</span>
                <span className="text-xs text-muted-foreground">
                  Learners share their entire screen when the conversation starts, so the twin can follow along.
                </span>
              </div>
              <SwitchToggle
                checked={preScreenshare}
                onChange={(checked) => saveSettings({ ...settings, preScreenshare: checked })}
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
                onChange={(checked) => saveSettings({ ...settings, preUpload: checked })}
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
                    onChange={(e) => setSettings({ ...settings, uploadTitle: e.target.value })}
                    onBlur={() => saveSettings(settings)}
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
                    onChange={(e) => setSettings({ ...settings, uploadInstruction: e.target.value })}
                    onBlur={() => saveSettings(settings)}
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

          <div className="flex flex-col divide-y divide-(--border) rounded-tt-md border border-(--border) bg-(--sidebar) px-4">
            <div className="flex items-center justify-between gap-4 py-3.5">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">Enable upload</span>
                <span className="text-xs text-muted-foreground">
                  Learners can upload an image or a document for clarification during conversation.
                </span>
              </div>
              <SwitchToggle
                checked={duringUpload}
                onChange={(checked) => saveSettings({ ...settings, duringUpload: checked })}
                label="Enable upload during conversation"
              />
            </div>
          </div>
        </div>

      </article>
      </TabsContent>

      {/* Card 3: learners assigned to this twin; Assign opens the shared dialog */}
      <TabsContent value="learners">
      <article id="assign" className="flex flex-col gap-4 rounded-tt-lg border border-(--card-border) bg-card p-6 shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="m-0 text-sm font-semibold uppercase tracking-wide text-(--foreground)">Learners</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {assigned.length} assigned. Each gets their own minutes with this twin.
            </p>
          </div>
          <Button variant="brand" onClick={() => setAssignOpen(true)} >
            <UserPlus data-icon="inline-start" /> Assign learners
          </Button>
        </div>
        {assigned.length ? (
          <ul className="m-0 flex list-none flex-col overflow-hidden rounded-tt-md border border-(--border) p-0">
            {assigned.map((u, i) => (
              <li key={u.email} className={cn("flex items-center justify-between gap-3 px-4 py-3", i > 0 && "border-t border-(--border)")}>
                <span className="flex min-w-0 items-center gap-3">
                  <UserAvatar user={u} size="md" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-semibold">{u.name}</span>
                    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      {u.name !== u.email ? <span className="truncate">{u.email}</span> : null}
                      {u.pending ? <PendingBadge /> : null}
                    </span>
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {u.minutesUsed} of {u.minutes} min used
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 rounded-tt-md border border-dashed border-(--border) p-6 text-center text-sm text-muted-foreground">Nobody is assigned yet.</p>
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

      </div>
    </PageContainer>
  );
}
