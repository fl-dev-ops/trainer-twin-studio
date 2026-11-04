"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
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
import { AccessUntil } from "@/components/twin/access-until";
import { TWIN_UPLOAD_TITLE_DEFAULT } from "@/lib/context-upload";

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
  /** The upload card's text as typed; saved only with its Save button (switches save on their own). */
  const [card, setCard] = useState({ uploadTitle: settings.uploadTitle, uploadInstruction: settings.uploadInstruction });
  const cardDirty = card.uploadTitle !== settings.uploadTitle || card.uploadInstruction !== settings.uploadInstruction;
  const savedSettings = useRef(twin.settings);
  const settingsQueue = useRef(Promise.resolve());

  // The page first renders from cached data, then the fresh copy arrives: take its values when they differ from what
  // this page last received (otherwise coming back after a change shows the old values).
  const [received, setReceived] = useState(twin);
  if (received !== twin) {
    setReceived(twin);
    if (JSON.stringify(twin.settings) !== JSON.stringify(received.settings)) {
      setSettings(twin.settings);
      // Unsaved upload card text stays (a switch saved meanwhile); untouched text follows the saved values.
      const untouched = card.uploadTitle === received.settings.uploadTitle && card.uploadInstruction === received.settings.uploadInstruction;
      if (untouched) setCard({ uploadTitle: twin.settings.uploadTitle, uploadInstruction: twin.settings.uploadInstruction });
    }
    if (twin.name !== received.name) setName(twin.name);
    if (twin.description !== received.description) setDescription(twin.description ?? "");
  }
  useEffect(() => {
    savedSettings.current = twin.settings;
  }, [twin.settings]);
  // Leaving the page (closing, reloading) with unsaved upload card text asks first.
  useEffect(() => {
    if (!cardDirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [cardDirty]);
  const { preScreenshare, preUpload, duringUpload } = settings;

  const [assignOpen, setAssignOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const assigned = learners.filter((l) => l.assigned);
  const assignable = learners.filter((l) => !l.assigned);

  /** The dialog's Assign: minutes per person; already-active people are skipped server-side. */
  async function assignLearners(emails: string[], minutes: number | null, accessUntil: string | null) {
    try {
      const result = await twinClient.assignments.assign.mutate({ slug: id, emails, minutes: minutes ?? defaultMinutes, accessUntil });
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

  /**
   * Saves conversation settings with the twin's *saved* name and description, so General's unsaved edits stay unsaved.
   * `done` is the toast once saved; the cached page data is refreshed so other pages (and coming back) show the change.
   */
  function saveSettings(next: typeof settings, done: string) {
    setSettings(next);
    settingsQueue.current = settingsQueue.current.then(async () => {
      if (JSON.stringify(next) === JSON.stringify(savedSettings.current)) return;
      try {
        await twinClient.agents.update.mutate({ slug: id, name: twin.name, description: twin.description ?? "", settings: next });
        savedSettings.current = next;
        toast.success(done);
        refresh();
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
                onChange={(checked) => saveSettings({ ...settings, preScreenshare: checked }, `Screen share before the call turned ${checked ? "on" : "off"}`)}
                label="Enable screenshare before conversation start"
              />
            </div>

            <div className="flex items-center justify-between gap-4 py-3.5">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">Enable upload or Upload file configuration</span>
                <span className="text-xs text-muted-foreground">
                  Allow learners to add a file before the session starts. A PDF or an image (PNG, JPEG or WebP), up to 10 MB.
                </span>
              </div>
              <SwitchToggle
                checked={preUpload}
                onChange={(checked) => saveSettings({ ...settings, preUpload: checked }, `File upload before the call turned ${checked ? "on" : "off"}`)}
                label="Enable upload before conversation start"
              />
            </div>

            {preUpload ? (
              // The upload card's text: typed freely, saved together with Save (or Enter), Cancel puts the saved text back.
              <form
                className="flex flex-col gap-3 py-3.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (cardDirty) saveSettings({ ...settings, ...card }, "Upload card updated");
                }}
              >
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="upload-title" className="text-xs font-medium text-muted-foreground">
                    Upload title
                  </label>
                  <input
                    id="upload-title"
                    type="text"
                    maxLength={80}
                    value={card.uploadTitle}
                    placeholder={TWIN_UPLOAD_TITLE_DEFAULT}
                    onChange={(e) => setCard({ ...card, uploadTitle: e.target.value })}
                    className="h-9 rounded-lg border border-(--border) bg-card px-3 text-sm text-(--foreground) outline-none focus:border-(--brand) focus:ring-1 focus:ring-(--brand)"
                  />
                  <span className="text-xs text-muted-foreground">The heading of the upload card before the conversation. Empty shows “{TWIN_UPLOAD_TITLE_DEFAULT}”.</span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="upload-instruction" className="text-xs font-medium text-muted-foreground">
                    What to upload
                  </label>
                  <input
                    id="upload-instruction"
                    type="text"
                    maxLength={300}
                    value={card.uploadInstruction}
                    placeholder="e.g. Upload the property brochure you want to discuss."
                    onChange={(e) => setCard({ ...card, uploadInstruction: e.target.value })}
                    className="h-9 rounded-lg border border-(--border) bg-card px-3 text-sm text-(--foreground) outline-none focus:border-(--brand) focus:ring-1 focus:ring-(--brand)"
                  />
                  <span className="text-xs text-muted-foreground">Tells the learner which file to add. Leave empty to show no instruction. Uploading stays optional.</span>
                </div>
                <div className="flex items-center justify-end gap-2">
                  {cardDirty ? <span className="mr-auto text-xs text-muted-foreground">Unsaved changes</span> : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={!cardDirty}
                    onClick={() => setCard({ uploadTitle: settings.uploadTitle, uploadInstruction: settings.uploadInstruction })}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" size="sm" disabled={!cardDirty}>
                    Save
                  </Button>
                </div>
              </form>
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
                  Learners can share an image during the conversation, like a screenshot or a photo of a document.
                  Images only (PNG, JPEG or WebP), up to 10 MB.
                </span>
              </div>
              <SwitchToggle
                checked={duringUpload}
                onChange={(checked) => saveSettings({ ...settings, duringUpload: checked }, `Image upload during the call turned ${checked ? "on" : "off"}`)}
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
                <span className="flex shrink-0 flex-col items-end gap-0.5 text-xs text-muted-foreground tabular-nums">
                  {u.minutesUsed} of {u.minutes} min used
                  <AccessUntil until={u.until} />
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
