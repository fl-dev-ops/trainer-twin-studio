"use client";

import { followEmailProgress } from "@/lib/follow-email-progress";
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
import { AssignDialog } from "@/components/assign-dialog";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/user-avatar";
import { useRefresh } from "@/lib/use-refresh";
import { PageContainer } from "@/components/page-container";
import { PageSection, SECTION_CARD, SectionRow } from "@/components/page-section";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AccessUntil } from "@/components/twin/access-until";
import { TWIN_UPLOAD_TITLE_DEFAULT } from "@/lib/context-upload";
import { PublicAccessPanel } from "@/components/twin/public-access-panel";

type LearnerAssign = TwinOutputs["assignments"]["list"][number];

/**
 * Copies the twin's /t/ share link. Same call and cache as the Share dialog; fetched on click, so viewing the page never
 * creates a link.
 */
function CopyShareLinkButton({ slug, publicEnabled = false }: { slug: string; publicEnabled?: boolean }) {
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
      toast.success(publicEnabled ? "Link copied. Signed-out visitors can start a short voice call." : "Link copied. Sign in with assigned learner access to talk.");
      setTimeout(() => setState("idle"), 2000);
    } catch {
      setState("idle");
      toast.error("Could not copy the share link. Try again.");
    }
  }
  return (
    <Button variant="outline" size="lg" onClick={() => void copy()} disabled={state === "busy"}>
      {state === "copied" ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
      {state === "copied" ? "Copied" : "Copy link"}
    </Button>
  );
}

