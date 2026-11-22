"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { LoaderCircle, Mic, MoreHorizontal, Pencil, Play, Square, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { VoiceRecorder } from "@/components/voice-recorder";
import { generateSpeech, playPcmStream, stopPlayback } from "@/lib/audio-playback";
import { useRefresh } from "@/lib/use-refresh";
import { randomPassage } from "@/lib/voice-passage";
import { SearchInput } from "@/components/search-input";

export type VoiceRow = {
  id: string;
  name: string;
  kind: string;
  status: string;
  createdAt: string;
};

const SAMPLE_SENTENCE = "Hi, this is a quick test of my voice. Let us begin today's session.";

export function VoiceLibrary({ mine, samples }: { mine: VoiceRow[]; samples: VoiceRow[] }) {
  // Chosen once: a refetch that adds or removes a voice must not change an uncontrolled Tabs' default.
  const [initialTab] = useState(mine.length ? "my" : "explore");
  return (
    <Tabs defaultValue={initialTab} className="mt-6">
      <TabsList>
        <TabsTrigger className={"cursor-pointer"} value="explore">Explore voices</TabsTrigger>
        <TabsTrigger className={"cursor-pointer"} value="my">My voices</TabsTrigger>
      </TabsList>
      <TabsContent value="explore">
        <VoiceTab voices={samples} kind="sample" emptyState={<SampleEmptyState />} />
      </TabsContent>
      <TabsContent value="my">
        <VoiceTab
          voices={mine}
          kind="cloned"
          emptyState={
            <div className="flex flex-col items-center py-14 text-center">
              <span className="grid size-12 place-items-center rounded-2xl bg-muted">
                <Mic className="size-5 text-muted-foreground" aria-hidden="true" />
              </span>
              <p className="mt-4 max-w-xs text-sm leading-6 text-muted-foreground">
                Add a named recording or upload. The same voice can be chosen by more than one persona.
              </p>
              <Button className="mt-5" size="sm" render={<Link href="/voice/cloning" />} nativeButton={false}>
                <Mic data-icon="inline-start" /> Add my voice
              </Button>
            </div>
          }
        />
      </TabsContent>
    </Tabs>
  );
}

function VoiceTab({
  voices,
  kind,
  emptyState,
}: {
  voices: VoiceRow[];
  kind: "sample" | "cloned";
  emptyState: React.ReactNode;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () => voices.filter((voice) => voice.name.toLowerCase().includes(query.trim().toLowerCase())),
    [voices, query],
  );

  return (
    <div className="mt-4">
      <div className="flex items-center gap-2">
        <SearchInput
          className="w-full max-w-xs"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search"
          aria-label="Search voices"
        />
      </div>

      {filtered.length > 0 ? (
        <ul className="mt-4 divide-y rounded-xl border bg-card">
          {filtered.map((voice) => (
            <VoiceRowItem key={voice.id} voice={voice} sample={kind === "sample"} />
          ))}
        </ul>
      ) : (
        emptyState
      )}
    </div>
  );
}

type CreatedVoice = { id: string; name: string };
type OnVoiceCreated = (voice: CreatedVoice) => void | Promise<void>;

