"use client";

import type { Route } from "next";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Play, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { CallLengthSelect, PersonaPicker, TOOL_ROWS } from "@/components/roleplay/roleplay-builder-page";
import { PageContainer } from "@/components/page-container";
import { UserAvatar } from "@/components/user-avatar";
import { PageSection, SECTION_CARD, SectionRow } from "@/components/page-section";
import { SwitchToggle } from "@/components/switch-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { ToolSettings } from "@/lib/agent-tools";
import type { BeforeSettings } from "@/lib/context-upload";
import { seedCopilot } from "@/lib/copilot-handoff";
import { encodeCopilotMessage } from "@/lib/copilot-message";
import { roleplayClient } from "@/lib/roleplay/client";
import type { RoleplayOutputs } from "@/lib/roleplay/trpc";
import { useRefresh } from "@/lib/use-refresh";
import { cn } from "@/lib/utils";
import { dashRoute } from "@/lib/routes";

type Brief = NonNullable<RoleplayOutputs["builder"]["get"]["brief"]>;
type Script = Brief["script"];
type Persona = RoleplayOutputs["builder"]["personas"][number];

const kicker = "m-0 text-xs font-semibold tracking-wide text-muted-foreground uppercase";

/** Opens the copilot on this role play, with the trainer's change request typed in. */
export function editWithCopilot(slug: string, title: string, change: string, go: (href: Route) => void) {
  seedCopilot(encodeCopilotMessage({ skill: "roleplay-creator", files: [], text: `Change the role play "${title}" (${slug}): ${change}` }));
  go(dashRoute("/"));
}

