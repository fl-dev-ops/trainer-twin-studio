"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, LoaderCircle, Play, Square } from "lucide-react";
import { toast } from "sonner";
import { CARD, PersonaPhoto } from "@/components/persona/persona-parts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ABOUT_MAX, ROLE_SUGGESTIONS, type PersonaFields } from "@/lib/persona";
import { generateSpeech, playPcmStream, stopPlayback } from "@/lib/audio-playback";
import { cn } from "@/lib/utils";
import { useRefresh } from "@/lib/use-refresh";
import { PageContainer } from "@/components/page-container";
import { AddVoiceDialog } from "@/components/voice-library";

type LibraryVoice = { id: string; name: string; kind: string };
type SavedVoice = { id: string; name: string } | null;
type UsedBy = { slug: string; name: string; kind: string }[];

const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Create or edit a persona with one short form: name, role, about, voice and an optional photo. Save commits the whole
 * form; Cancel discards it. Listening to a voice never saves it. Settings from the earlier editor stay stored and are
 * shown read-only on the persona page.
 */
export function PersonaEditor({ slug, initial, voice = null, photoUrl = null, voices = [], isOwn = false, usedBy = [] }: {
  slug?: string;
  initial: PersonaFields;
  voice?: SavedVoice;
  photoUrl?: string | null;
  voices?: LibraryVoice[];
  isOwn?: boolean;
  usedBy?: UsedBy;
}) {
  const router = useRouter();
  const refresh = useRefresh();
  const [form, setForm] = useState<PersonaFields>(initial);
  const [selected, setSelected] = useState<SavedVoice>(voice);
  const [photo, setPhoto] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const update = (patch: Partial<PersonaFields>) => setForm((current) => ({ ...current, ...patch }));
  const back = slug ? `/personas/${encodeURIComponent(slug)}` : "/personas";
  const roles = useId();

  function choosePhoto(file: File | null) {
    if (file && !PHOTO_TYPES.includes(file.type)) return toast.error("Use a JPG, PNG or WebP photo.");
    if (file && file.size > PHOTO_MAX_BYTES) return toast.error("The photo must be 10 MB or smaller.");
    setPhoto(file);
  }

  async function save() {
    setSaving(true);
    try {
      const body = { name: form.name, role: form.role, about: form.about, ...(selected && selected.id !== voice?.id ? { voiceId: selected.id } : {}) };
      const response = await fetch(slug ? `/api/personas/${encodeURIComponent(slug)}` : "/api/personas", {
        method: slug ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => null) as { slug?: string; error?: string } | null;
      if (!response.ok || !result?.slug) throw new Error(result?.error ?? "Could not save the persona");
      if (photo) {
        const upload = new FormData();
        upload.set("image", photo);
        const uploaded = await fetch(`/api/personas/${encodeURIComponent(result.slug)}/media`, { method: "POST", body: upload });
        if (!uploaded.ok) {
          const failure = await uploaded.json().catch(() => null) as { error?: string } | null;
          toast.error(`Saved, but the photo was not uploaded: ${failure?.error ?? "try again"}`);
        }
      }
      toast.success(slug ? "Persona saved" : "Persona created");
      router.push(`/personas/${encodeURIComponent(result.slug)}`);
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
        <p className="mt-1 text-sm text-muted-foreground">The person your learners talk to. The role play decides the situation; the persona decides who they are.</p>
      </div>

      {slug && usedBy.length ? (
        <p className="mt-4 rounded-tt-md border border-(--border) bg-(--sidebar) px-4 py-3 text-sm text-(--text-secondary)" data-testid="persona-used-by">
          <span className="font-medium text-foreground">Used by {usedBy.length} {usedBy.length === 1 ? "agent" : "agents"}.</span>{" "}
          Changes apply to their next sessions. Sessions already started keep the persona and voice they began with.
        </p>
      ) : null}

      <article className={cn(CARD, "mt-6 flex flex-col gap-6 p-6")}>
        <Field label="Name" htmlFor="p-name">
          <Input id="p-name" value={form.name} maxLength={120} placeholder="Example: Amira Haddad" onChange={(e) => update({ name: e.target.value })} />
        </Field>
        <Field label="Role" htmlFor="p-role" help="Who they are on the call, in a few words.">
          <Input id="p-role" list={roles} value={form.role} maxLength={60} placeholder="Example: Buyer" onChange={(e) => update({ role: e.target.value })} />
          <datalist id={roles}>{ROLE_SUGGESTIONS.map((role) => <option key={role} value={role} />)}</datalist>
        </Field>
        <Field label="About this person" htmlFor="p-about" optional
          help="Their background and how they usually behave. Keep scenario facts (budget, deal, mood today) in the role play.">
          <Textarea id="p-about" rows={4} value={form.about} maxLength={ABOUT_MAX} onChange={(e) => update({ about: e.target.value })}
            placeholder="Example: A careful first-time investor. Polite, asks for numbers and wants time to think." />
        </Field>
        <VoiceSection saved={voice} selected={selected} voices={voices} onSelect={setSelected} />
        <Field label="Photo" htmlFor="p-photo" optional help={isOwn ? undefined : "JPG, PNG or WebP, up to 10 MB. Initials are shown without one."}>
          <div className="flex items-center gap-4">
            <PersonaPhoto name={form.name || "?"} photoUrl={photo ? null : photoUrl} size="lg" />
            {isOwn ? (
              <p className="m-0 text-sm text-(--text-secondary)">
                Your photo is set up on{" "}
                <Link href="/twin/brain" className="font-medium text-foreground underline-offset-4 hover:underline">Twin’s brain</Link>.
              </p>
            ) : (
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Input id="p-photo" type="file" accept={PHOTO_TYPES.join(",")} onChange={(e) => choosePhoto(e.target.files?.[0] ?? null)} />
                {photo ? <p className="m-0 text-xs text-muted-foreground">{photo.name} will be uploaded when you save.</p> : null}
              </div>
            )}
          </div>
        </Field>
      </article>

      <div className="mt-6 flex items-center justify-end gap-3">
        <Button variant="ghost" nativeButton={false} render={<Link href={back} />}>Cancel</Button>
        <Button variant="brand" onClick={() => void save()} disabled={saving || !form.name.trim() || !form.role.trim()}>
          <Check data-icon="inline-start" aria-hidden />
          {saving ? "Saving…" : slug ? "Save changes" : "Create persona"}
        </Button>
      </div>
    </PageContainer>
  );
}

function Field({ label, htmlFor, help, optional, children }: { label: string; htmlFor?: string; help?: string; optional?: boolean; children: ReactNode }) {
  const title = <>{label}{optional ? <span className="font-normal text-muted-foreground"> (optional)</span> : null}</>;
  return (
    <div className="flex flex-col gap-1.5">
      {htmlFor ? <label htmlFor={htmlFor} className="text-sm font-medium">{title}</label> : <p className="m-0 text-sm font-medium">{title}</p>}
      {children}
      {help ? <p className="m-0 text-xs text-muted-foreground">{help}</p> : null}
    </div>
  );
}

/** The voice part of the form: the selection is saved with the form, never on its own. */
function VoiceSection({ saved, selected, voices, onSelect }: { saved: SavedVoice; selected: SavedVoice; voices: LibraryVoice[]; onSelect: (voice: SavedVoice) => void }) {
  const [choosing, setChoosing] = useState(false);
  const [previous, setPrevious] = useState<SavedVoice>(selected);
  const unavailable = selected !== null && selected.id === saved?.id && !voices.some((voice) => voice.id === selected.id);
  const changed = selected?.id !== saved?.id;

  return (
    <section aria-label="Voice" className="flex flex-col gap-2">
      <p className="m-0 text-sm font-medium">Voice</p>
      <p className="m-0 text-sm">
        {selected
          ? <>{changed ? "New voice" : "Current voice"}: <b className="font-semibold">{selected.name || "Unnamed voice"}</b>{changed ? <span className="text-muted-foreground"> (saved when you save the persona)</span> : null}</>
          : <span className="text-muted-foreground">No voice yet. Choose or add one before starting a voice session.</span>}
      </p>
      {unavailable ? <p className="m-0 text-sm text-muted-foreground">The current voice is unavailable for new voice sessions. It stays selected until you save another voice.</p> : null}
      {choosing ? (
        <>
          <VoicePicker voices={voices} current={saved?.id ?? null} selected={selected?.id ?? null} busy={false}
            onSelect={(id) => { const voice = voices.find((row) => row.id === id); if (voice) onSelect({ id: voice.id, name: voice.name }); }} />
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => { onSelect(previous); setChoosing(false); }}>Cancel</Button>
            <Button size="sm" onClick={() => setChoosing(false)}>Use this voice</Button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => { setPrevious(selected); setChoosing(true); }}>Choose a voice</Button>
          <AddVoiceDialog onCreated={(voice) => { onSelect({ id: voice.id, name: voice.name }); }} />
        </div>
      )}
      <p className="m-0 text-xs text-muted-foreground">Other personas using a voice keep their selection.</p>
    </section>
  );
}

