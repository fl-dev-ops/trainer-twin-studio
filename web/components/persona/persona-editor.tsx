"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, LoaderCircle, Play, Plus, Square, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { CARD, PersonaPhoto } from "@/components/persona/persona-parts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  ANSWER_LENGTH, BEHAVIOURS, FORMALITY, INTERRUPTS, MAX_BEHAVIOURS, MAX_PHRASES, OPENING_STYLES, PACE, PERSONA_ROLES,
  meaningOf, type PersonaInput,
} from "@/lib/persona";
import { generateSpeech, playPcmStream, stopPlayback } from "@/lib/audio-playback";
import { cn } from "@/lib/utils";
import { useRefresh } from "@/lib/use-refresh";
import { PageContainer } from "@/components/page-container";
import { AddVoiceDialog } from "@/components/voice-library";

type Media = { photoUrl: string | null; hasVideo: boolean; voiceId: string | null; voiceName: string | null };
type LibraryVoice = { id: string; name: string; kind: string };
export type PersonaTab = "look" | "talk" | "media";

/** Create or edit a role-play persona: who they are, how they talk, and their voice and avatar. One Save for all tabs. */
export function PersonaEditor({ slug, initial, media, voices = [], isOwn = false, defaultTab = "look" }: { slug?: string; initial: PersonaInput; media?: Media; voices?: LibraryVoice[]; isOwn?: boolean; defaultTab?: PersonaTab }) {
  const router = useRouter();
  const refresh = useRefresh();
  const [form, setForm] = useState<PersonaInput>(initial);
  const [phrase, setPhrase] = useState("");
  const [saving, setSaving] = useState(false);
  const update = (patch: Partial<PersonaInput>) => setForm((current) => ({ ...current, ...patch }));
  const roleOptions = (Object.values(PERSONA_ROLES).flat() as string[]).includes(form.role) ? null : form.role;
  const back = slug ? `/personas/${encodeURIComponent(slug)}` : "/personas";

  function toggleBehaviour(value: PersonaInput["behaviours"][number]) {
    if (form.behaviours.includes(value)) return update({ behaviours: form.behaviours.filter((b) => b !== value) });
    if (form.behaviours.length >= MAX_BEHAVIOURS) return toast.error("Pick up to three behaviours");
    update({ behaviours: [...form.behaviours, value] });
  }

  function addPhrase() {
    const value = phrase.trim();
    if (!value || form.phrases.length >= MAX_PHRASES || form.phrases.includes(value)) return;
    update({ phrases: [...form.phrases, value] });
    setPhrase("");
  }

  async function save() {
    setSaving(true);
    try {
      const response = await fetch(slug ? `/api/personas/${encodeURIComponent(slug)}` : "/api/personas", {
        method: slug ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error ?? "Could not save the persona");
      toast.success(slug ? "Persona saved" : "Persona created");
      router.push(slug ? `/personas/${encodeURIComponent(result.slug)}` : `/personas/${encodeURIComponent(result.slug)}/edit?tab=media`);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the persona");
    } finally {
      setSaving(false);
    }
  }

  return (
    <PageContainer>
      <header className="flex min-h-10 items-center">
        <Link href={back} className="inline-flex items-center gap-2 text-sm text-foreground transition-colors hover:text-muted-foreground">
          <ArrowLeft className="size-4" aria-hidden />
          Back
        </Link>
      </header>
      <div className="mt-6">
        <h1 className="m-0 text-title-m leading-7 font-semibold tracking-title">{slug ? `Edit ${initial.name || "persona"}` : "Create persona"}</h1>
        <p className="mt-1 text-sm text-muted-foreground">Who your learners talk to in a role play: who they are, how they talk, and how they sound and look.</p>
      </div>

      <Tabs defaultValue={defaultTab} className="mt-6 gap-4">
        <TabsList>
          <TabsTrigger value="look">Look</TabsTrigger>
          <TabsTrigger value="talk">How they talk</TabsTrigger>
          <TabsTrigger value="media">Voice and avatar</TabsTrigger>
        </TabsList>

        <TabsContent value="look">
          <Section>
            <Field label="Name" htmlFor="p-name">
              <Input id="p-name" value={form.name} placeholder="Example: Amira Haddad" onChange={(e) => update({ name: e.target.value })} />
            </Field>
            <Field label="Role" htmlFor="p-role" help="Who they are on the call.">
              <NativeSelect id="p-role" value={form.role} onChange={(e) => update({ role: e.target.value })} className="w-full">
                {roleOptions ? <NativeSelectOption value={roleOptions}>{roleOptions}</NativeSelectOption> : null}
                {Object.entries(PERSONA_ROLES).map(([group, roles]) => (
                  <NativeSelectOptGroup key={group} label={group}>
                    {roles.map((role) => <NativeSelectOption key={role} value={role}>{role}</NativeSelectOption>)}
                  </NativeSelectOptGroup>
                ))}
              </NativeSelect>
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Age" htmlFor="p-age">
                <Input id="p-age" inputMode="numeric" value={form.age ?? ""} placeholder="Example: 44"
                  onChange={(e) => { const n = Number.parseInt(e.target.value, 10); update({ age: Number.isFinite(n) ? n : null }); }} />
              </Field>
              <Field label="Based in" htmlFor="p-based">
                <Input id="p-based" value={form.basedIn} placeholder="Example: Dubai Marina" onChange={(e) => update({ basedIn: e.target.value })} />
              </Field>
            </div>
            <Field label="Background" htmlFor="p-background" help="Their situation, what they want and what worries them.">
              <Textarea id="p-background" rows={4} value={form.background} onChange={(e) => update({ background: e.target.value })}
                placeholder="Example: Went quiet after a townhouse viewing. Worried about the down payment and fees." />
            </Field>
            <Field label="Behaviour" help={`Pick up to ${MAX_BEHAVIOURS}.`}>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Behaviour">
                {BEHAVIOURS.map((b) => {
                  const on = form.behaviours.includes(b.value);
                  return (
                    <button key={b.value} type="button" aria-pressed={on} title={b.meaning} onClick={() => toggleBehaviour(b.value)}
                      className={cn("inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-body-s font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-(--brand)",
                        on ? "border-transparent bg-foreground text-background" : "border-(--card-border) text-(--text-secondary) hover:bg-(--tone-control)")}>
                      {on ? <Check className="size-3.5" aria-hidden /> : null}
                      {b.value}
                    </button>
                  );
                })}
              </div>
              {form.behaviours.length ? (
                <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0 text-xs text-muted-foreground">
                  {form.behaviours.map((b) => <li key={b}>{b}: {meaningOf(BEHAVIOURS.map((x) => ({ ...x })), b)}</li>)}
                </ul>
              ) : null}
            </Field>
            <Choice label="Opening style" options={OPENING_STYLES} value={form.openingStyle} onChange={(openingStyle) => update({ openingStyle })} />
          </Section>
        </TabsContent>

        <TabsContent value="talk">
          <Section>
            <Choice label="Formality" options={FORMALITY} value={form.formality} onChange={(formality) => update({ formality })} />
            <Choice label="Answer length" options={ANSWER_LENGTH} value={form.answerLength} onChange={(answerLength) => update({ answerLength })} />
            <Choice label="Interrupts" options={INTERRUPTS} value={form.interrupts} onChange={(interrupts) => update({ interrupts })} />
            <div className="flex flex-col divide-y divide-(--border) rounded-tt-md border border-(--border) bg-(--sidebar) px-4">
              <ToggleRow label="Pauses before answering" help="Takes a beat to think, like a real call." checked={form.pauses} onChange={(pauses) => update({ pauses })} />
              <ToggleRow label="Uses fillers" help="Says “um”, “well” and “you know” now and then." checked={form.fillers} onChange={(fillers) => update({ fillers })} />
            </div>
            <Field label="Signature phrases" help={`Lines they come back to, in their own words. Up to ${MAX_PHRASES}.`}>
              {form.phrases.length ? (
                <ul className="m-0 flex list-none flex-col divide-y divide-(--border) rounded-tt-md border border-(--border) p-0">
                  {form.phrases.map((p) => (
                    <li key={p} className="flex items-center justify-between gap-3 px-3.5 py-2 text-sm">
                      <span>“{p}”</span>
                      <Button variant="ghost" size="icon-sm" aria-label={`Remove “${p}”`} onClick={() => update({ phrases: form.phrases.filter((x) => x !== p) })}><X /></Button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="flex gap-2">
                <Input aria-label="Signature phrase" value={phrase} placeholder="Example: I need to talk to my husband." disabled={form.phrases.length >= MAX_PHRASES}
                  onChange={(e) => setPhrase(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addPhrase(); } }} />
                <Button variant="outline" onClick={addPhrase} disabled={!phrase.trim() || form.phrases.length >= MAX_PHRASES}><Plus data-icon="inline-start" /> Add</Button>
              </div>
            </Field>
            <Field label="In their words" htmlFor="p-talk" help="One or two sentences on how they come across.">
              <Textarea id="p-talk" rows={2} value={form.howTheyTalk} onChange={(e) => update({ howTheyTalk: e.target.value })}
                placeholder="Example: Polite and a little guarded. Short answers at first." />
            </Field>
            <Choice label="Speaking pace" options={PACE} value={form.pace} onChange={(pace) => update({ pace })} />
          </Section>
        </TabsContent>

        <TabsContent value="media">
          {isOwn && slug && media ? (
            <div className="flex flex-col gap-4">
              <VoiceSection key={media.voiceId ?? "none"} slug={slug} media={media} voices={voices} />
              <Section>
                <p className="m-0 text-sm text-(--text-secondary)">
                  Your photo and reference video are set up on{" "}
                  <Link href="/twin/brain" className="font-medium text-foreground underline-offset-4 hover:underline">Twin’s brain</Link>.
                  {" "}You can still record your voice there.
                </p>
              </Section>
            </div>
          ) : slug && media ? <MediaSection slug={slug} name={form.name} media={media} voices={voices} /> : (
            <Section>
              <p className="m-0 text-sm text-muted-foreground">Save the persona first, then add its voice and avatar here.</p>
            </Section>
          )}
        </TabsContent>
      </Tabs>

      <div className="mt-6 flex items-center justify-end gap-3">
        <Button variant="ghost" nativeButton={false} render={<Link href={back} />}>Cancel</Button>
        <Button variant="brand" onClick={() => void save()} disabled={saving || !form.name.trim()}>
          <Check data-icon="inline-start" aria-hidden />
          {saving ? "Saving…" : slug ? "Save changes" : "Create persona"}
        </Button>
      </div>
    </PageContainer>
  );
}

function Section({ children }: { children: ReactNode }) {
  return <article className={cn(CARD, "flex flex-col gap-6 p-6")}>{children}</article>;
}

function Field({ label, htmlFor, help, children }: { label: string; htmlFor?: string; help?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      {htmlFor ? <label htmlFor={htmlFor} className="text-sm font-medium">{label}</label> : <p className="m-0 text-sm font-medium">{label}</p>}
      {children}
      {help ? <p className="m-0 text-xs text-muted-foreground">{help}</p> : null}
    </div>
  );
}

/** Segmented single choice with the selected option's meaning underneath. */
function Choice<T extends string>({ label, options, value, onChange }: { label: string; options: readonly { value: T; label: string; meaning: string }[]; value: T; onChange: (value: T) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="m-0 text-sm font-medium">{label}</p>
      <div role="radiogroup" aria-label={label} className="inline-flex w-fit items-center rounded-full bg-(--sidebar) p-1">
        {options.map((option) => (
          <button key={option.value} type="button" role="radio" aria-checked={value === option.value} onClick={() => onChange(option.value)}
            className={cn("rounded-full px-4 py-1.5 text-sm leading-5 font-medium transition-all outline-none focus-visible:ring-2 focus-visible:ring-(--brand)",
              value === option.value ? "bg-card text-foreground shadow-elevation-1" : "text-muted-foreground hover:text-foreground")}>
            {option.label}
          </button>
        ))}
      </div>
      <p className="m-0 text-xs text-muted-foreground">{options.find((o) => o.value === value)?.meaning}</p>
    </div>
  );
}

function ToggleRow({ label, help, checked, onChange }: { label: string; help: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3.5">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{help}</span>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

/** Voice (picked from the voice library) and avatar (photo + video uploads) for a saved role-play persona. */
function MediaSection({ slug, name, media, voices }: { slug: string; name: string; media: Media; voices: LibraryVoice[] }) {
  const refresh = useRefresh();
  const [busy, setBusy] = useState<"voice" | "avatar" | null>(null);
  const [image, setImage] = useState<File | null>(null);
  const [video, setVideo] = useState<File | null>(null);

  async function upload(kind: "voice" | "avatar", files: Record<string, File | string | null>) {
    setBusy(kind);
    try {
      const body = new FormData();
      for (const [key, value] of Object.entries(files)) if (value) body.set(key, value);
      const response = await fetch(`/api/personas/${encodeURIComponent(slug)}/media`, { method: "POST", body });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error ?? "Upload failed");
      toast.success(kind === "voice" ? "Voice saved" : "Avatar saved");
      if (kind === "avatar") { setImage(null); setVideo(null); }
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <VoiceSection key={media.voiceId ?? "none"} slug={slug} media={media} voices={voices} />

      <Section>
        <div>
          <h2 className="m-0 text-sm font-semibold uppercase tracking-wide">Avatar</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">A photo and a short video of this person. The AI avatar uses whichever it needs.</p>
        </div>
        <div className="flex items-center gap-4">
          <PersonaPhoto name={name || "?"} photoUrl={media.photoUrl} size="lg" />
          <p className="m-0 text-sm text-muted-foreground">{[media.photoUrl ? "Photo added" : "No photo yet", media.hasVideo ? "video added" : "no video yet"].join(" · ")}</p>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Photo" htmlFor="p-image" help="JPG, PNG or WebP, up to 10 MB.">
            <Input id="p-image" type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setImage(e.target.files?.[0] ?? null)} />
          </Field>
          <Field label="Video" htmlFor="p-video" help="MP4, WebM or MOV, up to 100 MB.">
            <Input id="p-video" type="file" accept="video/mp4,video/webm,video/quicktime" onChange={(e) => setVideo(e.target.files?.[0] ?? null)} />
          </Field>
        </div>
        <Button className="w-fit" disabled={(!image && !video) || busy !== null} onClick={() => void upload("avatar", { image, video })}>
          <Upload data-icon="inline-start" /> {busy === "avatar" ? "Uploading…" : "Save avatar"}
        </Button>
      </Section>
    </div>
  );
}

const PREVIEW_SENTENCE = "Hi, thanks for calling. I've got a few minutes, so tell me what this is about.";

function VoiceSection({ slug, media, voices }: { slug: string; media: Media; voices: LibraryVoice[] }) {
  const refresh = useRefresh();
  const [current, setCurrent] = useState({ id: media.voiceId, name: media.voiceName });
  const [selected, setSelected] = useState(media.voiceId);
  const [choosing, setChoosing] = useState(false);
  const [saving, setSaving] = useState(false);
  const unavailable = current.id !== null && !voices.some((voice) => voice.id === current.id);
  const choice = voices.find((voice) => voice.id === selected);
  const currentName = current.id === media.voiceId ? media.voiceName : current.name;

  async function attach(voice: { id: string; name: string }) {
    setSaving(true);
    try {
      const body = new FormData();
      body.set("voiceId", voice.id);
      const response = await fetch(`/api/personas/${encodeURIComponent(slug)}/media`, { method: "POST", body });
      const result: { error?: string } = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not save the voice");
      setCurrent(voice);
      setSelected(voice.id);
      setChoosing(false);
      refresh();
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    if (!choice || choice.id === current.id) return;
    try {
      await attach(choice);
      toast.success("Voice saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the voice");
    }
  }

  return (
    <Section>
      <div>
        <h2 className="m-0 text-sm font-semibold uppercase tracking-wide">Voice</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Choose a voice or add a recording. Other personas using a voice keep their selection.</p>
      </div>
      <p className="m-0 text-sm">{current.id ? <>Current voice: <b className="font-semibold">{currentName ?? "Unnamed voice"}</b></> : <span className="text-muted-foreground">No voice yet. Choose or add one before starting a voice session.</span>}</p>
      {unavailable ? <p className="m-0 text-sm text-muted-foreground">The current voice is unavailable for new voice sessions. It stays selected until you save another voice.</p> : null}
      {choosing ? (
        <>
          <VoicePicker voices={voices} current={current.id} selected={selected} busy={saving} onSelect={setSelected} />
          <div className="flex items-center gap-2">
            <Button variant="outline" disabled={saving} onClick={() => { setSelected(current.id); setChoosing(false); }}>Cancel</Button>
            <Button disabled={saving || !choice || selected === current.id} onClick={() => void save()}>{saving ? "Saving…" : "Save voice"}</Button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled={saving} onClick={() => { setSelected(current.id); setChoosing(true); }}>Choose a voice</Button>
          <AddVoiceDialog onCreated={attach} />
        </div>
      )}
    </Section>
  );
}

function VoicePicker({ voices, current, selected, busy, onSelect }: { voices: LibraryVoice[]; current: string | null; selected: string | null; busy: boolean; onSelect: (voiceId: string) => void }) {
  const [playing, setPlaying] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const previewRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    previewRef.current?.abort();
    previewRef.current = null;
    stopPlayback();
  }, []);

  async function preview(voice: LibraryVoice) {
    previewRef.current?.abort();
    stopPlayback();
    previewRef.current = null;
    setLoading(null);
    if (playing === voice.id) return setPlaying(null);
    const controller = new AbortController();
    previewRef.current = controller;
    setPlaying(voice.id);
    setLoading(voice.id);
    try {
      const response = await generateSpeech(voice.id, PREVIEW_SENTENCE, true, controller.signal);
      controller.signal.throwIfAborted();
      setLoading(null);
      await playPcmStream(response, controller.signal);
    } catch (cause) {
      if (!(controller.signal.aborted && cause instanceof DOMException && cause.name === "AbortError")) {
        toast.error(cause instanceof Error ? cause.message : "Preview failed. Is the voice service running?");
      }
    } finally {
      if (previewRef.current === controller) {
        previewRef.current = null;
        setLoading(null);
        setPlaying(null);
      }
    }
  }

  if (!voices.length) {
    return (
      <p className="m-0 text-sm text-muted-foreground">
        No ready voices available. Cancel to add your voice.
      </p>
    );
  }
  return (
    <ul aria-label="Choose a voice" className="m-0 flex list-none flex-col divide-y divide-(--border) rounded-tt-md border border-(--border) p-0">
      {voices.map((voice) => {
        const inUse = current === voice.id;
        return (
          <li key={voice.id} className="flex items-center gap-3 px-3 py-2.5">
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
              <input type="radio" name="persona-voice" value={voice.id} checked={selected === voice.id} disabled={busy} onChange={() => onSelect(voice.id)} />
              <span className="truncate text-sm font-medium">{voice.name}</span>
              {inUse ? <span className="text-xs text-muted-foreground">Current</span> : null}
            </label>
            <Button size="sm" variant="ghost" onClick={() => void preview(voice)} disabled={loading !== null && loading !== voice.id} aria-label={playing === voice.id ? `Stop ${voice.name}` : `Listen to ${voice.name}`}>
              {loading === voice.id ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : playing === voice.id ? <Square aria-hidden /> : <Play aria-hidden />}
              {playing === voice.id ? "Stop" : "Listen"}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
