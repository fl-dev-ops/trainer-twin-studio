"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, Play, Plus } from "lucide-react";
import { toast } from "sonner";
import { SwitchToggle } from "@/components/switch-toggle";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UserAvatar } from "@/components/user-avatar";
import { TWIN_UPLOAD_TITLE_DEFAULT, type BeforeSettings } from "@/lib/context-upload";
import { roleplayClient } from "@/lib/roleplay/client";
import {
  DIFFICULTIES,
  MAX_EXAMPLE_LINES,
  MAX_GOALS,
  MAX_REACTIONS,
  MAX_RUBRIC_CRITERIA,
  type RoleplayBuilder,
  roleplayBuilderSchema,
} from "@/lib/roleplay/skill";
import type { RoleplayOutputs } from "@/lib/roleplay/trpc";
import { cn } from "@/lib/utils";
import { useRefresh } from "@/lib/use-refresh";
import { PageContainer } from "@/components/page-container";
import { Button } from "@/components/ui/button";
import type { ToolSettings } from "@/lib/agent-tools";
import { FormCard, SettingCard, SettingsPanel, SettingsSection } from "@/components/settings-cards";

type Persona = RoleplayOutputs["builder"]["personas"][number];
type Phase = "before" | "during" | "after" | "tools";

/** A new role play's rubric: the "Sales call" preset (20 points each, 100 in total). */
const SALES_RUBRIC = ["Rapport and tone", "Discovery questions", "Objection handling", "Value and data", "Next step booked"].map((name) => ({ name, points: 20 }));

const emptyBuilder = (persona = ""): RoleplayBuilder => ({
  name: "",
  persona,
  clientName: "",
  situation: { scenario: "", hiddenTruth: "", learnerRole: "", agreesWhen: "", declinesWhen: "" },
  difficulty: "medium",
  howTheyTalk: "",
  guardedIf: [],
  opensUpIf: [],
  whatToExpect: "",
  opening: "",
  exampleLines: [],
  learnerGoals: [],
  rubric: SALES_RUBRIC,
});

/** Which tab a field lives on, so a validation message opens the right one. */
const PHASE_OF: Record<string, Phase> = { learnerGoals: "after", rubric: "after" };

const input = "rounded-lg border border-(--border) bg-transparent px-3 text-sm text-(--foreground) outline-none focus:border-(--brand) focus:ring-1 focus:ring-(--brand)";

