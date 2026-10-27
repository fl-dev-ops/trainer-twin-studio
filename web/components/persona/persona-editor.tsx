"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { ArrowLeft, Check, Plus, Upload, X } from "lucide-react";
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
import { cn } from "@/lib/utils";

type Media = { photoUrl: string | null; hasVideo: boolean; voiceName: string | null };
export type PersonaTab = "look" | "talk" | "media";

/** Create or edit a role-play persona: who they are, how they talk, and their voice and avatar. One Save for all tabs. */
export function PersonaEditor({ slug, initial, media, defaultTab = "look" }: { slug?: string; initial: PersonaInput; media?: Media; defaultTab?: PersonaTab }) {
  const router = useRouter();
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
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the persona");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] px-4 pt-5 pb-16 md:px-0">
        <header className="flex min-h-10 items-center">
          <Link href={back} className="inline-flex items-center gap-2 text-sm text-foreground transition-colors hover:text-muted-foreground">
            <ArrowLeft className="size-4" aria-hidden />
            Back
          </Link>
        </header>
        <div className="mt-6">
          <h1 className="m-0 text-[20px] leading-7 font-semibold tracking-[-0.015em]">{slug ? `Edit ${initial.name || "persona"}` : "Create persona"}</h1>
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
                        className={cn("inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-(--brand)",
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
              <div className="flex flex-col divide-y divide-(--border) rounded-[12px] border border-(--border) bg-(--sidebar) px-4">
                <ToggleRow label="Pauses before answering" help="Takes a beat to think, like a real call." checked={form.pauses} onChange={(pauses) => update({ pauses })} />
                <ToggleRow label="Uses fillers" help="Says “um”, “well” and “you know” now and then." checked={form.fillers} onChange={(fillers) => update({ fillers })} />
              </div>
              <Field label="Signature phrases" help={`Lines they come back to, in their own words. Up to ${MAX_PHRASES}.`}>
                {form.phrases.length ? (
                  <ul className="m-0 flex list-none flex-col divide-y divide-(--border) rounded-[12px] border border-(--border) p-0">
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
                  <Button variant="outline" onClick={addPhrase} disabled={!phrase.trim() || form.phrases.length >= MAX_PHRASES}><Plus /> Add</Button>
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
            {slug && media ? <MediaSection slug={slug} name={form.name} media={media} /> : (
              <Section>
                <p className="m-0 text-sm text-muted-foreground">Save the persona first, then add its voice and avatar here.</p>
              </Section>
            )}
          </TabsContent>
        </Tabs>

        <div className="mt-6 flex items-center justify-end gap-3">
          <Link href={back} className="inline-flex h-9 items-center rounded-full px-4 text-sm font-medium text-muted-foreground hover:text-foreground">Cancel</Link>
          <button type="button" onClick={() => void save()} disabled={saving || !form.name.trim()}
            className="inline-flex h-9 items-center gap-2 rounded-full bg-(--brand) px-5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60">
            <Check className="size-4" aria-hidden />
            {saving ? "Saving…" : slug ? "Save changes" : "Create persona"}
          </button>
        </div>
      </div>
    </div>
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
            className={cn("rounded-full px-4 py-1.5 text-[14px] leading-5 font-medium transition-all outline-none focus-visible:ring-2 focus-visible:ring-(--brand)",
              value === option.value ? "bg-card text-foreground shadow-[0_1px_2px_rgb(30_28_25/0.06)]" : "text-muted-foreground hover:text-foreground")}>
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

/** Voice (reference audio + transcript) and avatar (photo + video) uploads for a saved persona. */
function MediaSection({ slug, name, media }: { slug: string; name: string; media: Media }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"voice" | "avatar" | null>(null);
  const [audio, setAudio] = useState<File | null>(null);
  const [transcript, setTranscript] = useState("");
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
      if (kind === "voice") { setAudio(null); setTranscript(""); } else { setImage(null); setVideo(null); }
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Section>
        <div>
          <h2 className="m-0 text-sm font-semibold uppercase tracking-wide">Voice</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">A clear recording of this person talking. It is the reference the voice is cloned from.</p>
        </div>
        <p className="m-0 text-sm">{media.voiceName ? <>Current voice: <b className="font-semibold">{media.voiceName}</b></> : <span className="text-muted-foreground">No voice yet.</span>}</p>
        <Field label="Reference audio" htmlFor="p-audio" help="WAV, MP3, M4A, WebM or OGG, up to 25 MB.">
          <Input id="p-audio" type="file" accept="audio/wav,audio/x-wav,audio/mpeg,audio/mp4,audio/x-m4a,audio/webm,audio/ogg" onChange={(e) => setAudio(e.target.files?.[0] ?? null)} />
        </Field>
        <Field label="What is said in the recording" htmlFor="p-transcript" help="Optional. Improves the cloned voice.">
          <Textarea id="p-transcript" rows={2} value={transcript} onChange={(e) => setTranscript(e.target.value)} />
        </Field>
        <Button className="w-fit" disabled={!audio || busy !== null} onClick={() => void upload("voice", { audio, transcript })}>
          <Upload /> {busy === "voice" ? "Uploading…" : media.voiceName ? "Replace voice" : "Save voice"}
        </Button>
      </Section>

      <Section>
        <div>
          <h2 className="m-0 text-sm font-semibold uppercase tracking-wide">Avatar</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">A photo and a short video of this person. The AI avatar uses whichever it needs.</p>
        </div>
        <div className="flex items-center gap-4">
          <PersonaPhoto name={name || "?"} photoUrl={media.photoUrl} className="size-16 text-xl" />
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
          <Upload /> {busy === "avatar" ? "Uploading…" : "Save avatar"}
        </Button>
      </Section>
    </div>
  );
}
