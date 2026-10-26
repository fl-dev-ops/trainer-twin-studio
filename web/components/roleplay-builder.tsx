"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowUp, Check, ChevronDown, Mic, Pencil, Plus, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  CHARACTER_ROLES,
  MAX_LEARNER_GOALS,
  MAX_RUBRIC_CRITERIA,
  rubricPreset,
  type ClientPersonaCard,
  type Difficulty,
  type RoleplayInput,
  type RubricCriterion,
} from "@/lib/roleplay";
import { cn } from "@/lib/utils";

const GENERIC_SAVE_ERROR = "Failed to save the change, try again in a few seconds";

const GOAL_TIPS = [
  "Tie each goal to a call the agent already loses.",
  "Make it something you can hear on the recording.",
  "One behaviour, not a personality trait.",
  "Hard enough to practise, not so hard they freeze.",
];

const SUGGESTIONS = [
  { label: "Cold call", text: "A cold call to a landlord who didn’t expect it and wants to know who gave out their number. The agent has to stay brief, say why they’re calling, and earn a few more minutes." },
  { label: "The wait-and-see investor", text: "A London investor who put Dubai on hold and says he’ll buy when prices hit bottom. The agent has to take the concern seriously, find out why he started looking, and leave with a dated follow-up." },
  { label: "The options-collector who ghosts", text: "A first-time buyer who asks for “some options”, collects brochures and goes quiet. The agent has to find out what matters most and earn one clear next step." },
];

// How the client reacts when the trainer has not written their own lists (V4 defaults).
const DEFAULT_GUARDED = [
  "Agrees with their fear or sounds worried too",
  "Argues, lectures with statistics or uses hype",
  "Uses fake urgency or pitches before asking about them",
  "Asks two or three questions at once, or sounds like a script",
];
const DEFAULT_OPENS = [
  "Acknowledges the concern calmly without arguing",
  "Asks what is really holding them back, or why now",
  "Offers real data to judge for themselves, with no pressure to buy",
  "Gives an easy way out of the call",
];
const DEFAULT_AGREES = "Agrees to a short Zoom or a dated follow-up once the agent has lowered their guard.";
const DEFAULT_DECLINES = "Politely ends the call if the agent pressures, argues or pitches. Never agrees to buy on this call.";

type CharacterRole = RoleplayInput["agent"]["characterRole"];

/** A first line in the client's voice when none was written (V4 wording per character). */
function openingFor(character: CharacterRole, scenario: string): string {
  const line = (scenario.split("\n").map((part) => part.trim()).find(Boolean) ?? "").split(/(?<=[.!?])\s/)[0] ?? "";
  const lines: Record<string, string> = {
    "Warm & Open": "I’m glad you called. Where should we start?",
    "Warm but Cautious": "Thanks for calling. I’m interested, but I’m not deciding today.",
    "Curious & Probing": "Before we go on, what do you want me to understand first?",
    "Skeptical & Reserved": "I’ll be honest, I don’t see why I should move on this.",
    "Direct & Challenging": "Let’s keep this short. What changes if I say yes today?",
  };
  return lines[character] ?? (line ? `Hi. ${line}` : "Hi. What’s this call about?");
}

export type RoleplayBuilderProps = {
  slug: string;
  initial: Partial<RoleplayInput> | null;
  clientPersonas: ClientPersonaCard[];
  publishedVersion?: number;
  revision?: number;
};

