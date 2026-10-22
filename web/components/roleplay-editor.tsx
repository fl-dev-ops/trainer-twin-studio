"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, Check, Phone, Plus, Save, Upload } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  CHARACTER_ROLES,
  DIFFICULTIES,
  MAX_LEARNER_GOALS,
  type ClientPersonaCard,
  type Difficulty,
  type RoleplayInput,
} from "@/lib/roleplay";

const GENERIC_SAVE_ERROR = "Failed to save the change, try again in a few seconds";

const GOAL_TIPS = [
  "Tie each goal to a call the agent already loses.",
  "Make it something you can hear on the recording.",
  "One behaviour, not a personality trait.",
  "Hard enough to practise, not so hard they freeze.",
];

type VoiceOption = { id: string; name: string; status: string };
type Step = "situation" | "agent";
type CharacterRole = RoleplayInput["agent"]["characterRole"];

export type RoleplayEditorProps = {
  slug: string;
  initial: Partial<RoleplayInput> | null;
  clientPersonas: ClientPersonaCard[];
  publishedVersion?: number;
  revision?: number;
  typeSwitch: ReactNode;
  onSaved?: () => void;
};

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

export function RoleplayEditor({ slug, initial, clientPersonas, publishedVersion: initialPublished, revision: initialRevision, typeSwitch, onSaved }: RoleplayEditorProps) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("situation");
  const [name, setName] = useState(initial?.name ?? "");
  const [scenario, setScenario] = useState(initial?.situation?.scenario ?? "");
  const [hiddenTruth, setHiddenTruth] = useState(initial?.situation?.hiddenTruth ?? "");
  const [learnerRole, setLearnerRole] = useState(initial?.situation?.learnerRole ?? "");
  const [goals, setGoals] = useState<string[]>(initial?.learnerGoals ?? []);
  const [agreesWhen, setAgreesWhen] = useState(initial?.situation?.agreesWhen ?? "");
  const [declinesWhen, setDeclinesWhen] = useState(initial?.situation?.declinesWhen ?? "");
  const [persona, setPersona] = useState(initial?.persona ?? "");
  const [clientName, setClientName] = useState(initial?.clientName ?? "");
  const [voiceId, setVoiceId] = useState(initial?.voiceId ?? "");
  const [characterRole, setCharacterRole] = useState<CharacterRole>(initial?.agent?.characterRole ?? "Warm but Cautious");
  const [difficulty, setDifficulty] = useState<Difficulty>(initial?.agent?.difficulty ?? "medium");
  const [howTheyTalk, setHowTheyTalk] = useState(initial?.agent?.howTheyTalk ?? "");
  const [guardedIf, setGuardedIf] = useState<string[]>(initial?.agent?.guardedIf ?? []);
  const [opensUpIf, setOpensUpIf] = useState<string[]>(initial?.agent?.opensUpIf ?? []);
  const [opening, setOpening] = useState(initial?.opening ?? "");
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [publishedVersion, setPublishedVersion] = useState(initialPublished);
  const [revision, setRevision] = useState(initialRevision);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  const touch = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    setDirty(true);
  };

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    fetch("/api/tts/voices")
      .then((r) => r.json())
      .then((d) => setVoices((d.voices ?? []).filter((voice: VoiceOption) => voice.status === "ready")))
      .catch(() => setVoices([]));
  }, []);

  const selected = clientPersonas.find((card) => card.slug === persona);
  const displayName = clientName.trim() || selected?.name || "the client";
  const difficultyInfo = DIFFICULTIES.find((level) => level.value === difficulty) ?? DIFFICULTIES[1];
  const whatToExpect = useMemo(() => {
    if (!scenario.trim()) return "";
    return `${scenario.trim()} ${firstName(displayName)} will come across as ${characterRole.toLowerCase().replace("&", "and")}. Difficulty is ${difficulty}. Listen first, then ask one question at a time.`;
  }, [scenario, displayName, characterRole, difficulty]);

  const missing = [
    !name.trim() && "a scenario name",
    !scenario.trim() && "the scenario",
    !learnerRole.trim() && "the learner role",
    !goals.length && "at least one learner goal",
    !persona && "who the learner speaks with",
    !opening.trim() && "the opening message",
  ].filter(Boolean) as string[];
  const ready = missing.length === 0;
  const saved = Boolean(publishedVersion || revision);

  function choosePersona(card: ClientPersonaCard) {
    const previous = selected;
    setPersona(card.slug);
    if (!clientName.trim() || clientName === previous?.name) setClientName(card.name);
    if (!voiceId || voiceId === previous?.voiceId) setVoiceId(card.voiceId ?? "");
    if (!howTheyTalk.trim() && card.howTheyTalk) setHowTheyTalk(card.howTheyTalk);
    const recommended = card.behaviours.find((behaviour) => (CHARACTER_ROLES as readonly string[]).includes(behaviour));
    if (recommended && !initial?.agent?.characterRole) setCharacterRole(recommended as CharacterRole);
    setDirty(true);
  }

  async function save(publish: boolean) {
    if (!ready || busy) {
      if (!ready) toast.error(`Add ${missing.join(", ")}.`);
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(slug)}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "roleplay",
          name: name.trim(),
          persona,
          clientName: clientName.trim() || undefined,
          voiceId: voiceId || undefined,
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
            howTheyTalk: howTheyTalk.trim() || undefined,
            guardedIf,
            opensUpIf,
            whatToExpect: whatToExpect || undefined,
          },
          opening: opening.trim(),
          publish,
        }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error ?? GENERIC_SAVE_ERROR);
      if (publish) {
        setPublishedVersion(result.agentVersion ?? publishedVersion);
        setRevision(undefined);
        toast.success(`Published v${result.agentVersion ?? ""}`.trim());
      } else {
        setRevision(result.revision ?? revision);
        toast.success(`Saved as draft r${result.revision ?? ""}`.trim());
      }
      setDirty(false);
      onSaved?.();
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : GENERIC_SAVE_ERROR);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-3 sm:flex-nowrap sm:px-6">
        <Button
          variant="ghost"
          size="icon-sm"
          render={<Link href={saved ? `/agents/${encodeURIComponent(slug)}` : "/agents"} />}
          nativeButton={false}
          aria-label="Back to scenarios"
        >
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-sm font-semibold">{name || slug}</h1>
            <Badge variant={publishedVersion ? "secondary" : "outline"}>
              {publishedVersion ? `Published v${publishedVersion}` : "New scenario"}
              {revision ? ` · draft r${revision}` : ""}
            </Badge>
            {dirty && <Badge variant="outline">Unsaved</Badge>}
          </div>
          <p className="truncate text-xs text-muted-foreground">{slug}</p>
        </div>
        <div className="order-last flex w-full flex-wrap items-center justify-end gap-2 sm:order-none sm:w-auto sm:shrink-0">
          <Button
            variant="outline"
            size="sm"
            disabled={!saved || dirty}
            title={!saved || dirty ? "Save the role play first" : undefined}
            render={saved && !dirty ? <Link href={`/agents/${encodeURIComponent(slug)}`} /> : undefined}
            nativeButton={!(saved && !dirty)}
          >
            <Phone data-icon="inline-start" /> Try role play
          </Button>
          <Button variant="outline" size="sm" onClick={() => save(false)} disabled={busy}>
            {busy ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
            Save draft
          </Button>
          <Button size="sm" onClick={() => save(true)} disabled={busy}>
            {busy ? <Spinner data-icon="inline-start" /> : <Upload data-icon="inline-start" />}
            Publish
          </Button>
        </div>
      </header>

      {typeSwitch}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-6xl gap-6 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <section className="min-w-0">
            <div className="mb-4 flex justify-center">
              <div role="tablist" aria-label="Role play steps" className="inline-flex rounded-full bg-sunken p-1">
                {(["situation", "agent"] as const).map((value) => (
                  <button
                    key={value}
                    role="tab"
                    type="button"
                    aria-selected={step === value}
                    onClick={() => setStep(value)}
                    className={cn(
                      "rounded-full px-4 py-1.5 text-sm leading-5 font-medium transition-colors",
                      step === value ? "bg-card text-foreground shadow-elevation-1" : "text-text-secondary hover:text-foreground",
                    )}
                  >
                    {value === "situation" ? "Situation" : "Role play agent"}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border bg-card p-5 shadow-xs sm:p-7">
              {step === "situation" ? (
                <div className="flex flex-col gap-6">
                  <div>
                    <h2 className="text-lg font-semibold">Role play situations</h2>
                    <p className="text-sm text-muted-foreground">Scenario, learner role and learner goals</p>
                  </div>

                  <Field>
                    <FieldLabel htmlFor="rp-name">Scenario name</FieldLabel>
                    <Input id="rp-name" value={name} placeholder="e.g. The wait-and-see investor" onChange={(e) => touch(setName)(e.target.value)} />
                    <FieldDescription className="text-xs">Shown wherever this role play is available.</FieldDescription>
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="rp-scenario">Scenario</FieldLabel>
                    <TextArea id="rp-scenario" value={scenario} rows={4} onChange={touch(setScenario)}
                      placeholder="Who the client is, what happened before this call, and what they say on the surface." />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="rp-hidden">What&apos;s really going on</FieldLabel>
                    <TextArea id="rp-hidden" value={hiddenTruth} rows={4} onChange={touch(setHiddenTruth)}
                      placeholder="The real fear or motive behind the objection." />
                    <FieldDescription className="text-xs">Hidden from the agent. The persona only reveals it if the agent earns it.</FieldDescription>
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="rp-learner-role">Learner role</FieldLabel>
                    <Input id="rp-learner-role" value={learnerRole} placeholder="e.g. Agent calling a wait-and-see investor"
                      onChange={(e) => touch(setLearnerRole)(e.target.value)} />
                  </Field>

                  <div className="flex flex-col gap-3">
                    <p className="text-sm font-medium">Learner goals</p>
                    <details className="rounded-xl bg-muted/60 px-4 py-3 text-sm">
                      <summary className="cursor-pointer select-none">Tips to create good learner goals</summary>
                      <ol className="mt-2 list-decimal pl-5 text-xs leading-5 text-muted-foreground">
                        {GOAL_TIPS.map((tip) => <li key={tip}>{tip}</li>)}
                      </ol>
                    </details>
                    <EditableList
                      items={goals}
                      onChange={touch(setGoals)}
                      max={MAX_LEARNER_GOALS}
                      placeholder="Example: Hold the price objection without offering a discount"
                      addLabel="Add goal"
                      ariaLabel="Learner goal"
                    />
                    <p className="text-xs text-muted-foreground">Agents are scored on these. Five at most.</p>
                  </div>

                  <div className="flex flex-col gap-4">
                    <p className="text-sm font-medium">How the call can end</p>
                    <Field>
                      <FieldLabel htmlFor="rp-agrees" className="text-xs font-normal text-muted-foreground">Agrees when</FieldLabel>
                      <TextArea id="rp-agrees" value={agreesWhen} rows={2} onChange={touch(setAgreesWhen)}
                        placeholder="e.g. Agrees to a short Zoom once the agent has lowered their guard." />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="rp-declines" className="text-xs font-normal text-muted-foreground">Declines when</FieldLabel>
                      <TextArea id="rp-declines" value={declinesWhen} rows={2} onChange={touch(setDeclinesWhen)}
                        placeholder="e.g. Politely ends the call if the agent pressures, argues or pitches." />
                    </Field>
                    <p className="text-xs text-muted-foreground">The best outcome is a booked meeting or a dated follow-up, never a purchase.</p>
                  </div>

                  <div className="flex justify-end">
                    <Button onClick={() => setStep("agent")}>Next</Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-7">
                  <h2 className="text-2xl font-semibold">Role play agent</h2>

                  <section className="flex flex-col gap-3">
                    <h3 className="text-sm font-medium">1. Choose who you&apos;ll speak with</h3>
                    {clientPersonas.length ? (
                      <div className="flex flex-wrap gap-3">
                        {clientPersonas.map((card) => {
                          const active = card.slug === persona;
                          return (
                            <button
                              key={card.slug}
                              type="button"
                              onClick={() => choosePersona(card)}
                              aria-pressed={active}
                              className="group flex w-24 flex-col items-center gap-1 text-center"
                            >
                              <span className={cn(
                                "relative block size-24 overflow-hidden rounded-xl border-2 bg-muted transition-colors",
                                active ? "border-primary" : "border-transparent group-hover:border-foreground/20",
                              )}>
                                {card.avatar ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img src={card.avatar} alt="" className="size-full object-cover" />
                                ) : (
                                  <span className="grid size-full place-items-center text-2xl font-semibold text-muted-foreground">{card.name[0]}</span>
                                )}
                                {active && (
                                  <span className="absolute top-1 right-1 grid size-5 place-items-center rounded-full bg-primary text-primary-foreground">
                                    <Check className="size-3" />
                                  </span>
                                )}
                              </span>
                              <span className="text-sm font-medium">{firstName(card.name)}</span>
                              <span className="text-xs text-muted-foreground">{card.role}</span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                        No client personas are available in this workspace yet.
                      </p>
                    )}
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field>
                        <FieldLabel htmlFor="rp-client-name" className="text-xs">Name on the call</FieldLabel>
                        <Input id="rp-client-name" value={clientName} placeholder={selected?.name ?? "Client name"}
                          onChange={(e) => touch(setClientName)(e.target.value)} />
                      </Field>
                      <Field>
                        <FieldLabel className="text-xs">Voice</FieldLabel>
                        <Select value={voiceId || "none"} onValueChange={(value) => value !== null && touch(setVoiceId)(value === "none" ? "" : value)}>
                          <SelectTrigger className="w-full"><SelectValue placeholder="Choose a voice" /></SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectLabel>Available voices</SelectLabel>
                              <SelectItem value="none">Workspace default</SelectItem>
                              {voices.map((voice) => <SelectItem key={voice.id} value={voice.id}>{voice.name}</SelectItem>)}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                    </div>
                  </section>

                  <section className="flex flex-col gap-3">
                    <h3 className="text-sm font-medium">2. Choose their character role</h3>
                    <div className="flex flex-wrap gap-2">
                      {CHARACTER_ROLES.map((role) => (
                        <button
                          key={role}
                          type="button"
                          aria-pressed={characterRole === role}
                          onClick={() => touch(setCharacterRole)(role)}
                          className={cn(
                            "rounded-full border px-3.5 py-1.5 text-sm transition-colors",
                            characterRole === role ? "border-primary bg-card text-foreground" : "border-transparent bg-control text-text-secondary hover:bg-control-hover",
                          )}
                        >
                          {role}
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="flex flex-col gap-3">
                    <h3 className="text-sm font-medium">3. Set the difficulty</h3>
                    <div role="radiogroup" aria-label="Difficulty" className="inline-flex w-fit rounded-full bg-sunken p-1">
                      {DIFFICULTIES.map((level) => (
                        <button
                          key={level.value}
                          type="button"
                          role="radio"
                          aria-checked={difficulty === level.value}
                          onClick={() => touch(setDifficulty)(level.value)}
                          className={cn(
                            "rounded-full px-4 py-1.5 text-sm leading-5 font-medium transition-colors",
                            difficulty === level.value ? "bg-card text-foreground shadow-elevation-1" : "text-text-secondary hover:text-foreground",
                          )}
                        >
                          {level.label}
                        </button>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">{difficultyInfo.description}</p>
                  </section>

                  <section className="flex flex-col gap-3">
                    <h3 className="text-sm font-medium">4. How they talk</h3>
                    <TextArea id="rp-talk" value={howTheyTalk} rows={3} onChange={touch(setHowTheyTalk)}
                      placeholder="e.g. Polite, a little guarded. Short answers at first, one to three sentences." />
                  </section>

                  <section className="flex flex-col gap-4">
                    <h3 className="text-sm font-medium">5. How they react</h3>
                    <div className="flex flex-col gap-2">
                      <p className="text-sm">Gets more guarded or ends the call if the agent…</p>
                      <EditableList items={guardedIf} onChange={touch(setGuardedIf)} max={12}
                        placeholder="Example: Uses fake urgency" addLabel="Add" ariaLabel="Gets more guarded if" divided />
                    </div>
                    <div className="flex flex-col gap-2">
                      <p className="text-sm">Opens up if the agent…</p>
                      <EditableList items={opensUpIf} onChange={touch(setOpensUpIf)} max={12}
                        placeholder="Example: Offers real data, with no pressure to buy" addLabel="Add" ariaLabel="Opens up if" divided />
                    </div>
                  </section>

                  <section className="flex flex-col gap-3">
                    <h3 className="text-sm font-medium">6. Write the opening message</h3>
                    <TextArea id="rp-opening" value={opening} rows={2} onChange={touch(setOpening)}
                      placeholder="The first line the persona says." />
                    <p className="text-xs text-muted-foreground">The first line the persona says, in their voice.</p>
                  </section>

                  {whatToExpect && (
                    <div className="rounded-xl bg-muted/60 p-4">
                      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">What to expect</p>
                      <p className="mt-1 text-sm leading-6">{whatToExpect}</p>
                    </div>
                  )}

                  <div className="flex justify-between">
                    <Button variant="ghost" onClick={() => setStep("situation")}>Back</Button>
                    <Button onClick={() => save(false)} disabled={busy}>
                      {busy ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
                      Save role play
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </section>

          <aside className="h-fit lg:sticky lg:top-0">
            <div className="rounded-3xl bg-linear-to-br from-sky-200/70 via-violet-200/70 to-pink-200/70 p-6 text-center dark:from-sky-900/40 dark:via-violet-900/40 dark:to-pink-900/40">
              <div className="relative mx-auto size-40">
                <div className="size-full overflow-hidden rounded-full border-8 border-white/60 bg-muted">
                  {selected?.avatar ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={selected.avatar} alt="" className="size-full object-cover" />
                  ) : (
                    <span className="grid size-full place-items-center text-4xl font-semibold text-muted-foreground">
                      {selected ? selected.name[0] : "?"}
                    </span>
                  )}
                </div>
                <span className="absolute -bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-background px-3 py-0.5 text-xs shadow-sm">
                  {characterRole}
                </span>
              </div>
              <p className="mt-6 text-lg font-semibold">Role play with {firstName(displayName)}</p>
              <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                {selected?.background ?? (scenario.trim() ? scenario.trim().split(/(?<=\.)\s/)[0] : "Choose who the learner will speak with.")}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-4 rounded-full bg-background"
                disabled={!saved || dirty}
                render={saved && !dirty ? <Link href={`/agents/${encodeURIComponent(slug)}`} /> : undefined}
                nativeButton={!(saved && !dirty)}
              >
                <Phone data-icon="inline-start" /> Try role play
              </Button>
              {(!saved || dirty) && <p className="mt-2 text-xs text-muted-foreground">Save to try it.</p>}
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}

function TextArea({ id, value, onChange, rows, placeholder }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  rows: number;
  placeholder?: string;
}) {
  return (
    <textarea
      id={id}
      value={value}
      rows={rows}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className="w-full resize-y rounded-xl border bg-background px-3 py-2 text-sm leading-6 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    />
  );
}

function EditableList({ items, onChange, max, placeholder, addLabel, ariaLabel, divided = false }: {
  items: string[];
  onChange: (items: string[]) => void;
  max: number;
  placeholder: string;
  addLabel: string;
  ariaLabel: string;
  divided?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const full = items.length >= max;
  const add = () => {
    const value = draft.trim();
    if (!value || full || items.includes(value)) return;
    onChange([...items, value]);
    setDraft("");
  };
  return (
    <div className="flex flex-col gap-3">
      {items.length > 0 && (
        <ul className={cn("flex flex-col", divided ? "divide-y" : "gap-1")}>
          {items.map((item, index) => (
            <li key={`${index}:${item}`} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="min-w-0">{item}</span>
              <Button variant="ghost" size="sm" className="shrink-0 font-semibold"
                onClick={() => onChange(items.filter((_, i) => i !== index))} aria-label={`Remove ${item}`}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {!full && (
        <>
          <Input
            value={draft}
            placeholder={placeholder}
            aria-label={ariaLabel}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
            }}
          />
          <Button variant="outline" size="sm" className="w-fit rounded-full" onClick={add} disabled={!draft.trim()}>
            <Plus data-icon="inline-start" /> {addLabel}
          </Button>
        </>
      )}
    </div>
  );
}