const PREVIEW_SENTENCE = "Hi, thanks for calling. I've got a few minutes, so tell me what this is about.";

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
    return <p className="m-0 text-sm text-muted-foreground">No ready voices available. Cancel to add your voice.</p>;
  }
  return (
    <ul aria-label="Choose a voice" className="m-0 flex list-none flex-col divide-y divide-(--border) rounded-tt-md border border-(--border) p-0">
      {voices.map((voice) => (
        <li key={voice.id} className="flex items-center gap-3 px-3 py-2.5">
          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
            <input type="radio" name="persona-voice" value={voice.id} checked={selected === voice.id} disabled={busy} onChange={() => onSelect(voice.id)} />
            <span className="truncate text-sm font-medium">{voice.name}</span>
            {current === voice.id ? <span className="text-xs text-muted-foreground">Current</span> : null}
          </label>
          <Button size="sm" variant="ghost" onClick={() => void preview(voice)} disabled={loading !== null && loading !== voice.id} aria-label={playing === voice.id ? `Stop ${voice.name}` : `Listen to ${voice.name}`}>
            {loading === voice.id ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : playing === voice.id ? <Square aria-hidden /> : <Play aria-hidden />}
            {playing === voice.id ? "Stop" : "Listen"}
          </Button>
        </li>
      ))}
    </ul>
  );
}
