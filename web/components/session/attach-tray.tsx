"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, Paperclip, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { duringUploadProblem } from "@/lib/context-upload";
import { attachedMessage, uploadFile } from "@/lib/upload-client";

/** Files a learner can hand the twin together, mid-call: the chat service reads at most 4 per message
 * (`MAX_FILES_PER_MESSAGE`, chat/agent/lib/uploads.ts), so a 5th would be dropped silently. */
export const MAX_ATTACH = 4;
/** How long the tray waits for another file before sending what it has (restarts with each file). */
const SEND_AFTER_MS = 15000;

type Staged = { key: string; name: string; doc?: { id: string; name: string } };

/** The twin's one message for several files: each file's marker, one per line (the chat service reads every one). */
export const stagedMessage = (docs: { id: string; name: string }[]) => docs.map((doc) => attachedMessage(doc)).join("\n");

/**
 * Mid-call files, staged before the twin sees them (as WhatsApp's preview tray): each is uploaded and linked to the
 * session as it's picked, then all of them go to the twin as one message, on Send or once no file has been added for
 * a few seconds. So the twin answers once, about all of them, instead of starting on the first while she adds more.
 */
export function useStagedAttachments({ sessionId, shareCode, onSend, onUploaded }: {
  /** Null while the call isn't live: nothing can be attached. */
  sessionId: string | null;
  shareCode?: string | null;
  onSend: (message: string) => Promise<void>;
  /** Each file once it's uploaded and linked (e.g. to show it as a card in the transcript). */
  onUploaded?: (doc: { id: string; name: string }, file: File) => void;
}) {
  const [files, setFiles] = useState<Staged[]>([]);
  const [sendAt, setSendAt] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  // The latest list, for the timer and the uploads that finish later.
  const filesRef = useRef(files);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  const restartTimer = () => {
    setSendAt(Date.now() + SEND_AFTER_MS);
    setSecondsLeft(SEND_AFTER_MS / 1000);
  };

  /** Sends every uploaded file as one message; waits while any is still uploading. */
  const send = useCallback(async () => {
    const staged = filesRef.current;
    if (staged.some((file) => !file.doc)) return;
    filesRef.current = [];
    setFiles([]);
    setSendAt(null);
    const docs = staged.flatMap((file) => (file.doc ? [file.doc] : []));
    if (!docs.length) return;
    await onSend(stagedMessage(docs));
    toast.success(docs.length === 1 ? `${docs[0].name} sent to your twin` : `${docs.length} files sent to your twin`);
  }, [onSend]);

  useEffect(() => {
    if (sendAt === null) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((sendAt - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0) void send(); // still uploading: tried again on the next tick
    };
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [sendAt, send]);

  const upload = async (key: string, file: File) => {
    try {
      const doc = await uploadFile(file, { purpose: "during", shareCode });
      const linked = await fetch(`/api/sessions/${encodeURIComponent(sessionId ?? "")}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: doc.id }),
      });
      const result = await linked.json().catch(() => null);
      if (!linked.ok) throw new Error(result?.error ?? "Could not attach the file");
      onUploaded?.({ id: doc.id, name: doc.name }, file);
      setFiles((prev) => prev.map((staged) => (staged.key === key ? { ...staged, doc: { id: doc.id, name: doc.name } } : staged)));
    } catch (error) {
      // Only this file: the others still go.
      toast.error(`${file.name}: ${error instanceof Error ? error.message : "Could not attach the file"}`);
      setFiles((prev) => prev.filter((staged) => staged.key !== key));
    }
  };

  /** Stages picked files (up to `MAX_ATTACH` waiting at once), each checked and uploaded on its own. */
  const add = (picked: File[]) => {
    if (!sessionId || !picked.length) return;
    const room = MAX_ATTACH - filesRef.current.length;
    if (picked.length > room) toast.error(`Up to ${MAX_ATTACH} files at a time`);
    const accepted = picked.slice(0, Math.max(0, room)).flatMap((file) => {
      const problem = duringUploadProblem(file);
      if (problem) {
        toast.error(`${file.name}: ${problem}`);
        return [];
      }
      return [{ key: crypto.randomUUID(), file }];
    });
    if (!accepted.length) return;
    setFiles((prev) => [...prev, ...accepted.map(({ key, file }) => ({ key, name: file.name }))]);
    restartTimer();
    for (const { key, file } of accepted) void upload(key, file);
  };

  const remove = (key: string) => {
    const rest = filesRef.current.filter((file) => file.key !== key);
    setFiles(rest);
    if (!rest.length) setSendAt(null);
  };

  return { files, secondsLeft, uploading: files.some((file) => !file.doc), add, remove, send };
}

/** The staged files above the call controls: each with ✕, "+ Add more", Send, and when they'll go on their own. */
export function AttachTray({ tray, onAddMore }: { tray: ReturnType<typeof useStagedAttachments>; onAddMore: () => void }) {
  if (!tray.files.length) return null;
  return (
    <div className="mx-3 mb-1 flex flex-col gap-1.5 rounded-xl border bg-card px-3 py-2 md:mx-6" role="region" aria-label="Files for your twin">
      <div className="flex flex-wrap items-center gap-2">
        {tray.files.map((file) => (
          <span key={file.key} className="flex items-center gap-1 rounded-full border bg-background py-0.5 pr-1 pl-2.5 text-xs">
            {file.doc ? <Paperclip className="size-3.5" aria-hidden /> : <LoaderCircle className="size-3.5 animate-spin" aria-hidden />}
            <span className="max-w-40 truncate">{file.name}</span>
            {/* 24px hit area: easy to tap on a phone, still compact on a laptop. */}
            <button type="button" aria-label={`Remove ${file.name}`} className="grid size-6 place-items-center rounded-full hover:bg-muted" onClick={() => tray.remove(file.key)}>
              <X className="size-3" />
            </button>
          </span>
        ))}
        {tray.files.length < MAX_ATTACH ? (
          <Button type="button" size="sm" variant="ghost" onClick={onAddMore}>
            <Plus /> Add more
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="strong" className="ml-auto" disabled={tray.uploading} onClick={() => void tray.send()}>
          Send to twin
        </Button>
      </div>
      <p className="m-0 text-xs text-muted-foreground" aria-live="polite">
        {tray.uploading ? "Uploading…" : `Sending to your twin in ${tray.secondsLeft}s`}
      </p>
    </div>
  );
}
