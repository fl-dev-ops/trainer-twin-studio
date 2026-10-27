"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { ArrowLeft, Check, Play, Plus } from "lucide-react";
import { toast } from "sonner";
import { SwitchToggle } from "@/components/switch-toggle";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UserAvatar } from "@/components/user-avatar";
import type { BeforeSettings } from "@/lib/context-upload";
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

type Persona = RoleplayOutputs["builder"]["personas"][number];
type Phase = "before" | "during" | "after";

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

const card = "flex flex-col gap-6 rounded-[16px] border border-(--card-border) bg-card p-6 shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]";
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

function Section({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 border-t border-(--border) pt-6 first:border-t-0 first:pt-0">
      <div>
        <h2 className="m-0 text-sm font-semibold tracking-wide text-(--foreground) uppercase">{title}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
      </div>
      {children}
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
        <button type="button" onClick={add} disabled={full || !draft.trim()} className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-(--border) px-3.5 text-sm hover:bg-(--tone-control) disabled:opacity-50">
          <Plus className="size-4" /> {addLabel}
        </button>
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
    <div role="radiogroup" aria-label="Client persona" className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
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
              "flex flex-col items-center gap-1.5 rounded-[12px] border p-3 text-center transition-colors outline-none focus-visible:ring-2 focus-visible:ring-(--brand)",
              on ? "border-(--brand) bg-(--brand)/5" : "border-(--border) hover:bg-(--sidebar)",
            )}
          >
            <span className="relative">
              <UserAvatar user={{ name: persona.name, image: persona.photoUrl }} className="size-14 text-lg" />
              {on ? (
                <span className="absolute -right-1 -bottom-1 grid size-5 place-items-center rounded-full bg-(--brand) text-white">
                  <Check className="size-3" />
                </span>
              ) : null}
            </span>
            <span className="w-full truncate text-sm font-medium">{persona.name.split(" ")[0]}</span>
            <span className="w-full truncate text-xs text-muted-foreground">{persona.isOwn ? "You" : persona.role}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Role-play builder (reference pageRoleCreate) in three phases: Before (what the learner brings), During (the client
 * and the call: rendered into SKILL.md + items.json) and After (goals and rubric for the report).
 */
