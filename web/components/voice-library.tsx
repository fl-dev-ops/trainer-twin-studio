"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, Mic, MoreHorizontal, Pencil, Play, Search, Sparkles, Square, Trash2 } from "lucide-react";
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
import { generateSpeech, playPcmStream, stopPlayback } from "@/lib/audio-playback";

export type VoiceRow = {
  id: string;
  name: string;
  kind: string;
  status: string;
  createdAt: string;
};

const SAMPLE_SENTENCE = "Hi, this is a quick test of my voice. Let us begin today's session.";

export function VoiceLibrary({ mine, samples }: { mine: VoiceRow[]; samples: VoiceRow[] }) {
  return (
    <Tabs defaultValue={mine.length ? "my" : "explore"} className="mt-6" >
      <TabsList variant="line">
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
                You haven&apos;t cloned a voice yet. Read a short passage aloud and it&apos;s ready for any scenario.
              </p>
              <Button className="mt-5" size="sm" render={<Link href="/voice/cloning" />} nativeButton={false}>
                <Mic data-icon="inline-start" /> Start cloning
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
        <div className="relative w-full max-w-xs">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search"
            className="pl-9"
            aria-label="Search voices"
          />
        </div>
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

function VoiceRowItem({ voice, sample }: { voice: VoiceRow; sample: boolean }) {
  const router = useRouter();
  const [name, setName] = useState(voice.name);
  const [draft, setDraft] = useState(voice.name);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
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
      router.refresh();
      toast.success("Voice renamed");
    } catch {
      toast.error("Rename failed");
    } finally {
      setSaving(false);
    }
  }

  async function deleteVoice() {
    setDeleting(true);
    try {
      const response = await fetch(`/api/tts/voices/${voice.id}`, { method: "DELETE" });
      if (!response.ok) return toast.error((await response.json()).error ?? "Delete failed");
      stopPlayback();
      setDeleteOpen(false);
      setDeleted(true);
      router.refresh();
      toast.success("Voice deleted");
    } catch {
      toast.error("Delete failed");
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
        disabled={loading}
        aria-label={playing ? `Stop preview of ${name}` : `Preview ${name}`}
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
                <DropdownMenuItem onClick={() => { setDraft(name); setRenameOpen(true); }}>
                  <Pencil /> Rename
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
                  <Trash2 /> Delete
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
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={deleteVoice}
                  disabled={deleting || deleteConfirmation !== name}
                >
                  {deleting ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Trash2 data-icon="inline-start" />}
                  Delete voice
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
      {voice.status !== "ready" && (
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{voice.status}</span>
      )}
    </li>
  );
}

function SampleEmptyState() {
  return (
    <div className="flex flex-col items-center py-14 text-center">
      <span className="grid size-12 place-items-center rounded-2xl bg-muted">
        <Sparkles className="size-5 text-muted-foreground" aria-hidden="true" />
      </span>
      <p className="mt-4 max-w-xs text-sm leading-6 text-muted-foreground">
        No sample voices yet. Clone your own to get started.
      </p>
    </div>
  );
}
