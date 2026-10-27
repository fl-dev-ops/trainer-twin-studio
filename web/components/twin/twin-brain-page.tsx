"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import {
  ArrowLeft, BookOpen, Camera, Check, FileText, HardDrive, LoaderCircle, Mic, Minus, Pause, Pencil, Play, Plus, Sparkles, Video,
} from "lucide-react";
import { toast } from "sonner";
import { generateSpeech, playPcmStream, stopPlayback } from "@/lib/audio-playback";
import { cn } from "@/lib/utils";

/** What the play button says in her cloned voice. */
const SAMPLE_LINE = "Hi, this is my twin. Tell me what is going on with your client, and I will help you with the next step.";

export type BrainKnowledge = {
  connectors: { id: string; kind: "drive" | "notion" | "youtube"; label: string; status: string }[];
  recent: { id: string; title: string }[];
  total: number;
};

/** Voice and avatar as set up on /twin/brain/voice and /twin/brain/avatar (null: the org has no own persona yet). */
export type BrainAvatar = { photoUrl: string | null; voiceId: string | null; voiceName: string | null; updatedAt: string | null } | null;

const CONNECTOR_ICONS = { drive: HardDrive, notion: BookOpen, youtube: Video };

// shortcut: training style and voice are mock content (UI only); replace with twin data when that backend lands.
const TRAITS = [
  "Frames selling as a process, not motivation",
  "Plays the difficult buyer herself before teaching the fix",
  "Gives word-for-word lines agents can use on the call",
];

const ZOOM = { min: 50, max: 150, step: 10 };

/** Coloured tag that sits above each node, like the reference canvas. */
function NodeTag({ tone, children }: { tone: "blue" | "amber" | "green"; children: ReactNode }) {
  const tones = {
    blue: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
    amber: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    green: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  };
  return <span className={cn("inline-flex h-7 items-center self-start rounded-full px-3 text-[13px] font-medium", tones[tone])}>{children}</span>;
}

function Node({ tag, tone, title, children, footer, className }: {
  tag: string; tone: "blue" | "amber" | "green"; title: string; children: ReactNode; footer?: ReactNode; className?: string;
}) {
  return (
    <section aria-label={title} className={cn("flex w-[340px] shrink-0 flex-col gap-3", className)}>
      <NodeTag tone={tone}>{tag}</NodeTag>
      <div className="flex flex-col gap-5 rounded-[16px] border border-(--card-border) bg-card p-5 shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]">
        <h2 className="m-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{title}</h2>
        {children}
        {footer ? <div className="flex flex-wrap gap-2 pt-1">{footer}</div> : null}
      </div>
    </section>
  );
}

/** Curved edge between two nodes, with the hollow port dots at each end. */
function Edge() {
  return (
    <svg viewBox="0 0 80 40" width={80} height={40} aria-hidden className="mt-24 shrink-0 self-start text-(--text-secondary)">
      <path d="M4 32 C 36 32, 44 8, 76 8" fill="none" stroke="currentColor" strokeWidth={1.25} />
      <circle cx="4" cy="32" r="3" className="fill-background" stroke="currentColor" strokeWidth={1.25} />
      <circle cx="76" cy="8" r="3" className="fill-background" stroke="currentColor" strokeWidth={1.25} />
    </svg>
  );
}