export function VoiceCreateForm({ onCreated, onCancel, onSaved, onSavingChange }: {
  onCreated?: OnVoiceCreated;
  onCancel: () => void;
  onSaved?: () => void;
  onSavingChange?: (saving: boolean) => void;
}) {
  const refresh = useRefresh();
  const id = useId();
  const [name, setName] = useState("");
  const [source, setSource] = useState<"record" | "upload">("record");
  const [audio, setAudio] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<CreatedVoice | null>(null);
  const [error, setError] = useState("");
  const [passage] = useState(randomPassage);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !audio || saving) return;
    setSaving(true);
    onSavingChange?.(true);
    setError("");
    try {
      let voice = created;
      if (!voice) {
        const form = new FormData();
        form.set("name", name.trim());
        form.set("audio", audio);
        form.set("transcript", source === "record" ? passage : "");
        const response = await fetch("/api/tts/voices", { method: "POST", body: form });
        const result: { voice?: { id: string; name: string }; error?: string } = await response.json();
        if (!response.ok || !result.voice) throw new Error(result.error ?? "Could not add the voice");
        voice = result.voice;
        setCreated(voice);
      }
      if (onCreated) await onCreated(voice);
      toast.success(onCreated ? "Voice saved" : "Voice added");
      refresh();
      onSaved?.();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not add the voice";
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
      onSavingChange?.(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <fieldset disabled={saving || created !== null} className="flex min-w-0 flex-col gap-4">
        <Field>
          <FieldLabel htmlFor={`${id}-name`}>Voice name</FieldLabel>
          <Input id={`${id}-name`} value={name} onChange={(event) => setName(event.currentTarget.value)} maxLength={60} autoFocus />
        </Field>
        <Tabs value={source} onValueChange={(value) => { if (value === "record" || value === "upload") { setSource(value); setAudio(null); } }}>
          <TabsList aria-label="Voice recording source">
            <TabsTrigger value="record">Record</TabsTrigger>
            <TabsTrigger value="upload">Upload</TabsTrigger>
          </TabsList>
          <TabsContent value="record" className="flex flex-col gap-4">
            <p className="m-0 text-sm text-muted-foreground">Read this passage aloud:</p>
            <p className="m-0 text-sm leading-6">{passage}</p>
            {source === "record" ? audio ? (
              <div className="flex items-center gap-3">
                <p role="status" className="m-0 text-sm">Recording ready to save.</p>
                <Button variant="outline" size="sm" onClick={() => setAudio(null)}>Record again</Button>
              </div>
            ) : <VoiceRecorder disabled={saving} onFinished={(wav) => setAudio(new File([wav], "reference.wav", { type: "audio/wav" }))} /> : null}
          </TabsContent>
          <TabsContent value="upload" className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor={`${id}-audio`}>Recording</FieldLabel>
              <Input id={`${id}-audio`} type="file" accept="audio/wav,audio/x-wav,audio/mpeg,audio/mp4,audio/x-m4a,audio/webm,audio/ogg" onChange={(event) => setAudio(event.currentTarget.files?.[0] ?? null)} />
              <FieldDescription>One audio file, up to 25 MB.</FieldDescription>
            </Field>
          </TabsContent>
        </Tabs>
      </fieldset>
      {error ? <p role="alert" className="m-0 text-sm text-destructive">{error}</p> : null}
      {created && error ? <p className="m-0 text-sm text-muted-foreground">Your recording is in the voice library. Try Save again to select it without another upload.</p> : null}
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" disabled={saving} onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={saving || !name.trim() || !audio}>{saving ? "Saving…" : "Save voice"}</Button>
      </div>
    </form>
  );
}