/** The script the copilot wrote, read-only: who plays whom, the situation, how it goes and how it ends. */
export function ScriptView({ script }: { script: Script }) {
  return (
    <div className="flex flex-col gap-6 text-sm leading-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className={kicker}>The AI plays</p>
          <p className="m-0 mt-1 font-medium">{script.aiRole}</p>
          <p className="m-0 mt-1 text-(--text-secondary)">Each persona as its character for this role play says.</p>
        </div>
        <div>
          <p className={kicker}>The learner plays</p>
          <p className="m-0 mt-1 font-medium">{script.learnerRole}</p>
          <p className="m-0 mt-1 text-(--text-secondary)">{script.learnerAim}</p>
        </div>
      </div>
      <div>
        <p className={kicker}>Situation</p>
        <ul className="m-0 mt-1 list-disc pl-5 text-(--text-secondary)">
          {script.situation.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </div>
      {script.steps.length ? <div>
        <p className={kicker}>How it goes</p>
        <ol className="m-0 mt-1 flex flex-col gap-2 pl-5">
          {script.steps.map((step) => (
            <li key={step.name}><span className="font-medium">{step.name}.</span> <span className="text-(--text-secondary)">{step.what}</span></li>
          ))}
        </ol>
      </div> : null}
      {script.ending.limit || script.ending.good ? (
        <div>
          <p className={kicker}>How it ends</p>
          <p className="m-0 mt-1 text-(--text-secondary)">{[script.ending.limit, script.ending.good].filter(Boolean).join(" ")}</p>
        </div>
      ) : null}
      {script.items ? <p className="m-0 text-xs text-muted-foreground">{script.items} example lines the AI can draw on during the call.</p> : null}
    </div>
  );
}

/**
 * Editing a role play the copilot wrote (lib/roleplay/brief.ts), kept as simple as the twin's edit page: General holds
 * the few things a trainer changes by hand; Script is read-only and changed by asking the copilot; Settings save as
 * they change.
 */
export function RoleplayBriefEditPage({ slug, brief, before: initialBefore, hasLegacyIntroVideo, tools: initialTools, personas, pool }: {
  slug: string;
  brief: Brief;
  before: BeforeSettings;
  hasLegacyIntroVideo: boolean;
  tools: ToolSettings;
  personas: Persona[];
  /** Personas available to play this role in new sessions. */
  pool: RoleplayOutputs["builder"]["personaPool"];
}) {
  const router = useRouter();
  const refresh = useRefresh();
  const initial = { title: brief.title, learnerBrief: brief.learnerBrief, limit: brief.limit };
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [change, setChange] = useState("");
  const [before, setBefore] = useState(initialBefore);
  const [introVideoDraft, setIntroVideoDraft] = useState<string>();
  const introVideo = introVideoDraft ?? before.introVideoUrl ?? "";
  const introVideoChanged = introVideo.trim() !== (before.introVideoUrl ?? "");
  const usesLegacyIntro = hasLegacyIntroVideo && before.introVideoUrl === undefined;
  const [tools, setTools] = useState(initialTools);
  const saved = useRef({ before: initialBefore, tools: initialTools });
  const queue = useRef(Promise.resolve());
  const set = (key: keyof typeof form, value: string) => setForm((prev) => ({ ...prev, [key]: value }));
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const canSave = !saving && dirty && Boolean(form.title.trim())
    && (brief.kind === "authored" || Boolean(form.learnerBrief.trim()));

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      await roleplayClient.builder.saveBrief.mutate({ slug, ...form });
      toast.success("Role play saved");
      refresh();
      router.push(dashRoute(`/roleplay/${slug}`));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the role play");
    } finally {
      setSaving(false);
    }
  }

  function saveSettings(patch: { before?: BeforeSettings; tools?: ToolSettings }, done: string) {
    if (patch.before) setBefore(patch.before);
    if (patch.tools) setTools(patch.tools);
    queue.current = queue.current.then(async () => {
      try {
        await roleplayClient.builder.saveSettings.mutate({ slug, ...patch });
        saved.current = { ...saved.current, ...patch };
        toast.success(done);
        refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not save");
        setBefore(saved.current.before);
        setTools(saved.current.tools);
      }
    });
  }

  return (
    <PageContainer>
      <header className="flex min-h-10 items-center justify-between gap-4">
        <Link href={dashRoute(`/roleplay/${slug}`)} className="inline-flex items-center gap-2 text-sm text-(--foreground) transition-colors hover:text-muted-foreground">
          <ArrowLeft className="size-4" />
          <span>Back</span>
        </Link>
      </header>

      <div className="mt-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="m-0 text-title-m leading-7 font-semibold tracking-title">Edit role play</h1>
          <p className="mt-1 text-sm text-muted-foreground">Change the basics here. Ask the copilot to change the script.</p>
        </div>
        <Button variant="secondary" nativeButton={false} render={<Link href={dashRoute(`/talk?agent=${encodeURIComponent(slug)}`)} />}>
          <Play data-icon="inline-start" /> Try it
        </Button>
      </div>

      <Tabs defaultValue="general" className="mt-6 min-w-0 gap-4">
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="persona">Persona</TabsTrigger>
          <TabsTrigger value="script">Script</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="general">
          <PageSection title="Role play details" description="Edit the name, learner brief, and any opening or timing details.">
            <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
              <fieldset disabled={saving} className={cn(SECTION_CARD, "m-0 min-w-0")}>
                <SectionRow title={<label htmlFor="rp-title">Name</label>}>
                  <Input id="rp-title" className="w-full sm:w-80" maxLength={120} value={form.title} onChange={(e) => set("title", e.target.value)} />
                </SectionRow>
                <SectionRow title={<label htmlFor="rp-brief">Learner brief</label>} className="sm:flex-col sm:items-stretch sm:gap-3"
                  detail={<span id="rp-brief-help">Shown to the learner before the call: who they are, the situation and what to aim for.</span>}>
                  <Textarea id="rp-brief" aria-describedby="rp-brief-help" rows={4} className="min-h-32" maxLength={1000} value={form.learnerBrief} onChange={(e) => set("learnerBrief", e.target.value)} />
                </SectionRow>
                {brief.kind === "brief" ? (
                  <SectionRow title={<label htmlFor="rp-limit">Time limit</label>} detail={<span id="rp-limit-help">Optional, e.g. “At most 5 minutes.”</span>}>
                    <Input id="rp-limit" aria-describedby="rp-limit-help" className="w-full sm:w-80" maxLength={200} value={form.limit} onChange={(e) => set("limit", e.target.value)} />
                  </SectionRow>
                ) : null}
              </fieldset>
              <div className="flex items-center justify-end gap-3">
                <Button variant="ghost" nativeButton={false} render={<Link href={dashRoute(`/roleplay/${slug}`)} />}>Cancel</Button>
                <Button variant="default" type="submit" disabled={!canSave}>
                  <Check data-icon="inline-start" /> {saving ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </form>
          </PageSection>
        </TabsContent>

        <TabsContent value="persona">
          <PersonaPool slug={slug} personas={personas} pool={pool} />
        </TabsContent>

        <TabsContent value="script">
          <div className="flex flex-col gap-10">
            <PageSection title="Change the script with the copilot" description="Describe what you want to change in the conversation.">
              <form className="flex flex-col gap-3" onSubmit={(event) => {
                event.preventDefault();
                if (change.trim()) editWithCopilot(slug, brief.title, change.trim(), router.push);
              }}>
                <div className={cn(SECTION_CARD, "px-5 py-4")}>
                  <Textarea aria-label="Change the script with the copilot" rows={2} value={change}
                    placeholder="e.g. Make the buyer push back harder on price, and end after 4 minutes."
                    onChange={(e) => setChange(e.target.value)} />
                </div>
                <div className="flex justify-end">
                  <Button type="submit" variant="default" disabled={!change.trim()}>
                    <Sparkles data-icon="inline-start" /> Ask the copilot
                  </Button>
                </div>
              </form>
            </PageSection>
            <PageSection title="Current script">
              <div className={cn(SECTION_CARD, "px-5 py-4")}>
                <ScriptView script={brief.script} />
              </div>
            </PageSection>
          </div>
        </TabsContent>

        <TabsContent value="settings">
          <div className="flex flex-col gap-10">
            <PageSection title="Before the conversation" description="Set up what learners see and share before the call. Switches save automatically.">
              <div className={SECTION_CARD}>
                <SectionRow
                  title={<label htmlFor="rp-intro-video">Intro video URL</label>}
                  detail={<span id="rp-intro-video-help">Use a direct HTTPS video link to a short clip that works for every persona.{usesLegacyIntro ? " The existing clip plays when the role play has one active persona." : " Leave blank for no intro."}</span>}
                  className="sm:flex-col sm:items-stretch sm:gap-3"
                >
                  <form className="flex w-full flex-wrap items-center gap-2" onSubmit={(event) => {
                    event.preventDefault();
                    if (!introVideoChanged) return;
                    const url = introVideo.trim();
                    saveSettings({ before: { ...before, introVideoUrl: url || null } }, url ? "Intro video saved" : "Intro video removed");
                    setIntroVideoDraft(undefined);
                  }}>
                    <Input id="rp-intro-video" type="url" aria-describedby="rp-intro-video-help" maxLength={2048} placeholder="https://…/intro.mp4" value={introVideo} onChange={(event) => setIntroVideoDraft(event.target.value)} className="flex-1" />
                    {usesLegacyIntro && !introVideoChanged ? (
                      <Button type="button" variant="ghost" onClick={() => saveSettings({ before: { ...before, introVideoUrl: null } }, "Intro video removed")}>
                        Remove existing intro
                      </Button>
                    ) : null}
                    <Button type="button" variant="ghost" disabled={!introVideoChanged} onClick={() => setIntroVideoDraft(undefined)}>Cancel</Button>
                    <Button type="submit" variant="secondary" disabled={!introVideoChanged}>Save video</Button>
                  </form>
                </SectionRow>
                <SectionRow title="Call length" detail="The call ends at this point, with the client's goodbye.">
                  <CallLengthSelect value={before.callMinutes} onChange={(minutes) => saveSettings({ before: { ...before, callMinutes: minutes } }, minutes ? `Calls now end at ${minutes} minutes` : "Call length limit removed")} />
                </SectionRow>
                <SectionRow title="Share screen" detail="Learners share their entire screen for the whole call.">
                  <SwitchToggle checked={before.preScreenshare} onChange={(on) => saveSettings({ before: { ...before, preScreenshare: on } }, `Screen share turned ${on ? "on" : "off"}`)} label="Share screen" />
                </SectionRow>
                <SectionRow title="Upload a file before the call" detail="Learners may add a PDF or an image, up to 10 MB.">
                  <SwitchToggle checked={before.preUpload} onChange={(on) => saveSettings({ before: { ...before, preUpload: on, preUploadRequired: on && before.preUploadRequired } }, `File upload before the call turned ${on ? "on" : "off"}`)} label="Upload a file before the call" />
                </SectionRow>
                {before.preUpload ? (
                  <SectionRow title="Required" detail="The call can't start until the learner adds the file.">
                    <SwitchToggle checked={before.preUploadRequired === true} onChange={(on) => saveSettings({ before: { ...before, preUploadRequired: on } }, on ? "The file is now required" : "The file is now optional")} label="File required" />
                  </SectionRow>
                ) : null}
              </div>
            </PageSection>
            <PageSection title="During the conversation" description="What learners can share while they talk.">
              <div className={SECTION_CARD}>
                <SectionRow title="Attach during the call" detail="Learners can share an image or a PDF while they talk.">
                  <SwitchToggle checked={before.duringUpload} onChange={(on) => saveSettings({ before: { ...before, duringUpload: on } }, `Attach during the call turned ${on ? "on" : "off"}`)} label="Attach files during the call" />
                </SectionRow>
              </div>
            </PageSection>
            <PageSection title="Workspace tools" description="What the AI can show on the learner's screen. All off unless you switch them on.">
              <div className={SECTION_CARD}>
                {TOOL_ROWS.map((row) => (
                  <SectionRow key={row.key} title={row.label} detail={row.description}>
                    <SwitchToggle checked={tools[row.key] === true} onChange={(on) => saveSettings({ tools: { ...tools, [row.key]: on } }, `${row.label} turned ${on ? "on" : "off"}`)} label={row.label} />
                  </SectionRow>
                ))}
              </div>
            </PageSection>
          </div>
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}

function PersonaPool({ slug, personas, pool }: { slug: string; personas: Persona[]; pool: RoleplayOutputs["builder"]["personaPool"] }) {
  const refresh = useRefresh();
  const [received, setReceived] = useState(pool);
  const [saved, setSaved] = useState(pool);
  const [draft, setDraft] = useState(pool);
  const [busy, setBusy] = useState(false);
  const dirty = draft.length !== saved.length || draft.some((slug) => !saved.includes(slug));
  if (received !== pool) {
    setReceived(pool);
    setSaved(pool);
    if (!dirty) setDraft(pool);
  }

  async function save() {
    setBusy(true);
    try {
      await roleplayClient.builder.setPersonaPool.mutate({ slug, personas: draft });
      setSaved(draft);
      toast.success("Personas saved");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the personas");
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageSection title="Who the learner talks to" description="Choose who can play this role. Each new session picks one of the selected personas at random.">
      <div className={cn(SECTION_CARD, "px-5 py-4")}>
        <PersonaPicker personas={personas} value={draft} disabled={busy} onChange={(slug) => setDraft((prev) =>
          prev.includes(slug) ? prev.filter((item) => item !== slug) : [...prev, slug],
        )} />
      </div>
      {dirty ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-sm text-muted-foreground" role="status">{draft.length ? "Unsaved changes" : "Select at least one persona."}</span>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => setDraft(saved)}>Cancel</Button>
          <Button type="button" variant="default" disabled={busy || !draft.length} onClick={() => void save()}>{busy ? "Saving…" : "Save personas"}</Button>
        </div>
      ) : null}
      <Characters slug={slug} reload={saved} />
    </PageSection>
  );
}

type Character = RoleplayOutputs["builder"]["characters"][number];

/** Each persona's character for this role play only: who they are on this call. Never shared with another role play. */
function Characters({ slug, reload }: { slug: string; reload: unknown }) {
  const [rows, setRows] = useState<Character[] | null>(null);
  useEffect(() => {
    let live = true;
    roleplayClient.builder.characters.query({ slug }).then((next) => { if (live) setRows(next); }).catch(() => { if (live) setRows([]); });
    return () => { live = false; };
  }, [slug, reload]);
  if (!rows?.length) return null;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="m-0 text-sm font-semibold">Characters</h3>
        <p className="m-0 text-sm text-muted-foreground">How each persona plays this role play: their facts, what they hide, how they talk and react, their opening line. Written for this role play only; other role plays never see it.</p>
      </div>
      {rows.map((row) => <CharacterEditor key={row.persona} slug={slug} row={row} onSaved={(character) => setRows((prev) => prev?.map((item) => item.persona === row.persona ? { ...item, character } : item) ?? prev)}  />)}
    </div>
  );
}