/** Twin's brain: the twin as a graph of what it knows, how it trains and how it sounds. */
export function TwinBrainPage({ knowledge, avatar }: { knowledge: BrainKnowledge; avatar: BrainAvatar }) {
  const [zoom, setZoom] = useState(100);
  const [playing, setPlaying] = useState(false);
  const [loadingVoice, setLoadingVoice] = useState(false);

  /** Her cloned voice saying one line (the voice service generates it); a second click stops it. */
  async function playVoice() {
    stopPlayback();
    if (playing || !avatar?.voiceId) return setPlaying(false);
    setLoadingVoice(true);
    try {
      const response = await generateSpeech(avatar.voiceId, SAMPLE_LINE);
      setPlaying(true);
      setLoadingVoice(false);
      await playPcmStream(response);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      // The voice service resolves voices through its own environment's web app: a voice only in this database is unknown there.
      toast.error(/\b404\b/.test(message) ? "The voice service doesn't have this voice yet (it only exists in this environment)." : message || "Couldn't play the voice.");
    } finally {
      setLoadingVoice(false);
      setPlaying(false);
    }
  }
  const zoomBy = (delta: number) => setZoom((value) => Math.min(ZOOM.max, Math.max(ZOOM.min, value + delta)));

  return (
    <div className="relative h-full w-full overflow-hidden bg-[radial-gradient(circle,var(--tone-control)_1px,transparent_1px)] bg-size-[20px_20px]">
      <header className="relative z-10 flex h-16 items-center justify-between gap-4 px-5">
        <Link href="/twin" className="inline-flex items-center gap-2 text-sm text-foreground transition-colors hover:text-muted-foreground">
          <ArrowLeft className="size-4" aria-hidden />
          Back
        </Link>
        <h1 className="m-0 text-sm font-normal text-muted-foreground">
          Twin’s brain <span aria-hidden>·</span> Last updated 2 days ago
        </h1>
        <Link
          href="/twin"
          className="inline-flex h-9 items-center rounded-full bg-(--brand) px-5 text-sm font-medium text-white transition-colors hover:bg-[#e04d00] dark:hover:bg-[#ff7e33]"
        >
          Done
        </Link>
      </header>

      <div className="absolute inset-0 top-16 overflow-auto">
        <div className="flex min-h-full min-w-max items-center justify-center p-12">
          <div
            className="flex origin-center items-start transition-transform duration-200 ease-out motion-reduce:transition-none"
            style={{ transform: `scale(${zoom / 100})` }}
          >
            <Node
              tag="Knowledge" tone="blue" title="Knowledge"
              footer={<EditLink href="/twin/knowledge" />}
            >
              {knowledge.connectors.length ? (
                <ul aria-label="Connected sources" className="m-0 flex list-none flex-col gap-2 p-0">
                  {knowledge.connectors.map((connector) => {
                    const Icon = CONNECTOR_ICONS[connector.kind];
                    return (
                      <li key={connector.id} className="flex items-center justify-between gap-3 rounded-[12px] bg-(--tone-control)/60 px-3 py-2.5 text-sm">
                        <span className="flex min-w-0 items-center gap-2.5"><Icon className="size-4 shrink-0" aria-hidden /><span className="truncate">{connector.label}</span></span>
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                          <Check className="size-3" aria-hidden /> {connector.status}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="m-0 rounded-[12px] bg-(--tone-control)/60 px-3 py-2.5 text-sm text-muted-foreground">No connectors yet. Connect Google Drive, Notion or YouTube from Edit.</p>
              )}
              <div className="flex flex-col gap-2.5">
                <p className="m-0 flex items-baseline justify-between gap-3 text-sm">
                  <span className="font-medium">Recent files</span>
                  <span className="tabular-nums text-muted-foreground">{knowledge.total} {knowledge.total === 1 ? "file" : "files"}</span>
                </p>
                {knowledge.recent.length ? (
                  <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
                    {knowledge.recent.map((file) => (
                      <li key={file.id} className="flex items-center gap-2.5">
                        <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="min-w-0 flex-1 truncate" title={file.title}>{file.title}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="m-0 text-sm text-muted-foreground">No files uploaded yet.</p>
                )}
              </div>
            </Node>

            <Edge />

            <Node
              tag="Training style" tone="amber" title="Training style"
            >
              <ul className="m-0 flex list-none flex-col gap-3 p-0 text-sm leading-5">
                {TRAITS.map((trait) => (
                  <li key={trait} className="flex gap-2">
                    <Sparkles className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                    {trait}
                  </li>
                ))}
              </ul>
            </Node>

            <Edge />

            <Node
              tag="Voice and avatar" tone="green" title="Voice and avatar"
              footer={
                <div className="flex gap-2">
                  <Link href="/twin/brain/voice" className={pill}><Mic className="size-4" aria-hidden /> Voice</Link>
                  <Link href="/twin/brain/avatar" className={pill}><Camera className="size-4" aria-hidden /> Avatar</Link>
                </div>
              }
            >
              <div className="flex flex-col items-center gap-2 text-center">
                {avatar?.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- same-site route redirecting to a signed S3 URL
                  <img src={avatar.photoUrl} alt="" className="size-16 rounded-full bg-(--tone-control) object-cover" />
                ) : (
                  <video
                    src="/media/twin-listening.mp4" autoPlay muted loop playsInline preload="metadata" aria-hidden
                    className="size-16 rounded-full bg-(--tone-control) object-cover object-[center_18%]"
                  />
                )}
                <p className="m-0 text-base font-semibold">{avatar?.voiceName ?? "Not set up yet"}</p>
                <p className="m-0 text-sm text-muted-foreground">
                  {avatar?.voiceName ? "Your voice · Recorded on camera" : "Record your voice and set up your avatar below"}
                </p>
                <div className="mt-1 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => void playVoice()}
                    disabled={!avatar?.voiceId || loadingVoice}
                    aria-label={playing ? "Pause voice sample" : "Play voice sample"}
                    aria-pressed={playing}
                    className="grid size-8 place-items-center rounded-full bg-(--tone-control) text-foreground transition-colors hover:bg-(--border) focus-visible:ring-2 focus-visible:ring-(--brand) outline-none"
                  >
                    {loadingVoice ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : playing ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
                  </button>
                  <Waveform playing={playing} />
                </div>
              </div>
            </Node>
          </div>
        </div>
      </div>

      <div className="absolute right-5 bottom-5 z-10 flex items-center gap-1 rounded-full border border-(--card-border) bg-card p-1 shadow-[0_2px_8px_rgb(30_28_25/0.08)]">
        <button type="button" onClick={() => zoomBy(-ZOOM.step)} disabled={zoom <= ZOOM.min} aria-label="Zoom out" className={zoomButton}>
          <Minus className="size-4" aria-hidden />
        </button>
        <button type="button" onClick={() => setZoom(100)} aria-label="Reset zoom" className="min-w-14 rounded-full px-1 text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-(--brand)">
          {zoom}%
        </button>
        <button type="button" onClick={() => zoomBy(ZOOM.step)} disabled={zoom >= ZOOM.max} aria-label="Zoom in" className={zoomButton}>
          <Plus className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

const pill = "inline-flex h-9 items-center gap-2 rounded-full border border-(--card-border) px-4 text-sm font-medium transition-colors hover:bg-(--tone-control) outline-none focus-visible:ring-2 focus-visible:ring-(--brand)";
const zoomButton = "grid size-8 place-items-center rounded-full transition-colors hover:bg-(--tone-control) disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-(--brand)";

function EditLink({ href }: { href: string }) {
  return <Link href={href} className={pill}><Pencil className="size-4" aria-hidden /> Edit</Link>;
}


/** Decorative voice bars; they pulse while the sample "plays". */
function Waveform({ playing }: { playing: boolean }) {
  const bars = [6, 14, 9, 18, 12, 20, 8, 15, 10];
  return (
    <span aria-hidden className="flex h-6 items-center gap-[3px]">
      {bars.map((height, index) => (
        <span
          key={index}
          className={cn("w-[3px] rounded-full bg-foreground/70", playing && "animate-pulse motion-reduce:animate-none")}
          style={{ height, animationDelay: `${index * 90}ms` }}
        />
      ))}
    </span>
  );
}
