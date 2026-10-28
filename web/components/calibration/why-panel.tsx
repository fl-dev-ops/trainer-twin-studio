"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ExternalLink, FileSearch, FileText, LoaderCircle, Video, X } from "lucide-react";
import { SOFT_SHADOW } from "@/components/calibration/parts";
import { twinClient } from "@/lib/twin/client";
import type { TurnEvidence } from "@/lib/twin/evidence";
import { cn } from "@/lib/utils";

const SHOWN = 5;
const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The turn whose reply this bubble shows (the bubble is the spoken transcript, so match on the start of the text). */
export function evidenceFor(turns: TurnEvidence[], bubble: string): TurnEvidence | null {
  const said = norm(bubble);
  if (!said) return null;
  const head = (text: string) => text.slice(0, 40);
  for (let i = turns.length - 1; i >= 0; i--) {
    const reply = norm(turns[i].reply);
    if (reply && (reply.startsWith(head(said)) || said.startsWith(head(reply)))) return turns[i];
  }
  return null;
}

/** The 🔍 beside a twin reply that opens its "Why this answer". */
export function WhyButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="Why did the twin say this?"
      title="Why this answer?"
      aria-pressed={open}
      onClick={onClick}
      className={cn("mt-1 grid size-8 shrink-0 place-items-center rounded-full ring-1 ring-border hover:bg-muted", open && "bg-muted")}
    >
      <FileSearch className="size-4" aria-hidden />
    </button>
  );
}

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : null);

/** "Why this answer" for one twin reply: what it heard, what it looked up, and the moments from the trainer's sessions. */
export function WhyPanel({ sessionId, reply, onClose }: { sessionId: string; reply: string; onClose: () => void }) {
  const [turn, setTurn] = useState<TurnEvidence | null | undefined>(undefined);
  const [open, setOpen] = useState<number | null>(0);
  const [shown, setShown] = useState(SHOWN);

  useEffect(() => {
    let live = true;
    // Evidence is posted just after the reply, so ask again once if it isn't there yet.
    const load = async (retry: boolean) => {
      const turns = await twinClient.calibrations.evidence.query({ sessionId }).catch(() => []);
      const found = evidenceFor(turns, reply);
      if (!live) return;
      if (found || !retry) setTurn(found);
      else setTimeout(() => void load(false), 1500);
    };
    void load(true);
    return () => {
      live = false;
    };
  }, [sessionId, reply]);

  return (
    <div role="dialog" aria-label="Why this answer" className={cn("fixed right-6 bottom-28 z-30 flex max-h-[70dvh] w-[380px] max-w-[calc(100vw-3rem)] flex-col gap-4 overflow-y-auto rounded-3xl bg-card p-6", SOFT_SHADOW)}>
      <div className="flex items-start justify-between">
        <span className={cn("grid size-12 place-items-center rounded-2xl bg-card ring-1 ring-border", SOFT_SHADOW)}>
          <FileSearch className="size-5" aria-hidden />
        </span>
        <button type="button" onClick={onClose} aria-label="Close" className="grid size-8 place-items-center rounded-full ring-1 ring-border hover:bg-muted">
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <h2 className="m-0 text-xl leading-7 font-semibold tracking-[-0.015em]">Why this answer</h2>

      {turn === undefined ? (
        <p className="m-0 flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden /> Looking up this reply&hellip;
        </p>
      ) : turn === null ? (
        <p className="m-0 text-sm text-muted-foreground">No evidence was recorded for this reply.</p>
      ) : (
        <>
          <p className="m-0 text-sm leading-6">
            <span className="font-medium">Heard: </span>
            {turn.opening ? "The start of the call" : turn.heard || "\u2014"}
          </p>
          <p className="m-0 text-sm leading-6">
            <span className="font-medium">Searched: </span>
            {turn.searches.length
              ? turn.searches.map((s) => `${s.label}${s.query ? ` for \u201c${s.query}\u201d` : ""}${s.label === "skill" ? "" : ` (${s.found} found)`}`).join(" \u00b7 ")
              : "Nothing: this came from the twin\u2019s skills and persona."}
          </p>

          {turn.moments.length ? (
            <>
              <h3 className="m-0 flex items-center gap-2 text-sm font-medium">
                Moments from your sessions
                <span className="rounded-full bg-muted px-2 text-xs tabular-nums">{turn.moments.length}</span>
              </h3>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {turn.moments.slice(0, shown).map((moment, i) => {
                  const isOpen = open === i;
                  const Icon = moment.source?.kind === "document" ? FileText : Video;
                  const meta = [moment.source?.title, day(moment.source?.date ?? null)].filter(Boolean).join(" \u00b7 ");
                  return (
                    <li key={i} className="rounded-2xl bg-muted">
                      <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : i)} className="flex w-full items-start gap-3 p-3 text-left">
                        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-card ring-1 ring-border">
                          <Icon className="size-4" aria-hidden />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="text-sm font-medium">{moment.context ?? moment.source?.title ?? "A moment from your sessions"}</span>
                          {meta ? <span className="text-xs text-muted-foreground">{meta}</span> : null}
                        </span>
                        <ChevronDown className={cn("mt-1 size-4 shrink-0 transition-transform", isOpen && "rotate-180")} aria-hidden />
                      </button>
                      {isOpen ? (
                        <div className="flex flex-col gap-2 px-3 pb-3">
                          <p className="m-0 text-sm leading-6 text-muted-foreground">&ldquo;{moment.text}&rdquo;</p>
                          {moment.source?.url ? (
                            <a href={moment.source.url} target="_blank" rel="noreferrer" className="inline-flex w-fit items-center gap-1 text-xs font-medium hover:underline">
                              Open the source <ExternalLink className="size-3" aria-hidden />
                            </a>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {turn.moments.length > shown ? (
                <button type="button" onClick={() => setShown(turn.moments.length)} className="w-fit text-sm font-medium hover:underline">
                  Show {turn.moments.length - shown} more
                </button>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
