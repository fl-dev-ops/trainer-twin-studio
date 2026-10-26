"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, Paperclip, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { VoicePlayButton } from "@/components/client-persona/voice-play-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  ANSWER_LENGTH,
  BEHAVIOURS,
  CLIENT_ROLES,
  FORMALITY,
  INTERRUPTS,
  MAX_BEHAVIOURS,
  MAX_SIGNATURE_PHRASES,
  OPENING_STYLES,
  PACE,
  PERSONA_DIFFICULTIES,
  PERSONA_PRESETS,
  presetForm,
  titleCase,
  type ClientPersonaForm,
} from "@/lib/client-persona";
import type { PersonaDocument, PersonaSourceOption, PersonaVoiceOption } from "@/lib/client-persona-data";
import { cn } from "@/lib/utils";

const VOICE_GROUPS: Array<{ id: PersonaVoiceOption["group"]; label: string }> = [
  { id: "yours", label: "Your voices" },
  { id: "female", label: "Female voices" },
  { id: "male", label: "Male voices" },
  { id: "other", label: "Other voices" },
];

const fieldClass =
  "w-full rounded-xl border bg-background px-3.5 py-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Create or edit a client persona: who they are, how they sound and what they know, on one page. */
export function PersonaEditor({
  slug,
  initial,
  voices,
  sources,
  documents: initialDocuments,
}: {
  slug?: string;
  initial?: ClientPersonaForm;
  voices: PersonaVoiceOption[];
  sources: PersonaSourceOption[];
  documents: PersonaDocument[];
}) {
  const router = useRouter();
  const [form, setForm] = useState<ClientPersonaForm>(initial ?? presetForm("daniel"));
  const [documents, setDocuments] = useState<PersonaDocument[]>(initialDocuments);
  const [phraseDraft, setPhraseDraft] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState<"save" | "upload" | "link" | null>(null);
  const [dirty, setDirty] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const update = (patch: Partial<ClientPersonaForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setDirty(true);
  };
  const setKnowledge = (patch: Partial<ClientPersonaForm["knowledge"]>) =>
    update({ knowledge: { ...form.knowledge, ...patch } });

  function pickPreset(id: string) {
    // Keep the voice and knowledge already chosen; fill everything else from the preset.
    const preset = presetForm(id);
    update({ ...preset, knowledge: form.knowledge, voiceId: form.voiceId || preset.voiceId });
  }

  function toggleBehaviour(value: string) {
    const has = form.behaviours.includes(value);
    if (!has && form.behaviours.length >= MAX_BEHAVIOURS) {
      toast.error("Pick up to three behaviours");
      return;
    }
    update({ behaviours: has ? form.behaviours.filter((item) => item !== value) : [...form.behaviours, value] });
  }

  function addPhrase() {
    const value = phraseDraft.trim();
    if (!value || form.phrases.length >= MAX_SIGNATURE_PHRASES || form.phrases.includes(value)) return;
    update({ phrases: [...form.phrases, value] });
    setPhraseDraft("");
  }

  async function uploadFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy("upload");
    const added: PersonaDocument[] = [];
    for (const file of Array.from(files)) {
      const body = new FormData();
      body.append("file", file);
      try {
        const response = await fetch("/api/knowledge/upload", { method: "POST", body });
        const result = await response.json().catch(() => null);
        if (!response.ok || !result?.document?.id) throw new Error(result?.error ?? `Could not upload ${file.name}`);
        added.push({ id: result.document.id, title: result.document.title ?? file.name, status: result.document.status ?? "queued" });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : `Could not upload ${file.name}`);
      }
    }
    if (added.length) {
      setDocuments((current) => [...current, ...added]);
      setKnowledge({ documentIds: [...form.knowledge.documentIds, ...added.map((doc) => doc.id)] });
      toast.success(`Added ${added.length} file${added.length === 1 ? "" : "s"}. Save the persona to keep them.`);
    }
    if (fileInput.current) fileInput.current.value = "";
    setBusy(null);
  }

  async function addLink() {
    if (!link.trim()) return;
    setBusy("link");
    try {
      const response = await fetch("/api/client-personas/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: link.trim() }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.document?.id) throw new Error(result?.error ?? "Could not add that link");
      setDocuments((current) => [...current, { id: result.document.id, title: result.document.title, status: result.document.status }]);
      setKnowledge({ documentIds: [...form.knowledge.documentIds, result.document.id] });
      setLink("");
      toast.success("Link added. Save the persona to keep it.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not add that link");
    } finally {
      setBusy(null);
    }
  }

  function removeDocument(id: string) {
    setDocuments((current) => current.filter((doc) => doc.id !== id));
    setKnowledge({ documentIds: form.knowledge.documentIds.filter((docId) => docId !== id) });
  }

  async function save() {
    if (!form.name.trim()) {
      toast.error("Give the persona a name");
      return;
    }
    setBusy("save");
    try {
      const response = await fetch(slug ? `/api/client-personas/${encodeURIComponent(slug)}` : "/api/client-personas", {
        method: slug ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error ?? "Could not save the persona");
      setDirty(false);
      toast.success("Persona saved");
      router.push("/personas");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the persona");
    } finally {
      setBusy(null);
    }
  }

  const difficulty = PERSONA_DIFFICULTIES.find((item) => item.value === form.difficulty) ?? PERSONA_DIFFICULTIES[1];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-5 pt-5 sm:px-8">
          <Link href="/personas" className="inline-flex items-center gap-2 text-sm hover:underline">
            <ArrowLeft className="size-4" /> Persona
          </Link>
        </div>

        <div className="mx-auto flex max-w-[720px] flex-col gap-6 px-4 pt-8 pb-12">
          <Section title="Persona" id="persona">
            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium">Pick a persona</p>
              <div className="flex flex-wrap gap-3" role="radiogroup" aria-label="Pick a persona">
                {PERSONA_PRESETS.map((preset) => {
                  const selected = form.look === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => pickPreset(preset.id)}
                      className="flex w-24 flex-col items-center gap-1 text-center"
                    >
                      <span className={cn("relative block size-24 overflow-hidden rounded-xl ring-offset-2 ring-offset-card", selected && "ring-2 ring-primary")}>
                        {/* eslint-disable-next-line @next/next/no-img-element -- static persona photos */}
                        <img src={preset.avatar} alt="" className="size-full object-cover" />
                        {selected ? (
                          <span className="absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-full bg-primary text-primary-foreground">
                            <Check className="size-3" />
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-1 text-sm font-medium">{preset.label}</span>
                      <span className="text-xs text-muted-foreground">{preset.role}</span>
                    </button>
                  );
                })}
              </div>
              <Help>Each persona comes with a role, background and speaking style already filled in. Change anything below.</Help>
            </div>

            <Field label="Name" htmlFor="persona-name">
              <Input id="persona-name" className="h-11 rounded-xl" value={form.name} onChange={(event) => update({ name: event.target.value })} />
            </Field>

            <Field label="Role" htmlFor="persona-role" help="Who they are on the call.">
              <select id="persona-role" className={cn(fieldClass, "h-11")} value={form.role} onChange={(event) => update({ role: event.target.value })}>
                {[...new Set([...CLIENT_ROLES, form.role])].map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Age" htmlFor="persona-age">
                <Input id="persona-age" inputMode="numeric" className="h-11 rounded-xl" value={form.age} onChange={(event) => update({ age: event.target.value })} />
              </Field>
              <Field label="Based in" htmlFor="persona-based">
                <Input id="persona-based" className="h-11 rounded-xl" value={form.basedIn} onChange={(event) => update({ basedIn: event.target.value })} />
              </Field>
            </div>

            <Field label="Background" htmlFor="persona-background">
              <textarea id="persona-background" rows={3} className={cn(fieldClass, "resize-y leading-6")} value={form.background}
                onChange={(event) => update({ background: event.target.value })} />
            </Field>

            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium">Behaviour</p>
              <div className="flex flex-wrap gap-2">
                {BEHAVIOURS.map((behaviour) => {
                  const on = form.behaviours.includes(behaviour);
                  return (
                    <button key={behaviour} type="button" aria-pressed={on} onClick={() => toggleBehaviour(behaviour)}
                      className={cn("rounded-full border px-4 py-1.5 text-sm transition-colors",
                        on ? "border-primary bg-card text-foreground" : "border-transparent bg-muted text-foreground/80 hover:bg-muted/70")}>
                      {behaviour}
                    </button>
                  );
                })}
              </div>
              <Help>Pick up to three.</Help>
            </div>

            <SegmentRow label="Difficulty" help={difficulty.description}
              options={PERSONA_DIFFICULTIES.map((item) => ({ value: item.value, label: item.label }))}
              value={form.difficulty} onChange={(value) => update({ difficulty: value as ClientPersonaForm["difficulty"] })} />

            <SegmentRow label="Opening style" options={OPENING_STYLES.map((value) => ({ value, label: titleCase(value) }))}
              value={form.openingStyle} onChange={(value) => update({ openingStyle: value as ClientPersonaForm["openingStyle"] })} />

            <hr />

            <h3 className="text-base font-semibold">Speaking mannerisms</h3>
            <SegmentRow label="Formality" help="How polished their language is."
              options={FORMALITY.map((value) => ({ value, label: titleCase(value) }))}
              value={form.formality} onChange={(value) => update({ formality: value as ClientPersonaForm["formality"] })} />
            <SegmentRow label="Answer length" help="How much they say at a time."
              options={ANSWER_LENGTH.map((value) => ({ value, label: titleCase(value) }))}
              value={form.answerLength} onChange={(value) => update({ answerLength: value as ClientPersonaForm["answerLength"] })} />
            <SegmentRow label="Interrupts" help="How often they cut the agent off."
              options={INTERRUPTS.map((value) => ({ value, label: titleCase(value) }))}
              value={form.interrupts} onChange={(value) => update({ interrupts: value as ClientPersonaForm["interrupts"] })} />

            <div className="flex flex-col divide-y">
              <ToggleRow label="Pauses before answering" help="Takes a beat to think, like a real call."
                checked={form.pauses} onChange={(pauses) => update({ pauses })} />
              <ToggleRow label="Uses fillers" help="Says “um”, “well” and “you know” now and then."
                checked={form.fillers} onChange={(fillers) => update({ fillers })} />
            </div>

            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium">Signature phrases</p>
              {form.phrases.length ? (
                <ul className="flex flex-col divide-y rounded-xl border">
                  {form.phrases.map((phrase) => (
                    <li key={phrase} className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-sm">
                      <span className="min-w-0">“{phrase}”</span>
                      <Button variant="ghost" size="sm" onClick={() => update({ phrases: form.phrases.filter((item) => item !== phrase) })}>Remove</Button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {form.phrases.length < MAX_SIGNATURE_PHRASES ? (
                <div className="flex gap-2">
                  <Input aria-label="Signature phrase" placeholder="Signature phrase" className="h-11 rounded-xl" value={phraseDraft}
                    onChange={(event) => setPhraseDraft(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addPhrase(); } }} />
                  <Button variant="outline" className="h-11 rounded-full" onClick={addPhrase} disabled={!phraseDraft.trim()}>
                    <Plus data-icon="inline-start" /> Add
                  </Button>
                </div>
              ) : null}
              <Help>Lines they come back to. Up to four.</Help>
            </div>

            <Field label="How they talk" htmlFor="persona-talk">
              <textarea id="persona-talk" rows={3} className={cn(fieldClass, "resize-y leading-6")} value={form.howTheyTalk}
                placeholder="e.g. Polite, a little guarded. Short answers at first."
                onChange={(event) => update({ howTheyTalk: event.target.value })} />
            </Field>
          </Section>

          <Section title="Voice" id="voice" description="The voice learners hear on the call.">
            {VOICE_GROUPS.map((group) => {
              const items = voices.filter((voice) => voice.group === group.id);
              if (!items.length) return null;
              return (
                <div key={group.id} className="flex flex-col gap-3">
                  <p className="text-sm font-medium">{group.label}</p>
                  <div className="flex flex-col divide-y rounded-xl border" role="radiogroup" aria-label={group.label}>
                    {items.map((voice) => (
                      <label key={voice.id} className="flex cursor-pointer items-center gap-3 px-3.5 py-3">
                        <VoicePlayButton voiceId={voice.id} name={voice.name} />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="text-sm font-medium">{voice.name}</span>
                          <span className="text-xs text-muted-foreground">{voice.description}</span>
                        </span>
                        <input type="radio" name="persona-voice" className="size-4 accent-foreground" checked={form.voiceId === voice.id}
                          onChange={() => update({ voiceId: voice.id })} />
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
            <SegmentRow label="Speaking pace" help="How fast the persona talks."
              options={PACE.map((value) => ({ value, label: titleCase(value) }))}
              value={form.pace} onChange={(value) => update({ pace: value as ClientPersonaForm["pace"] })} />
          </Section>

          <Section title="Knowledge" id="knowledge" description="What this persona draws examples and objections from.">
            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium">Upload</p>
              <button type="button" onClick={() => fileInput.current?.click()} disabled={busy === "upload"}
                className="flex items-center gap-3 rounded-xl border border-dashed px-4 py-5 text-left hover:bg-muted/40 disabled:opacity-60">
                {busy === "upload" ? <Spinner /> : <Paperclip className="size-4 text-muted-foreground" />}
                <span className="flex flex-col">
                  <span className="text-sm font-medium">{busy === "upload" ? "Uploading…" : "Upload files"}</span>
                  <span className="text-xs text-muted-foreground">PDF, Word, slides or text</span>
                </span>
              </button>
              <input ref={fileInput} type="file" multiple hidden
                accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.csv,.txt,.md,.rtf,.odt,.odp,.epub"
                onChange={(event) => uploadFiles(event.target.files)} />
              {documents.length ? (
                <ul className="flex flex-col divide-y rounded-xl border">
                  {documents.map((doc) => (
                    <li key={doc.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm">{doc.title}</span>
                        <span className="text-xs text-muted-foreground">{doc.status === "indexed" ? "Ready" : "Processing"}</span>
                      </span>
                      <Button variant="ghost" size="icon-sm" aria-label={`Remove ${doc.title}`} onClick={() => removeDocument(doc.id)}>
                        <X />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium">Sources</p>
              {sources.length ? (
                <div className="flex flex-col divide-y rounded-xl border">
                  {sources.map((source) => {
                    const on = form.knowledge.sourceIds.includes(source.id);
                    return (
                      <div key={source.id} className="flex items-center gap-3 px-3.5 py-3">
                        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-sm font-medium">{source.label.charAt(0)}</span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="text-sm font-medium">{source.label}</span>
                          <span className="truncate text-xs text-muted-foreground">{source.detail}</span>
                        </span>
                        <Toggle checked={on} label={source.label}
                          onChange={(value) => setKnowledge({ sourceIds: value ? [...form.knowledge.sourceIds, source.id] : form.knowledge.sourceIds.filter((id) => id !== source.id) })} />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="rounded-xl border px-4 py-3 text-sm text-muted-foreground">
                  No sources connected yet. Connect Notion or YouTube from <Link href="/knowledge" className="underline">Knowledge</Link>, or paste a link below.
                </p>
              )}
              <div className="flex flex-col gap-2 pt-2">
                <Input aria-label="Paste a link to add a source" placeholder="Paste a link to add a source" className="h-11 rounded-xl"
                  value={link} onChange={(event) => setLink(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void addLink(); } }} />
                <Button variant="outline" className="h-10 w-fit rounded-full" onClick={addLink} disabled={!link.trim() || busy === "link"}>
                  {busy === "link" ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />} Add
                </Button>
              </div>
            </div>
          </Section>
        </div>
      </div>

      <footer className="shrink-0 border-t bg-background">
        <div className="mx-auto flex max-w-[720px] items-center justify-between px-4 py-3">
          <Button variant="ghost" nativeButton={false} render={<Link href="/personas" />}>Cancel</Button>
          <Button className="h-10 rounded-full px-5" onClick={save} disabled={busy === "save"}>
            {busy === "save" ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />} Save persona
          </Button>
        </div>
      </footer>
    </div>
  );
}

function Section({ title, id, description, children }: { title: string; id: string; description?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-6 rounded-2xl border bg-card p-6 shadow-2xs">
      <div className="flex flex-col gap-1.5">
        <h2 id={`${id}-title`} className="text-lg font-semibold">{title}</h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Help({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function Field({ label, htmlFor, help, children }: { label: string; htmlFor: string; help?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={htmlFor} className="text-sm font-medium">{label}</label>
      {children}
      {help ? <Help>{help}</Help> : null}
    </div>
  );
}

function SegmentRow({ label, help, options, value, onChange }: {
  label: string;
  help?: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-medium">{label}</p>
        <div role="radiogroup" aria-label={label} className="inline-flex rounded-full bg-muted p-1">
          {options.map((option) => (
            <button key={option.value} type="button" role="radio" aria-checked={value === option.value} onClick={() => onChange(option.value)}
              className={cn("rounded-full px-4 py-1.5 text-sm transition-colors",
                value === option.value ? "bg-card font-medium text-foreground shadow-xs" : "text-foreground/70 hover:text-foreground")}>
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {help ? <Help>{help}</Help> : null}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
      className={cn("relative h-6 w-10 shrink-0 rounded-full transition-colors", checked ? "bg-primary" : "bg-muted-foreground/25")}>
      <span className={cn("absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform", checked && "translate-x-4")} />
    </button>
  );
}

function ToggleRow({ label, help, checked, onChange }: { label: string; help: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-col">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-sm text-muted-foreground">{help}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} label={label} />
    </div>
  );
}