/** One-page role-play builder (V4): assistant prompt, then every field in one collapsible card. */
export function RoleplayBuilder({ slug, initial, clientPersonas, publishedVersion, revision }: RoleplayBuilderProps) {
  const router = useRouter();
  const existing = Boolean(publishedVersion || revision);
  const [name, setName] = useState(initial?.name ?? "");
  const [persona, setPersona] = useState(initial?.persona ?? clientPersonas[0]?.slug ?? "");
  const [scenario, setScenario] = useState(initial?.situation?.scenario ?? "");
  const [hiddenTruth, setHiddenTruth] = useState(initial?.situation?.hiddenTruth ?? "");
  const [learnerRole, setLearnerRole] = useState(initial?.situation?.learnerRole ?? "");
  const [goals, setGoals] = useState<string[]>(initial?.learnerGoals ?? []);
  const [goalDraft, setGoalDraft] = useState("");
  const [agreesWhen, setAgreesWhen] = useState(initial?.situation?.agreesWhen ?? DEFAULT_AGREES);
  const [declinesWhen, setDeclinesWhen] = useState(initial?.situation?.declinesWhen ?? DEFAULT_DECLINES);
  const [rubric, setRubric] = useState<RubricCriterion[]>(initial?.rubric ?? rubricPreset("sales"));
  const [rubricName, setRubricName] = useState("");
  const [rubricPoints, setRubricPoints] = useState("");
  const [opening, setOpening] = useState(initial?.opening ?? "");
  const [open, setOpen] = useState(existing || Boolean(initial?.situation?.scenario));
  const [ask, setAsk] = useState("");
  const [busy, setBusy] = useState<"save" | "try" | "ask" | "scenario" | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const touch = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    setDirty(true);
  };

  const selected = clientPersonas.find((card) => card.slug === persona);
  const rubricTotal = rubric.reduce((sum, row) => sum + (Number.isFinite(row.points) ? row.points : 0), 0);

  async function draftFromAsk(text: string) {
    if (!text.trim() || busy) return;
    setBusy("ask");
    try {
      const response = await fetch("/api/roleplay/assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "draft", prompt: text.trim() }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.draft) throw new Error(result?.error ?? "Could not draft that right now");
      const draft = result.draft as {
        name: string; personaSlug: string; scenario: string; hiddenTruth: string; learnerRole: string;
        learnerGoals: string[]; agreesWhen: string; declinesWhen: string; rubric: RubricCriterion[]; opening: string;
      };
      setName(draft.name);
      if (draft.personaSlug) setPersona(draft.personaSlug);
      setScenario(draft.scenario);
      setHiddenTruth(draft.hiddenTruth);
      setLearnerRole(draft.learnerRole);
      setGoals(draft.learnerGoals);
      setAgreesWhen(draft.agreesWhen);
      setDeclinesWhen(draft.declinesWhen);
      if (draft.rubric.length) setRubric(draft.rubric);
      setOpening(draft.opening);
      setOpen(true);
      setDirty(true);
      toast.success("Drafted. Review it below, then create and publish.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not draft that right now");
    } finally {
      setBusy(null);
    }
  }

  async function generateScenario() {
    setBusy("scenario");
    try {
      const response = await fetch("/api/roleplay/assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "scenario", persona: persona || undefined }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || typeof result?.scenario !== "string") throw new Error(result?.error ?? "Could not write a scenario right now");
      touch(setScenario)(result.scenario);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not write a scenario right now");
    } finally {
      setBusy(null);
    }
  }

  function addGoal() {
    const value = goalDraft.trim();
    if (!value || goals.length >= MAX_LEARNER_GOALS || goals.includes(value)) return;
    touch(setGoals)([...goals, value]);
    setGoalDraft("");
  }

  function addScore() {
    const label = rubricName.trim();
    if (!label) {
      toast.error("Name the score first.");
      return;
    }
    if (rubric.length >= MAX_RUBRIC_CRITERIA) return;
    const points = Math.min(100, Math.max(1, Math.round(Number(rubricPoints) || 10)));
    touch(setRubric)([...rubric, { name: label, points }]);
    setRubricName("");
    setRubricPoints("");
  }

  const missing = [
    !name.trim() && "a role play name",
    !persona && "a persona",
    !scenario.trim() && "the scenario",
    !learnerRole.trim() && "the learner role",
    !goals.length && "at least one learner goal",
    !rubric.length && "at least one rubric score",
  ].filter(Boolean) as string[];

  /** Saves and publishes; the client's character, difficulty and way of talking come from the persona. */
  async function save(mode: "save" | "try") {
    if (missing.length) {
      setOpen(true);
      toast.error(`Add ${missing.join(", ")}.`);
      return;
    }
    if (busy) return;
    setBusy(mode);
    const characterRole = (selected?.behaviours.find((item) => (CHARACTER_ROLES as readonly string[]).includes(item))
      ?? initial?.agent?.characterRole ?? "Warm but Cautious") as CharacterRole;
    const difficulty: Difficulty = selected?.difficulty ?? initial?.agent?.difficulty ?? "medium";
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(slug)}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "roleplay",
          name: name.trim(),
          persona,
          clientName: selected?.name,
          voiceId: selected?.voiceId,
          situation: {
            scenario: scenario.trim(),
            hiddenTruth: hiddenTruth.trim() || undefined,
            learnerRole: learnerRole.trim(),
            agreesWhen: agreesWhen.trim() || undefined,
            declinesWhen: declinesWhen.trim() || undefined,
          },
          learnerGoals: goals,
          agent: {
            characterRole,
            difficulty,
            howTheyTalk: selected?.howTheyTalk ?? initial?.agent?.howTheyTalk,
            guardedIf: initial?.agent?.guardedIf?.length ? initial.agent.guardedIf : DEFAULT_GUARDED,
            opensUpIf: initial?.agent?.opensUpIf?.length ? initial.agent.opensUpIf : DEFAULT_OPENS,
          },
          opening: opening.trim() || openingFor(characterRole, scenario),
          rubric: rubric.map((row) => ({ name: row.name.trim(), points: row.points })),
          publish: true,
        }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error ?? GENERIC_SAVE_ERROR);
      setDirty(false);
      if (mode === "try") {
        router.push(`/talk?agent=${encodeURIComponent(slug)}`);
        return;
      }
      toast.success(existing ? "Roleplay updated." : "Roleplay published.");
      router.push("/agents");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : GENERIC_SAVE_ERROR);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-5 pt-5 sm:px-8">
          <Link href="/agents" className="inline-flex items-center gap-2 text-sm hover:underline">
            <ArrowLeft className="size-4" /> Build roleplay
          </Link>
        </div>

        <div className="mx-auto flex max-w-[720px] flex-col gap-4 px-4 pt-10 pb-12">
          {existing ? null : (
            <AssistCard ask={ask} onAsk={setAsk} busy={busy === "ask"}
              onSubmit={() => draftFromAsk(ask)} onSuggest={(text) => { setAsk(text); void draftFromAsk(text); }} />
          )}

          <section className="rounded-2xl border bg-card shadow-xs">
            <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="roleplay-fields"
              className="flex w-full items-center justify-between gap-4 px-6 py-6 text-left">
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-lg font-semibold">{name.trim() || "New roleplay"}</span>
                <span className="text-sm text-muted-foreground">Persona, scenario, learner role and goals</span>
              </span>
              <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
            </button>

            {open ? (
              <div id="roleplay-fields" className="flex flex-col gap-3 px-6 pb-6">
                <Label htmlFor="rp-name">Roleplay name</Label>
                <Input id="rp-name" className="h-11 rounded-xl" placeholder="Example: The wait-and-see investor" autoComplete="off"
                  value={name} onChange={(event) => touch(setName)(event.target.value)} />

                <Label>Pick a persona</Label>
                {clientPersonas.length ? (
                  <div className="flex flex-wrap gap-3" role="radiogroup" aria-label="Persona">
                    {clientPersonas.map((card) => {
                      const on = card.slug === persona;
                      return (
                        <div key={card.slug} className="flex w-24 flex-col items-center gap-0.5 text-center">
                          <button type="button" role="radio" aria-checked={on} aria-label={`Pick ${card.name}`}
                            onClick={() => touch(setPersona)(card.slug)}
                            className={cn("relative block size-24 overflow-hidden rounded-xl ring-offset-2 ring-offset-card", on && "ring-2 ring-primary")}>
                            {card.avatar ? (
                              // eslint-disable-next-line @next/next/no-img-element -- persona photos are static or uploaded URLs
                              <img src={card.avatar} alt="" className="size-full object-cover" />
                            ) : (
                              <span className="grid size-full place-items-center bg-muted text-2xl font-semibold">{card.name.charAt(0)}</span>
                            )}
                            {on ? (
                              <span className="absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-full bg-primary text-primary-foreground">
                                <Check className="size-3" />
                              </span>
                            ) : null}
                          </button>
                          <span className="mt-1 flex items-center gap-0.5">
                            <span className="text-sm font-medium">{card.name.split(" ")[0]}</span>
                            {/* The persona editor opens in its own tab so the role play being built stays where it is. */}
                            <a href={`/personas/${encodeURIComponent(card.slug)}`} target="_blank" rel="noreferrer"
                              aria-label={`Edit ${card.name}`} title="Edit persona"
                              className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
                              <Pencil className="size-3" />
                            </a>
                          </span>
                          <span className="text-xs text-muted-foreground">{card.role}</span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No personas yet. <Link href="/personas/new" className="underline">Create a persona</Link> first.
                  </p>
                )}

                <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                  <label htmlFor="rp-scenario" className="text-[15px] font-semibold">Scenario</label>
                  <button type="button" onClick={generateScenario} disabled={busy === "scenario"}
                    className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-60">
                    {busy === "scenario" ? <Spinner /> : <Sparkles className="size-4" />} Generate from recent activity
                  </button>
                </div>
                <TextArea id="rp-scenario" rows={4} value={scenario} onChange={touch(setScenario)}
                  placeholder="Example: You are an off-plan buyer who wants to wait for prices to drop." />

                <Label htmlFor="rp-hidden">What’s really going on</Label>
                <TextArea id="rp-hidden" rows={3} value={hiddenTruth} onChange={touch(setHiddenTruth)}
                  placeholder="Example: You are not scared of the market. You are scared of making a mistake with your family’s savings." />
                <Hint>Hidden from the agent. The persona only reveals it if the agent earns it.</Hint>

                <Label htmlFor="rp-learner">Learner role</Label>
                <Input id="rp-learner" className="h-11 rounded-xl" placeholder="Example: Off-plan agent on a first call"
                  value={learnerRole} onChange={(event) => touch(setLearnerRole)(event.target.value)} />

                <Label>Learner goals</Label>
                <details className="rounded-xl bg-muted/70 px-3 py-2.5 text-sm">
                  <summary className="cursor-pointer select-none">Tips to create good learner goals</summary>
                  <ol className="mt-2 list-decimal pl-5 text-sm leading-6 text-muted-foreground">
                    {GOAL_TIPS.map((tip) => <li key={tip}>{tip}</li>)}
                  </ol>
                </details>
                {goals.length ? (
                  <ol className="flex flex-col">
                    {goals.map((goal, index) => (
                      <li key={`${index}:${goal}`} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                        <span className="min-w-0">{goal}</span>
                        <Button variant="ghost" size="sm" className="font-semibold"
                          onClick={() => touch(setGoals)(goals.filter((_, i) => i !== index))}>Remove</Button>
                      </li>
                    ))}
                  </ol>
                ) : null}
                <Input aria-label="Learner goal" className="h-11 rounded-xl" placeholder="Example: Hold the price objection without offering a discount"
                  value={goalDraft} disabled={goals.length >= MAX_LEARNER_GOALS} onChange={(event) => setGoalDraft(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addGoal(); } }} />
                <Button variant="outline" className="h-10 w-fit rounded-full" onClick={addGoal} disabled={goals.length >= MAX_LEARNER_GOALS}>
                  <Plus data-icon="inline-start" /> Add goal
                </Button>
                <Hint>Agents are scored on these. Five at most.</Hint>

                <Label>How the call can end</Label>
                <label htmlFor="rp-agrees" className="text-sm text-muted-foreground">Agrees when</label>
                <TextArea id="rp-agrees" rows={2} value={agreesWhen} onChange={touch(setAgreesWhen)} />
                <label htmlFor="rp-declines" className="text-sm text-muted-foreground">Declines when</label>
                <TextArea id="rp-declines" rows={2} value={declinesWhen} onChange={touch(setDeclinesWhen)} />
                <Hint>The best outcome is a booked meeting or a dated follow-up, never a purchase.</Hint>

                <Label>Scoring rubric</Label>
                <ol className="flex flex-col">
                  {rubric.map((row, index) => (
                    <li key={`${index}:${row.name}`} className="flex items-center gap-3 py-1.5 text-sm">
                      <span className="min-w-0 flex-1">{row.name}</span>
                      <span className="flex items-center gap-2 text-muted-foreground">
                        <Input type="number" min={1} max={100} inputMode="numeric" aria-label={`Points for ${row.name}`}
                          className="h-9 w-16 rounded-lg text-center tabular-nums" value={Number.isFinite(row.points) ? row.points : ""}
                          onChange={(event) => touch(setRubric)(rubric.map((item, i) => (i === index ? { ...item, points: Math.round(Number(event.target.value)) } : item)))}
                          onBlur={() => touch(setRubric)(rubric.map((item, i) => (i === index ? { ...item, points: Math.min(100, Math.max(1, Math.round(item.points) || 1)) } : item)))} />
                        pts
                      </span>
                      <Button variant="ghost" size="sm" className="font-semibold"
                        onClick={() => touch(setRubric)(rubric.filter((_, i) => i !== index))}>Remove</Button>
                    </li>
                  ))}
                </ol>
                <div className="flex flex-wrap gap-2">
                  <Input aria-label="Score name" className="h-11 min-w-0 flex-1 rounded-xl" placeholder="Example: Handles the price objection"
                    autoComplete="off" value={rubricName} disabled={rubric.length >= MAX_RUBRIC_CRITERIA}
                    onChange={(event) => setRubricName(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addScore(); } }} />
                  <Input aria-label="Points" type="number" min={1} max={100} inputMode="numeric" className="h-11 w-24 rounded-xl" placeholder="Points"
                    value={rubricPoints} disabled={rubric.length >= MAX_RUBRIC_CRITERIA} onChange={(event) => setRubricPoints(event.target.value)} />
                  <Button variant="outline" className="h-11 rounded-full" onClick={addScore} disabled={rubric.length >= MAX_RUBRIC_CRITERIA}>
                    <Plus data-icon="inline-start" /> Add score
                  </Button>
                </div>
                <Hint>Agents are scored out of <span className="tabular-nums">{rubricTotal}</span> points across these. Eight at most.</Hint>
              </div>
            ) : null}
          </section>
        </div>
      </div>

      <footer className="shrink-0 border-t bg-background">
        <div className="mx-auto flex max-w-[720px] items-center justify-between gap-3 px-4 py-3">
          <Button variant="ghost" nativeButton={false} render={<Link href="/agents" />}>Cancel</Button>
          <div className="flex items-center gap-2">
            <Button variant="outline" className="h-10 rounded-full px-4" onClick={() => save("try")} disabled={busy !== null}>
              {busy === "try" ? <Spinner data-icon="inline-start" /> : <Sparkles data-icon="inline-start" />} Try roleplay
            </Button>
            <Button className="h-10 rounded-full px-5" onClick={() => save("save")} disabled={busy !== null}>
              {busy === "save" ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
              {existing ? "Save roleplay" : "Create and publish"}
            </Button>
          </div>
        </div>
      </footer>
    </div>
  );
}

/** "What type of roleplay to build": suggestion chips and a free-text ask that fills the form. */
function AssistCard({ ask, onAsk, busy, onSubmit, onSuggest }: {
  ask: string;
  onAsk: (value: string) => void;
  busy: boolean;
  onSubmit: () => void;
  onSuggest: (text: string) => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [listening, setListening] = useState(false);

  function dictate() {
    type Recognition = { lang: string; interimResults: boolean; onresult: (event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void; onend: () => void; start: () => void; stop: () => void };
    const Ctor = (window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }).SpeechRecognition
      ?? (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition;
    if (!Ctor) {
      toast.error("Voice input is not available in this browser. Type the situation instead.");
      return;
    }
    const recognition = new Ctor();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.onresult = (event) => onAsk(`${ask ? `${ask} ` : ""}${Array.from(event.results).map((result) => result[0].transcript).join(" ")}`.trim());
    recognition.onend = () => setListening(false);
    setListening(true);
    recognition.start();
  }

  return (
    <section aria-label="Describe the role play" className="rounded-2xl bg-muted/70 p-6">
      <p className="text-[15px] font-semibold">What type of roleplay to build</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {SUGGESTIONS.map((item) => (
          <button key={item.label} type="button" onClick={() => onSuggest(item.text)} disabled={busy}
            aria-pressed={ask === item.text}
            className="inline-flex items-center gap-1.5 rounded-full bg-card px-3 py-1.5 text-sm shadow-xs hover:bg-card/80 disabled:opacity-60">
            <Sparkles className="size-3.5" /> {item.label}
          </button>
        ))}
      </div>
      <form className="mt-5 rounded-xl bg-card p-3 shadow-sm" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
        <label htmlFor="tee-ask" className="sr-only">Tell me what is the situation</label>
        <textarea ref={input} id="tee-ask" rows={2} value={ask} onChange={(event) => onAsk(event.target.value)}
          placeholder="Tell me what is the situation"
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSubmit(); } }}
          className="w-full resize-none bg-transparent px-1 text-sm leading-6 outline-none placeholder:text-muted-foreground" />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={dictate} aria-pressed={listening} aria-label={listening ? "Listening" : "Speak the situation"}
            className={cn("grid size-9 place-items-center rounded-full bg-muted text-muted-foreground hover:text-foreground", listening && "text-primary")}>
            <Mic className="size-4" />
          </button>
          <button type="submit" disabled={busy || !ask.trim()} aria-label="Draft the role play"
            className="grid size-9 place-items-center rounded-full bg-primary text-primary-foreground disabled:opacity-60">
            {busy ? <Spinner /> : <ArrowUp className="size-4" />}
          </button>
        </div>
      </form>
    </section>
  );
}

function Label({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return htmlFor
    ? <label htmlFor={htmlFor} className="mt-4 text-[15px] font-semibold">{children}</label>
    : <h3 className="mt-4 text-[15px] font-semibold">{children}</h3>;
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function TextArea({ id, value, onChange, rows, placeholder }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  rows: number;
  placeholder?: string;
}) {
  return (
    <textarea id={id} value={value} rows={rows} placeholder={placeholder} onChange={(event) => onChange(event.target.value)}
      className="w-full resize-y rounded-xl border bg-background px-3 py-2.5 text-sm leading-6 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" />
  );
}