export function AddVoiceDialog({ onCreated }: { onCreated?: OnVoiceCreated }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving) setOpen(next); }}>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}><Mic data-icon="inline-start" /> Add my voice</Button>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-xl" showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>Add my voice</DialogTitle>
          <DialogDescription>Name your voice, then record a short passage or upload one recording.</DialogDescription>
        </DialogHeader>
        {open ? <VoiceCreateForm onCreated={onCreated} onCancel={() => setOpen(false)} onSaved={() => setOpen(false)} onSavingChange={setSaving} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function VoiceRowItem({ voice, sample }: { voice: VoiceRow; sample: boolean }) {
  const refresh = useRefresh();
  const [name, setName] = useState(voice.name);
  const [draft, setDraft] = useState(voice.name);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deletionIncomplete, setDeletionIncomplete] = useState(false);
  const retiring = deletionIncomplete || voice.status === "deleting";
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);

  async function rename(event: React.FormEvent) {
    event.preventDefault();
    const nextName = draft.trim();
    if (!nextName || nextName === name) return setRenameOpen(false);

    setSaving(true);
    try {
      const response = await fetch(`/api/tts/voices/${voice.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nextName }),
      });
      if (!response.ok) return toast.error((await response.json()).error ?? "Rename failed");
      setName(nextName);
      setRenameOpen(false);
      refresh();
      toast.success("Voice renamed");
    } catch {
      toast.error("Rename failed");
    } finally {
      setSaving(false);
    }
  }

  async function deleteVoice() {
    setDeleting(true);
    setDeleteError("");
    try {
      const response = await fetch(`/api/tts/voices/${voice.id}`, { method: "DELETE" });
      if (!response.ok) {
        const result: { error?: string; code?: string } = await response.json();
        if (result.code === "voice_delete_retryable") setDeletionIncomplete(true);
        throw new Error(result.error ?? "Delete failed");
      }
      stopPlayback();
      setDeleteOpen(false);
      setDeleted(true);
      refresh();
      toast.success("Voice deleted");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Delete failed";
      setDeleteError(message);
      toast.error(message);
    } finally {
      setDeleting(false);
    }
  }

  async function quickTest() {
    if (playing) {
      stopPlayback();
      setPlaying(false);
      return;
    }
    stopPlayback();
    setLoading(true);
    try {
      const response = await generateSpeech(voice.id, SAMPLE_SENTENCE);
      setPlaying(true);
      await playPcmStream(response);
      setPlaying(false);
    } catch (cause) {
      setPlaying(false);
      toast.error(cause instanceof Error ? cause.message : "Preview failed — is the TTS service running?");
    } finally {
      setLoading(false);
    }
  }

  if (deleted) return null;

  return (
    <li className="group flex items-center gap-4 px-4 py-4">
      <button
        type="button"
        onClick={quickTest}
        disabled={loading || deleting || retiring}
        aria-label={playing ? `Stop ${name}` : `Listen to ${name}`}
        className="grid size-11 shrink-0 place-items-center rounded-full bg-muted transition-colors hover:bg-foreground hover:text-background focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
      >
        {loading ? (
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        ) : playing ? (
          <Square className="size-4" aria-hidden="true" />
        ) : (
          <Play className="size-4" aria-hidden="true" />
        )}
      </button>
      <Link
        href={`/voice/${voice.id}`}
        aria-disabled={retiring || undefined}
        tabIndex={retiring ? -1 : undefined}
        onClick={(event) => { if (retiring) event.preventDefault(); }}
        className="min-w-0 flex-1 rounded-lg focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span className="block truncate text-sm font-medium capitalize">{name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {sample ? "Built-in sample voice" : `Cloned voice · ${new Date(voice.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`}
        </span>
      </Link>
      {!sample && (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${name}`} />}
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuItem disabled={retiring} onClick={() => { setDraft(name); setRenameOpen(true); }}>
                  <Pencil /> Rename
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => { setDeleteError(""); setDeleteOpen(true); }}>
                  <Trash2 /> {retiring ? "Retry delete" : "Delete"}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
            <DialogContent>
              <form onSubmit={rename} className="contents">
                <DialogHeader>
                  <DialogTitle>Rename voice</DialogTitle>
                  <DialogDescription>Choose a name you&apos;ll recognize in your voice library.</DialogDescription>
                </DialogHeader>
                <Field>
                  <FieldLabel htmlFor={`rename-${voice.id}`}>Voice name</FieldLabel>
                  <Input
                    id={`rename-${voice.id}`}
                    value={draft}
                    onChange={(event) => setDraft(event.currentTarget.value)}
                    maxLength={60}
                    autoFocus
                  />
                  <FieldDescription>Up to 60 characters.</FieldDescription>
                </Field>
                <DialogFooter>
                  <DialogClose render={<Button variant="outline" disabled={saving} />}>Cancel</DialogClose>
                  <Button type="submit" disabled={saving || !draft.trim()}>
                    {saving && <LoaderCircle data-icon="inline-start" className="animate-spin" />}
                    Save name
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>

          <AlertDialog
            open={deleteOpen}
            onOpenChange={(open) => {
              setDeleteOpen(open);
              if (!open) setDeleteConfirmation("");
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently deletes the voice and its reference recording. This action cannot be undone.
                  {" "}Voices used by a persona or saved session cannot be deleted.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <Field>
                <FieldLabel htmlFor={`delete-${voice.id}`}>
                  Type <span className="font-semibold text-foreground">{name}</span> to confirm
                </FieldLabel>
                <Input
                  id={`delete-${voice.id}`}
                  value={deleteConfirmation}
                  onChange={(event) => setDeleteConfirmation(event.currentTarget.value)}
                  autoComplete="off"
                  autoFocus
                />
                <FieldDescription>The name must match exactly.</FieldDescription>
              </Field>
              {deleteError ? <p role="alert" className="m-0 text-sm text-destructive">{deleteError}</p> : null}
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={deleteVoice}
                  disabled={deleting || deleteConfirmation !== name}
                >
                  {deleting ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Trash2 data-icon="inline-start" />}
                  {retiring ? "Retry delete" : "Delete voice"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
      {retiring && (
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">Removal incomplete</span>
      )}
    </li>
  );
}

function SampleEmptyState() {
  return (
    <div className="flex flex-col items-center py-14 text-center">
      <span className="grid size-12 place-items-center rounded-2xl bg-muted">
        <Mic className="size-5 text-muted-foreground" aria-hidden="true" />
      </span>
      <p className="mt-4 max-w-xs text-sm leading-6 text-muted-foreground">
        No sample voices available. Add a recording or upload to get started.
      </p>
    </div>
  );
}