function CharacterEditor({ slug, row, onSaved }: { slug: string; row: Character; onSaved: (character: string) => void }) {
  const [saved, setSaved] = useState(row.character);
  const [draft, setDraft] = useState(row.character);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await roleplayClient.builder.setCharacter.mutate({ slug, persona: row.persona, character: draft });
      setSaved(draft);
      onSaved(draft);
      toast.success(`${row.name}'s character saved`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the character");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={cn(SECTION_CARD, "flex flex-col gap-3 px-5 py-4")}>
      <button type="button" className="flex items-center gap-3 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <UserAvatar user={{ name: row.name, image: row.photoUrl }} size="sm" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{row.name}{row.role ? <span className="text-muted-foreground"> · {row.role}</span> : null}</span>
          <span className="truncate text-xs text-muted-foreground">{saved.trim() ? "Character written" : "No character yet: not picked for sessions until it has one"}</span>
        </span>
        <span className="text-sm text-(--brand)">{open ? "Close" : saved.trim() ? "Edit" : "Write"}</span>
      </button>
      {open ? (
        <>
          <Textarea
            value={draft}
            disabled={busy}
            rows={12}
            className="font-mono text-sm"
            placeholder={`# ${row.name} on this call\n\n## Facts\n- Investor, budget AED 1.5–2M, looking at JVC\n\n## What you hide\n- Your budget, until asked directly\n\n## Opening line\n"${row.name} speaking."\n\n## Reactions\n- Open up when…\n- Get guarded when…`}
            onChange={(event) => setDraft(event.target.value)}
          />
          {draft !== saved ? (
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setDraft(saved)}>Cancel</Button>
              <Button type="button" variant="default" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save character"}</Button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