function Field({ id, label, hint, children }: { id?: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </label>
      {children}
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

/** A short editable list (reference role-goal-add): the lines, Remove, and an input + Add. */
function ListField({ id, items, onChange, max, placeholder, addLabel }: {
  id: string; items: string[]; onChange: (items: string[]) => void; max: number; placeholder: string; addLabel: string;
}) {
  const [draft, setDraft] = useState("");
  const full = items.length >= max;
  const add = () => {
    const text = draft.trim();
    if (!text || full) return;
    onChange([...items, text]);
    setDraft("");
  };
  return (
    <div className="flex flex-col gap-2">
      {items.length ? (
        <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
          {items.map((item, i) => (
            <li key={`${i}-${item}`} className="flex items-center justify-between gap-3 rounded-lg bg-(--sidebar) px-3 py-2 text-sm">
              <span className="min-w-0">{item}</span>
              <button type="button" onClick={() => onChange(items.filter((_, k) => k !== i))} className="shrink-0 rounded-full px-2 py-0.5 text-xs text-muted-foreground hover:bg-(--tone-control) hover:text-foreground">
                Remove
              </button>
            </li>
          ))}
        </ol>
      ) : null}
      <div className="flex gap-2">
        <input
          id={id}
          value={draft}
          disabled={full}
          maxLength={300}
          placeholder={full ? `${max} at most` : placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          className={cn(input, "h-9 min-w-0 flex-1 disabled:opacity-60")}
        />
        <Button variant="outline" onClick={add} disabled={full || !draft.trim()}>
          <Plus data-icon="inline-start" /> {addLabel}
        </Button>
      </div>
    </div>
  );
}

/** Pick the client (reference rolePersonaPicker): the org's personas with photo, first name and role. */
function PersonaPicker({ personas, value, onChange }: { personas: Persona[]; value: string; onChange: (slug: string) => void }) {
  if (!personas.length) {
    return (
      <p className="text-sm text-muted-foreground">
        No personas yet. <Link href="/personas/new" className="text-foreground underline underline-offset-4">Create one</Link> first.
      </p>
    );
  }
  return (
    <div role="radiogroup" aria-label="Client persona" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {personas.map((persona) => {
        const on = persona.slug === value;
        return (
          <button
            key={persona.slug}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(persona.slug)}
            className={cn(
              "flex items-center gap-3 rounded-tt-md border p-2.5 pr-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-(--brand)",
              on ? "border-(--brand) bg-(--brand)/8 ring-1 ring-(--brand)" : "border-(--border) hover:bg-(--sidebar)",
            )}
          >
            {/* The tick sits on the photo's corner, so its box must wrap the photo exactly. */}
            <span className="relative inline-flex shrink-0">
              <UserAvatar user={{ name: persona.name, image: persona.photoUrl }} size="xl" />
              {on ? (
                <span className="absolute -right-0.5 -bottom-0.5 grid size-4 place-items-center rounded-full bg-(--brand) text-white ring-2 ring-card">
                  <Check className="size-2.5" strokeWidth={3} />
                </span>
              ) : null}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium">{persona.name}</span>
              <span className="truncate text-xs text-muted-foreground">{persona.isOwn ? "You" : persona.role}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The Tools tab's switches (Agent.data.tools); the chat agent loads only what's on for a call. */
const TOOL_ROWS: { key: keyof ToolSettings; label: string; description: string }[] = [
  { key: "canvas", label: "Canvas", description: "A whiteboard the client can sketch on and read what the learner draws." },
  { key: "codeEditor", label: "Code editor", description: "An editor the client can open with code, read and run." },
  { key: "preview", label: "Preview", description: "Show and point at a PDF the learner attached." },
  { key: "choice", label: "Multiple choice", description: "A short question with options, checked when the learner picks one." },
];

/**
 * Role-play builder (reference pageRoleCreate): Scenario (the client and the call: rendered into SKILL.md + items),
 * Scoring (goals and rubric for the report), Settings (Before: what the learner shares with the client) and Tools (what the client can show the learner).
 *
 * Editing: Scenario and Scoring save with "Save role play" (a new version of the script); Settings and Tools save
 * as they change, like twin Configure (switches on flip, the upload card with its own Save). Creating: everything is
 * kept in the form and saved by "Create role play", on every tab.
 */
export function RoleplayBuilderPage({ slug, initial, before: initialBefore, tools: initialTools, personas }: {
  slug?: string;
  /** Absent for a new role play: an empty form on the first role-play persona. */
  initial?: RoleplayBuilder;
  before: BeforeSettings;
  /** The workspace surfaces the client may use on the call (all off for a new role play). */
  tools: ToolSettings;
  personas: Persona[];
}) {
  const router = useRouter();
  const refresh = useRefresh();
  const editing = Boolean(slug);
  const [b, setB] = useState<RoleplayBuilder>(() => initial ?? emptyBuilder(personas.find((p) => !p.isOwn)?.slug ?? personas[0]?.slug ?? ""));
  const [before, setBefore] = useState<BeforeSettings>(initialBefore);
  const [tools, setTools] = useState<ToolSettings>(initialTools);
  /** The upload card's text as typed (editing: saved with its own Save). */
  const [card, setCard] = useState({ uploadTitle: initialBefore.uploadTitle, uploadInstruction: initialBefore.uploadInstruction });
  const [tab, setTab] = useState<Phase>("during");
  const [saving, setSaving] = useState(false);
  const saved = useRef({ before: initialBefore, tools: initialTools });
  const settingsQueue = useRef(Promise.resolve());

  // The page first renders from cached data, then the fresh copy arrives: take its values where nothing was edited
  // (otherwise coming back after a change shows the old values).
  const [received, setReceived] = useState({ initial, before: initialBefore, tools: initialTools });
  if (received.initial !== initial || received.before !== initialBefore || received.tools !== initialTools) {
    setReceived({ initial, before: initialBefore, tools: initialTools });
    if (initial && JSON.stringify(b) === JSON.stringify(received.initial)) setB(initial);
    if (JSON.stringify(before) === JSON.stringify(received.before)) setBefore(initialBefore);
    if (JSON.stringify(tools) === JSON.stringify(received.tools)) setTools(initialTools);
    if (card.uploadTitle === received.before.uploadTitle && card.uploadInstruction === received.before.uploadInstruction) {
      setCard({ uploadTitle: initialBefore.uploadTitle, uploadInstruction: initialBefore.uploadInstruction });
    }
  }
  useEffect(() => {
    saved.current = { before: initialBefore, tools: initialTools };
  }, [initialBefore, initialTools]);

  const set = <K extends keyof RoleplayBuilder>(key: K, value: RoleplayBuilder[K]) => setB((prev) => ({ ...prev, [key]: value }));
  const setSituation = (key: keyof RoleplayBuilder["situation"], value: string) => setB((prev) => ({ ...prev, situation: { ...prev.situation, [key]: value } }));
  const rubricTotal = b.rubric.reduce((sum, row) => sum + (Number(row.points) || 0), 0);
  const cardDirty = card.uploadTitle !== before.uploadTitle || card.uploadInstruction !== before.uploadInstruction;

  /** Settings / Tools: the form keeps them while creating; editing saves each change in order, toasting `done`. */
  function saveSettings(patch: { before?: BeforeSettings; tools?: ToolSettings }, done: string) {
    if (patch.before) setBefore(patch.before);
    if (patch.tools) setTools(patch.tools);
    if (!slug) return;
    settingsQueue.current = settingsQueue.current.then(async () => {
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

  // Leaving the page (closing, reloading) with unsaved upload card text asks first.
  useEffect(() => {
    if (!editing || !cardDirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [editing, cardDirty]);

  async function save() {
    const parsed = roleplayBuilderSchema.safeParse(b);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setTab(PHASE_OF[String(issue?.path[0])] ?? "during");
      toast.error(issue?.message ?? "Check the role play");
      return;
    }
    setSaving(true);
    try {
      // Creating: the upload card's text is part of the form. Editing: Settings are already saved as it changed.
      const settings = editing ? saved.current.before : { ...before, ...card };
      const result = await roleplayClient.builder.save.mutate({ slug, builder: parsed.data, before: settings, tools: editing ? saved.current.tools : tools });
      toast.success(slug ? "Role play saved" : "Role play created");
      router.push(`/roleplay/${result.slug}`);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the role play");
    } finally {
      setSaving(false);
    }
  }

  const uploadFields = (
    <>
      <Field id="upload-title" label="Upload title" hint={`The heading of the upload card. Empty shows “${TWIN_UPLOAD_TITLE_DEFAULT}”.`}>
        <input id="upload-title" maxLength={80} value={card.uploadTitle} placeholder={TWIN_UPLOAD_TITLE_DEFAULT} onChange={(e) => setCard({ ...card, uploadTitle: e.target.value })} className={cn(input, "h-9 bg-card")} />
      </Field>
      <Field id="upload-instruction" label="What to upload" hint="Tells the learner which file to add. Leave empty to show no instruction.">
        <input id="upload-instruction" maxLength={300} value={card.uploadInstruction} placeholder="e.g. Add the brochure you'll pitch." onChange={(e) => setCard({ ...card, uploadInstruction: e.target.value })} className={cn(input, "h-9 bg-card")} />
      </Field>
      {editing ? (
        <div className="flex items-center justify-end gap-2">
          {cardDirty ? <span className="mr-auto text-xs text-muted-foreground">Unsaved changes</span> : null}
          <Button type="button" variant="ghost" size="sm" disabled={!cardDirty} onClick={() => setCard({ uploadTitle: before.uploadTitle, uploadInstruction: before.uploadInstruction })}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!cardDirty}>
            Save
          </Button>
        </div>
      ) : null}
    </>
  );
  const createNote = editing ? null : <p className="m-0 text-xs text-muted-foreground">Saved when you create the role play.</p>;

  return (
    <PageContainer>
      <header className="flex min-h-10 items-center justify-between gap-4">
        <Link href={slug ? `/roleplay/${slug}` : "/roleplay"} className="inline-flex items-center gap-2 text-sm text-(--foreground) transition-colors hover:text-muted-foreground">
          <ArrowLeft className="size-4" />
          <span>Back</span>
        </Link>
      </header>

      <div className="mt-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="m-0 text-title-m leading-7 font-semibold tracking-title">{slug ? "Edit role play" : "Build role play"}</h1>
          <p className="mt-1 text-sm text-muted-foreground">The call the learner practises, how they’re scored, and what they set up first.</p>
        </div>
        {slug ? (
          <Button variant="brand" nativeButton={false} render={<Link href={`/talk?agent=${encodeURIComponent(slug)}`} />}>
            <Play data-icon="inline-start" /> Try role play
          </Button>
        ) : null}
      </div>

      <Tabs value={tab} onValueChange={(value) => setTab(value as Phase)} className="mt-6 gap-4">
        <TabsList>
          {/* Build order: the call first, then how it's scored, then what the learner shares and the client's tools. */}
          <TabsTrigger value="during">Scenario</TabsTrigger>
          <TabsTrigger value="after">Scoring</TabsTrigger>
          <TabsTrigger value="before">Settings</TabsTrigger>
          <TabsTrigger value="tools">Tools</TabsTrigger>
        </TabsList>

        <TabsContent value="during" className="flex flex-col gap-4">
          <FormCard title="Basics" description="What the role play is called and how hard the client is.">
            <Field id="rp-name" label="Role play name">
              <input id="rp-name" maxLength={120} value={b.name} placeholder="Example: The wait-and-see investor" onChange={(e) => set("name", e.target.value)} className={cn(input, "h-10")} />
            </Field>
            <Field label="Difficulty">
              <div role="radiogroup" aria-label="Difficulty" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {DIFFICULTIES.map((d) => (
                  <button
                    key={d.value}
                    type="button"
                    role="radio"
                    aria-checked={b.difficulty === d.value}
                    onClick={() => set("difficulty", d.value)}
                    className={cn("rounded-lg border p-2.5 text-left transition-colors", b.difficulty === d.value ? "border-(--brand) bg-(--brand)/5" : "border-(--border) hover:bg-(--sidebar)")}
                  >
                    <span className="block text-sm font-medium">{d.label}</span>
                    <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{d.description}</span>
                  </button>
                ))}
              </div>
            </Field>
          </FormCard>

          <FormCard title="The client" description="The persona sets the voice, photo, background and how they talk. The two optional fields change them for this role play only.">
            <Field label="Persona">
              <PersonaPicker personas={personas} value={b.persona} onChange={(slug) => set("persona", slug)} />
            </Field>
            <Field id="rp-client" label="Client name on this call" hint="Optional. Replaces the persona's name; describe who they are in the situation below.">
              <input id="rp-client" maxLength={120} value={b.clientName ?? ""} onChange={(e) => set("clientName", e.target.value)} className={cn(input, "h-10")} />
            </Field>
            <Field id="rp-talk" label="How they talk on this call" hint="Optional. Replaces the persona's speaking style for this role play.">
              <textarea id="rp-talk" rows={2} maxLength={2000} value={b.howTheyTalk ?? ""} onChange={(e) => set("howTheyTalk", e.target.value)} className={cn(input, "py-2")} />
            </Field>
          </FormCard>

          <FormCard title="The learner" description="Who the learner plays, and what they read before the call.">
            <Field id="rp-learner" label="Learner role">
              <input id="rp-learner" maxLength={200} value={b.situation.learnerRole} placeholder="Example: Off-plan agent on a first call" onChange={(e) => setSituation("learnerRole", e.target.value)} className={cn(input, "h-10")} />
            </Field>
            <Field id="rp-brief" label="Learner brief" hint="Shown to the learner before the call: what to expect and what to aim for.">
              <textarea id="rp-brief" rows={3} maxLength={1000} value={b.whatToExpect ?? ""} placeholder="Example: Listen first, then ask one question at a time." onChange={(e) => set("whatToExpect", e.target.value)} className={cn(input, "py-2")} />
            </Field>
          </FormCard>

          <FormCard title="The situation" description="What the client is dealing with, and what they keep to themselves.">
            <Field id="rp-scenario" label="Scenario">
              <textarea id="rp-scenario" rows={6} maxLength={4000} value={b.situation.scenario} placeholder="Example: You are an off-plan buyer who wants to wait for prices to drop." onChange={(e) => setSituation("scenario", e.target.value)} className={cn(input, "py-2")} />
            </Field>
            <Field id="rp-hidden" label="What's really going on" hint="Hidden from the learner. The client reveals it only if the learner earns it.">
              <textarea id="rp-hidden" rows={4} maxLength={4000} value={b.situation.hiddenTruth ?? ""} placeholder="Example: You are scared of making a mistake with your family's savings." onChange={(e) => setSituation("hiddenTruth", e.target.value)} className={cn(input, "py-2")} />
            </Field>
          </FormCard>

          <FormCard title="The call" description="How the client opens, and lines that set their tone.">
            <Field id="rp-opening" label="Opening line" hint="The client's first words when they pick up.">
              <input id="rp-opening" maxLength={1000} value={b.opening} placeholder="Example: The market has basically stopped. I'll wait for prices to hit the bottom." onChange={(e) => set("opening", e.target.value)} className={cn(input, "h-10")} />
            </Field>
            <Field id="rp-lines" label="Example lines" hint="Things this client might say. The AI uses them for tone, never word for word. Optional.">
              <ListField id="rp-lines" items={b.exampleLines} onChange={(v) => set("exampleLines", v)} max={MAX_EXAMPLE_LINES} placeholder="Example: Honestly, I might just put it into gold." addLabel="Add line" />
            </Field>
          </FormCard>

          <FormCard title="Reactions" description="What makes the client close up or open up during the call.">
            <Field id="rp-guarded" label="Gets more guarded when the learner">
              <ListField id="rp-guarded" items={b.guardedIf} onChange={(v) => set("guardedIf", v)} max={MAX_REACTIONS} placeholder="Example: Uses fake urgency, like “last units”" addLabel="Add" />
            </Field>
            <Field id="rp-opens" label="Opens up when the learner">
              <ListField id="rp-opens" items={b.opensUpIf} onChange={(v) => set("opensUpIf", v)} max={MAX_REACTIONS} placeholder="Example: Asks why they started looking" addLabel="Add" />
            </Field>
          </FormCard>

          <FormCard title="How the call can end" description="The best outcome is a booked meeting or a dated follow-up, never a purchase.">
            <Field id="rp-agree" label="Agrees when">
              <textarea id="rp-agree" rows={2} maxLength={2000} value={b.situation.agreesWhen ?? ""} onChange={(e) => setSituation("agreesWhen", e.target.value)} className={cn(input, "py-2")} />
            </Field>
            <Field id="rp-decline" label="Declines when">
              <textarea id="rp-decline" rows={2} maxLength={2000} value={b.situation.declinesWhen ?? ""} onChange={(e) => setSituation("declinesWhen", e.target.value)} className={cn(input, "py-2")} />
            </Field>
          </FormCard>
        </TabsContent>

        <TabsContent value="after" className="flex flex-col gap-4">
          <FormCard title="Learner goals" description={`What the learner is scored on after the call. ${MAX_GOALS} at most. The client never sees these.`}>
            <ListField id="rp-goals" items={b.learnerGoals} onChange={(v) => set("learnerGoals", v)} max={MAX_GOALS} placeholder="Example: Hold the price objection without offering a discount" addLabel="Add goal" />
          </FormCard>
          <FormCard title="Scoring rubric" description={`Points per skill, ${MAX_RUBRIC_CRITERIA} at most. The report scores the learner out of the total.`}>
            <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
              {b.rubric.map((row, i) => (
                <li key={i} className="flex items-center gap-2 rounded-lg bg-(--sidebar) px-3 py-1.5 text-sm">
                  <input
                    aria-label="Score name"
                    maxLength={120}
                    value={row.name}
                    onChange={(e) => set("rubric", b.rubric.map((r, k) => (k === i ? { ...r, name: e.target.value } : r)))}
                    className="h-8 min-w-0 flex-1 bg-transparent outline-none"
                  />
                  <input
                    aria-label={`Points for ${row.name}`}
                    type="number"
                    min={1}
                    max={100}
                    value={row.points}
                    onChange={(e) => set("rubric", b.rubric.map((r, k) => (k === i ? { ...r, points: Math.round(Number(e.target.value)) || 0 } : r)))}
                    className={cn(input, "h-8 w-20 bg-card text-right tabular-nums")}
                  />
                  <button type="button" onClick={() => set("rubric", b.rubric.filter((_, k) => k !== i))} className="shrink-0 rounded-full px-2 py-0.5 text-xs text-muted-foreground hover:bg-(--tone-control) hover:text-foreground">
                    Remove
                  </button>
                </li>
              ))}
            </ol>
            <div className="flex items-center justify-between gap-3">
              <Button variant="outline" disabled={b.rubric.length >= MAX_RUBRIC_CRITERIA} onClick={() => set("rubric", [...b.rubric, { name: "New score", points: 10 }])}>
                <Plus data-icon="inline-start" /> Add score
              </Button>
              <span className="text-sm text-muted-foreground tabular-nums">
                Total <b className="text-foreground">{rubricTotal}</b> points
              </span>
            </div>
          </FormCard>
        </TabsContent>

        <TabsContent value="before" className="flex flex-col gap-4">
          {createNote}
          <SettingsPanel>
          <SettingsSection title="Before the call" description="Optional: what the learner shares or uploads before the client picks up.">
            <SettingCard
              title="Share screen"
              description="Learners share their entire screen for the whole call."
              control={<SwitchToggle checked={before.preScreenshare} onChange={(on) => saveSettings({ before: { ...before, preScreenshare: on } }, `Screen share turned ${on ? "on" : "off"}`)} label="Share screen" />}
            />
            <SettingCard
              title="Upload a file"
              description="Learners may add a file before the call starts. A PDF or an image (PNG, JPEG or WebP), up to 10 MB."
              control={<SwitchToggle checked={before.preUpload} onChange={(on) => saveSettings({ before: { ...before, preUpload: on } }, `File upload before the call turned ${on ? "on" : "off"}`)} label="Upload a file before the call" />}
            >
              {before.preUpload ? (
                // Editing: the card's text saves with its own Save (or Enter); creating: it's part of the form.
                <form
                  className="flex flex-col gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (editing && cardDirty) saveSettings({ before: { ...before, ...card } }, "Upload card updated");
                  }}
                >
                  {uploadFields}
                </form>
              ) : null}
            </SettingCard>
          </SettingsSection>
          <SettingsSection title="During the call">
            <SettingCard
              title="Attach during the call"
              description="Learners can share an image or a PDF while they talk to the client. An image (PNG, JPEG or WebP) up to 5 MB, or a PDF up to 10 MB."
              control={<SwitchToggle checked={before.duringUpload} onChange={(on) => saveSettings({ before: { ...before, duringUpload: on } }, `Image upload during the call turned ${on ? "on" : "off"}`)} label="Attach files during the call" />}
            />
          </SettingsSection>
          </SettingsPanel>
        </TabsContent>

        <TabsContent value="tools" className="flex flex-col gap-4">
          {createNote}
          <SettingsPanel>
          <SettingsSection title="Workspace tools" description="What the client can show on the learner's screen during the call. All off unless you switch them on.">
            {TOOL_ROWS.map((row) => (
              <SettingCard
                key={row.key}
                title={row.label}
                description={row.description}
                control={
                  <SwitchToggle
                    checked={tools[row.key]}
                    onChange={(on) => saveSettings({ tools: { ...tools, [row.key]: on } }, `${row.label} turned ${on ? "on" : "off"}`)}
                    label={row.label}
                  />
                }
              />
            ))}
          </SettingsSection>
          </SettingsPanel>
        </TabsContent>
      </Tabs>

      {/* Editing: Scenario and Scoring save with the role play; Settings and Tools save as they change. */}
      {!editing || tab === "during" || tab === "after" ? (
        <div className="mt-6 flex items-center justify-between gap-3">
          <Button variant="ghost" nativeButton={false} render={<Link href={slug ? `/roleplay/${slug}` : "/roleplay"} />}>
            Cancel
          </Button>
          <Button variant="brand" disabled={saving} onClick={() => void save()}>
            <Check data-icon="inline-start" />
            {saving ? "Saving…" : slug ? "Save role play" : "Create role play"}
          </Button>
        </div>
      ) : null}
    </PageContainer>
  );
}