export function TwinEditPage({
  twin,
  learners,
  defaultTab = "general",
}: {
  twin: Pick<TwinOutputs["agents"]["get"], "slug" | "name" | "description" | "settings" | "publicAccess" | "widget">;
  learners: LearnerAssign[];
  /** /edit opens on General, /assign on Learners. */
  defaultTab?: "general" | "conversation" | "learners";
}) {
  const id = twin.slug;
  const refresh = useRefresh();

  // General fields
  const [name, setName] = useState(twin.name);
  const [description, setDescription] = useState(twin.description ?? "");

  // Switch writes are serialized; upload text stays draft until Save.
  const [settings, setSettings] = useState(twin.settings);
  /** The upload card's text as typed; saved only with its Save button (switches save on their own). */
  const [card, setCard] = useState({ uploadTitle: settings.uploadTitle, uploadInstruction: settings.uploadInstruction });
  const cardDirty = card.uploadTitle !== settings.uploadTitle || card.uploadInstruction !== settings.uploadInstruction;
  const savedSettings = useRef(twin.settings);
  const settingsQueue = useRef(Promise.resolve());
  /** Switch saves still queued: a refresh that lands meanwhile carries older settings and mustn't undo a newer click. */
  const [pendingSaves, setPendingSaves] = useState(0);

  // The page first renders from cached data, then the fresh copy arrives: take its values when they differ from what
  // this page last received (otherwise coming back after a change shows the old values).
  const [received, setReceived] = useState(twin);
  if (received !== twin) {
    setReceived(twin);
    if (pendingSaves === 0 && JSON.stringify(twin.settings) !== JSON.stringify(received.settings)) {
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

  /** The dialog's Assign: new people get their starting minutes; already-active people are skipped server-side. */
  async function assignLearners(emails: string[], accessUntil: string | null, startingMinutes: number) {
    try {
      const result = await twinClient.assignments.assign.mutate({ slug: id, emails, accessUntil, startingMinutes });
      // Say what actually happened: assigned (and emailed), or already had access.
      const done = result.added + result.reactivated;
      const people = (n: number) => `${n} ${n === 1 ? "learner" : "learners"}`;
      if (done) toast.success(`${people(done)} assigned`);
      if (result.skipped) toast.info(`${people(result.skipped)} already had this twin`);
      if (result.emailProgress) void followEmailProgress(result.emailProgress, result.emailsQueued);
      else if (result.emailFailures) toast.warning(`${result.emailFailures} email(s) could not be sent.`);
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
    setPendingSaves((count) => count + 1);
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
    }).finally(() => setPendingSaves((count) => count - 1));
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
        <CopyShareLinkButton slug={id} publicEnabled={twin.publicAccess.enabled} />
      </div>

      <div className="mt-6 flex flex-col gap-4">
      <Tabs defaultValue={defaultTab} className="min-w-0 gap-4">
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="conversation">Conversation</TabsTrigger>
          <TabsTrigger value="public">Public access</TabsTrigger>
          <TabsTrigger value="learners">
            Learners
            <span className="text-muted-foreground tabular-nums">· {assigned.length}</span>
          </TabsTrigger>
        </TabsList>

      <TabsContent value="general">
        <PageSection title="Twin details" description="The name and description shown across your workspace.">
          <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void handleSave(); }}>
            <fieldset disabled={saving} className={cn(SECTION_CARD, "m-0 min-w-0")}>
              <SectionRow title={<label htmlFor="bot-name">Bot name</label>} detail="How the twin is named to learners and visitors.">
                <Input id="bot-name" className="w-full sm:w-80" value={name} onChange={(event) => setName(event.target.value)} />
              </SectionRow>
              <div className="flex flex-col gap-3 border-t border-(--border) px-5 py-4">
                <div>
                  <label htmlFor="bot-desc" className="text-sm font-medium">Description</label>
                  <p id="bot-desc-help" className="m-0 mt-0.5 text-sm text-muted-foreground">A short introduction to this twin.</p>
                </div>
                <Textarea id="bot-desc" rows={5} value={description} onChange={(event) => setDescription(event.target.value)}
                  aria-describedby="bot-desc-help" className="min-h-32" />
              </div>
            </fieldset>
            <div className="flex items-center justify-end gap-3">
              <Button variant="ghost" nativeButton={false} render={<Link href={`/twin/${id}`} />}>Cancel</Button>
              <Button variant="brand" type="submit" disabled={saving || !name.trim()}>
                {saved && <Check data-icon="inline-start" />}
                {saving ? "Saving…" : saved ? "Saved" : "Save changes"}
              </Button>
            </div>
          </form>
        </PageSection>
      </TabsContent>

      <TabsContent value="conversation">
        <div className="flex flex-col gap-10">
          <PageSection title="Before the conversation" description="What learners share before the call begins. Switches save automatically.">
            <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); if (cardDirty) saveSettings({ ...settings, ...card }, "Upload card updated"); }}>
              <div className={SECTION_CARD}>
                <SectionRow title="Share screen" detail="Learners share their entire screen when the conversation starts, so the twin can follow along.">
                  <SwitchToggle checked={preScreenshare}
                    onChange={(checked) => saveSettings({ ...settings, preScreenshare: checked }, `Screen share before the call turned ${checked ? "on" : "off"}`)}
                    label="Share screen before the conversation" />
                </SectionRow>
                <SectionRow title="Upload a file" detail="Learners may add a PDF or an image (PNG, JPEG or WebP), up to 10 MB. Uploading stays optional.">
                  <SwitchToggle checked={preUpload}
                    onChange={(checked) => saveSettings({ ...settings, preUpload: checked }, `File upload before the call turned ${checked ? "on" : "off"}`)}
                    label="Upload a file before the conversation" />
                </SectionRow>
                {preUpload ? (
                  <div className="flex flex-col gap-6 border-t border-(--border) p-5">
                      <div className="flex flex-col gap-2">
                        <label htmlFor="upload-title" className="text-sm font-medium">Upload title</label>
                        <Input id="upload-title" maxLength={80} value={card.uploadTitle} placeholder={TWIN_UPLOAD_TITLE_DEFAULT}
                          onChange={(event) => setCard({ ...card, uploadTitle: event.target.value })} />
                        <p className="m-0 text-sm text-muted-foreground">The heading shown before the conversation. Empty shows “{TWIN_UPLOAD_TITLE_DEFAULT}”.</p>
                      </div>
                      <div className="flex flex-col gap-2">
                        <label htmlFor="upload-instruction" className="text-sm font-medium">What to upload</label>
                        <Input id="upload-instruction" maxLength={300} value={card.uploadInstruction}
                          placeholder="e.g. Upload the property brochure."
                          onChange={(event) => setCard({ ...card, uploadInstruction: event.target.value })} />
                        <p className="m-0 text-sm text-muted-foreground">Tell learners which file to add. Leave empty for no instruction.</p>
                      </div>
                  </div>
                ) : null}
              </div>
              {preUpload ? (
                <div className="flex items-center justify-end gap-2">
                  {cardDirty ? <span className="mr-auto text-sm text-muted-foreground">Unsaved changes</span> : null}
                  <Button type="button" variant="ghost" disabled={!cardDirty}
                    onClick={() => setCard({ uploadTitle: settings.uploadTitle, uploadInstruction: settings.uploadInstruction })}>Cancel</Button>
                  <Button type="submit" disabled={!cardDirty}>Save</Button>
                </div>
              ) : null}
            </form>
          </PageSection>
          <PageSection title="During the conversation" description="What learners can do while they talk to the twin.">
            <div className={SECTION_CARD}>
              <SectionRow title="Attach during the call" detail="Share an image (PNG, JPEG or WebP) up to 5 MB, or a PDF up to 10 MB, during the conversation.">
                <SwitchToggle checked={duringUpload}
                  onChange={(checked) => saveSettings({ ...settings, duringUpload: checked }, `Image upload during the call turned ${checked ? "on" : "off"}`)}
                  label="Attach a file during the conversation" />
              </SectionRow>
            </div>
          </PageSection>
        </div>
      </TabsContent>

      <TabsContent value="public">
        <PublicAccessPanel twin={twin} />
      </TabsContent>
      <TabsContent value="learners">
      <div id="assign">
        <PageSection title="Learners" description={`${assigned.length} assigned. Credits are each learner’s own, shared across twins and role plays.`}
          action={<Button variant="brand" onClick={() => setAssignOpen(true)}><UserPlus data-icon="inline-start" /> Assign learners</Button>}>
        {assigned.length ? (
          <ul className={cn(SECTION_CARD, "m-0 list-none overflow-hidden p-0")}>
            {assigned.map((u) => (
              <li key={u.email} className="border-t border-(--border) first:border-t-0">
                <SectionRow title={<span className="flex min-w-0 items-center gap-3">
                  <UserAvatar user={u} size="md" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-semibold">{u.name}</span>
                    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      {u.name !== u.email ? <span className="truncate">{u.email}</span> : null}
                    </span>
                  </span>
                </span>}>
                  <span className="flex shrink-0 flex-col items-end gap-0.5 text-xs text-muted-foreground tabular-nums">
                    {u.minutesUsed} of {u.minutes} min used (all practice)
                    <AccessUntil until={u.until} />
                  </span>
                </SectionRow>
              </li>
            ))}
          </ul>
        ) : (
          <div className={cn(SECTION_CARD, "px-5 py-6 text-center text-sm text-muted-foreground")}>Nobody is assigned yet.</div>
        )}
        </PageSection>
        <AssignDialog
          variant="twin"
          open={assignOpen}
          onOpenChange={setAssignOpen}
          title={twin.name}
          assignedCount={assigned.length}
          people={assignable}
          onAssign={assignLearners}
        />
      </div>
      </TabsContent>
      </Tabs>

      </div>
    </PageContainer>
  );
}