export function RoleplayBuilderPage({ slug, initial, before: initialBefore, personas }: {
  slug?: string;
  /** Absent for a new role play: an empty form on the first role-play persona. */
  initial?: RoleplayBuilder;
  before: BeforeSettings;
  personas: Persona[];
}) {
  const router = useRouter();
  const [b, setB] = useState<RoleplayBuilder>(() => initial ?? emptyBuilder(personas.find((p) => !p.isOwn)?.slug ?? personas[0]?.slug ?? ""));
  const [before, setBefore] = useState<BeforeSettings>(initialBefore);
  const [tab, setTab] = useState<Phase>("during");
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof RoleplayBuilder>(key: K, value: RoleplayBuilder[K]) => setB((prev) => ({ ...prev, [key]: value }));
  const setSituation = (key: keyof RoleplayBuilder["situation"], value: string) => setB((prev) => ({ ...prev, situation: { ...prev.situation, [key]: value } }));
  const setBeforeKey = <K extends keyof BeforeSettings>(key: K, value: BeforeSettings[K]) => setBefore((prev) => ({ ...prev, [key]: value }));
  const rubricTotal = b.rubric.reduce((sum, row) => sum + (Number(row.points) || 0), 0);

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
      const saved = await roleplayClient.builder.save.mutate({ slug, builder: parsed.data, before });
      toast.success(slug ? "Role play saved" : "Role play created");
      router.push(`/roleplay/${saved.slug}`);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the role play");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] px-4 pt-5 pb-16 md:px-0">
        <header className="flex min-h-10 items-center justify-between gap-4">
          <Link href={slug ? `/roleplay/${slug}` : "/roleplay"} className="inline-flex items-center gap-2 text-sm text-(--foreground) transition-colors hover:text-muted-foreground">
            <ArrowLeft className="size-4" />
            <span>Back</span>
          </Link>
        </header>

        <div className="mt-6">
          <h1 className="m-0 text-[20px] leading-7 font-semibold tracking-[-0.015em]">{slug ? "Edit role play" : "Build role play"}</h1>
          <p className="mt-1 text-sm text-muted-foreground">Before the call, the call itself, and how the learner is scored after it.</p>
        </div>

        <Tabs value={tab} onValueChange={(value) => setTab(value as Phase)} className="mt-6 gap-4">
          <TabsList>
            <TabsTrigger value="before">Before</TabsTrigger>
            <TabsTrigger value="during">During</TabsTrigger>
            <TabsTrigger value="after">After</TabsTrigger>
          </TabsList>

          <TabsContent value="before">
            <article className={card}>
              <Section title="Before the call" sub="What the learner brings before the client picks up.">
                <div className="flex flex-col divide-y divide-(--border) rounded-[12px] border border-(--border) bg-(--sidebar) px-4">
                  <div className="flex items-center justify-between gap-4 py-3.5">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium">Share screen</span>
                      <span className="text-xs text-muted-foreground">Learners share their entire screen for the whole call.</span>
                    </div>
                    <SwitchToggle checked={before.preScreenshare} onChange={(v) => setBeforeKey("preScreenshare", v)} label="Share screen" />
                  </div>
                  <div className="flex items-center justify-between gap-4 py-3.5">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium">Upload a file</span>
                      <span className="text-xs text-muted-foreground">Learners may add a document before the call starts.</span>
                    </div>
                    <SwitchToggle checked={before.preUpload} onChange={(v) => setBeforeKey("preUpload", v)} label="Upload a file before the call" />
                  </div>
                  {before.preUpload ? (
                    <div className="flex flex-col gap-3 py-3.5">
                      <Field id="upload-title" label="Upload title">
                        <input id="upload-title" maxLength={80} value={before.uploadTitle} placeholder="e.g. Listing brochure" onChange={(e) => setBeforeKey("uploadTitle", e.target.value)} className={cn(input, "h-9 bg-card")} />
                      </Field>
                      <Field id="upload-instruction" label="What to upload">
                        <input id="upload-instruction" maxLength={300} value={before.uploadInstruction} placeholder="e.g. Add the brochure you'll pitch." onChange={(e) => setBeforeKey("uploadInstruction", e.target.value)} className={cn(input, "h-9 bg-card")} />
                      </Field>
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between gap-4 py-3.5">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium">Attach during the call</span>
                      <span className="text-xs text-muted-foreground">Learners can add a file while they talk to the client.</span>
                    </div>
                    <SwitchToggle checked={before.duringUpload} onChange={(v) => setBeforeKey("duringUpload", v)} label="Attach files during the call" />
                  </div>
                </div>
              </Section>
              <Field id="rp-brief" label="Learner brief" hint="Shown to the learner before the call: what to expect and what to aim for.">
                <textarea id="rp-brief" rows={3} maxLength={1000} value={b.whatToExpect ?? ""} placeholder="Example: Listen first, then ask one question at a time." onChange={(e) => set("whatToExpect", e.target.value)} className={cn(input, "py-2")} />
              </Field>
            </article>
          </TabsContent>

          <TabsContent value="during">
            <article className={card}>
              <Section title="The client" sub="Who the learner talks to. The persona sets the voice, photo and how they talk.">
                <Field id="rp-name" label="Role play name">
                  <input id="rp-name" maxLength={120} value={b.name} placeholder="Example: The wait-and-see investor" onChange={(e) => set("name", e.target.value)} className={cn(input, "h-10")} />
                </Field>
                <Field label="Persona">
                  <PersonaPicker personas={personas} value={b.persona} onChange={(slug) => set("persona", slug)} />
                </Field>
                <Field id="rp-client" label="Client name on this call" hint="Optional. Leave empty to use the persona's name.">
                  <input id="rp-client" maxLength={120} value={b.clientName ?? ""} onChange={(e) => set("clientName", e.target.value)} className={cn(input, "h-10")} />
                </Field>
                <Field id="rp-talk" label="How they talk on this call" hint="Optional. Only when it differs from the persona.">
                  <textarea id="rp-talk" rows={2} maxLength={2000} value={b.howTheyTalk ?? ""} onChange={(e) => set("howTheyTalk", e.target.value)} className={cn(input, "py-2")} />
                </Field>
              </Section>

              <Section title="The call" sub="The situation the client is in, and what the learner plays.">
                <Field id="rp-scenario" label="Scenario">
                  <textarea id="rp-scenario" rows={6} maxLength={4000} value={b.situation.scenario} placeholder="Example: You are an off-plan buyer who wants to wait for prices to drop." onChange={(e) => setSituation("scenario", e.target.value)} className={cn(input, "py-2")} />
                </Field>
                <Field id="rp-hidden" label="What's really going on" hint="Hidden from the learner. The client reveals it only if the learner earns it.">
                  <textarea id="rp-hidden" rows={4} maxLength={4000} value={b.situation.hiddenTruth ?? ""} placeholder="Example: You are scared of making a mistake with your family's savings." onChange={(e) => setSituation("hiddenTruth", e.target.value)} className={cn(input, "py-2")} />
                </Field>
                <Field id="rp-learner" label="Learner role">
                  <input id="rp-learner" maxLength={200} value={b.situation.learnerRole} placeholder="Example: Off-plan agent on a first call" onChange={(e) => setSituation("learnerRole", e.target.value)} className={cn(input, "h-10")} />
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
                        className={cn("rounded-[10px] border p-2.5 text-left transition-colors", b.difficulty === d.value ? "border-(--brand) bg-(--brand)/5" : "border-(--border) hover:bg-(--sidebar)")}
                      >
                        <span className="block text-sm font-medium">{d.label}</span>
                        <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{d.description}</span>
                      </button>
                    ))}
                  </div>
                </Field>
                <Field id="rp-opening" label="Opening line" hint="The client's first words when they pick up.">
                  <input id="rp-opening" maxLength={1000} value={b.opening} placeholder="Example: The market has basically stopped. I'll wait for prices to hit the bottom." onChange={(e) => set("opening", e.target.value)} className={cn(input, "h-10")} />
                </Field>
              </Section>

              <Section title="Reactions" sub="What makes the client close up or open up during the call.">
                <Field id="rp-guarded" label="Gets more guarded when the learner">
                  <ListField id="rp-guarded" items={b.guardedIf} onChange={(v) => set("guardedIf", v)} max={MAX_REACTIONS} placeholder="Example: Uses fake urgency, like “last units”" addLabel="Add" />
                </Field>
                <Field id="rp-opens" label="Opens up when the learner">
                  <ListField id="rp-opens" items={b.opensUpIf} onChange={(v) => set("opensUpIf", v)} max={MAX_REACTIONS} placeholder="Example: Asks why they started looking" addLabel="Add" />
                </Field>
              </Section>

              <Section title="How the call can end" sub="The best outcome is a booked meeting or a dated follow-up, never a purchase.">
                <Field id="rp-agree" label="Agrees when">
                  <textarea id="rp-agree" rows={2} maxLength={2000} value={b.situation.agreesWhen ?? ""} onChange={(e) => setSituation("agreesWhen", e.target.value)} className={cn(input, "py-2")} />
                </Field>
                <Field id="rp-decline" label="Declines when">
                  <textarea id="rp-decline" rows={2} maxLength={2000} value={b.situation.declinesWhen ?? ""} onChange={(e) => setSituation("declinesWhen", e.target.value)} className={cn(input, "py-2")} />
                </Field>
              </Section>

              <Section title="Example lines" sub="Things this client might say. The AI uses them for tone, never word for word. Optional.">
                <ListField id="rp-lines" items={b.exampleLines} onChange={(v) => set("exampleLines", v)} max={MAX_EXAMPLE_LINES} placeholder="Example: Honestly, I might just put it into gold." addLabel="Add line" />
              </Section>
            </article>
          </TabsContent>

          <TabsContent value="after">
            <article className={card}>
              <Section title="Learner goals" sub={`What the learner is scored on after the call. ${MAX_GOALS} at most. The client never sees these.`}>
                <ListField id="rp-goals" items={b.learnerGoals} onChange={(v) => set("learnerGoals", v)} max={MAX_GOALS} placeholder="Example: Hold the price objection without offering a discount" addLabel="Add goal" />
              </Section>
              <Section title="Scoring rubric" sub={`Points per skill, ${MAX_RUBRIC_CRITERIA} at most. The report scores the learner out of the total.`}>
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
                  <button
                    type="button"
                    disabled={b.rubric.length >= MAX_RUBRIC_CRITERIA}
                    onClick={() => set("rubric", [...b.rubric, { name: "New score", points: 10 }])}
                    className="inline-flex h-9 items-center gap-1.5 rounded-full border border-(--border) px-3.5 text-sm hover:bg-(--tone-control) disabled:opacity-50"
                  >
                    <Plus className="size-4" /> Add score
                  </button>
                  <span className="text-sm text-muted-foreground tabular-nums">
                    Total <b className="text-foreground">{rubricTotal}</b> points
                  </span>
                </div>
              </Section>
            </article>
          </TabsContent>
        </Tabs>

        <div className="mt-6 flex items-center justify-between gap-3">
          <Link href={slug ? `/roleplay/${slug}` : "/roleplay"} className="inline-flex h-10 items-center rounded-full px-4 text-sm hover:bg-(--tone-control)">
            Cancel
          </Link>
          <div className="flex items-center gap-2">
            {slug ? (
              <Link href={`/talk?agent=${encodeURIComponent(slug)}`} className="inline-flex h-10 items-center gap-2 rounded-full border border-(--border) px-4 text-sm hover:bg-(--tone-control)">
                <Play className="size-4" /> Try role play
              </Link>
            ) : null}
            <button
              type="button"
              disabled={saving}
              onClick={() => void save()}
              className="inline-flex h-10 items-center gap-2 rounded-full bg-(--brand) px-5 text-sm font-medium text-white transition-colors hover:bg-[#e04d00] disabled:opacity-60"
            >
              <Check className="size-4" />
              {saving ? "Saving…" : slug ? "Save role play" : "Create role play"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
