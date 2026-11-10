"use client";

import { toast } from "sonner";
import type { EmailProgress } from "@/workflows/assignment-emails";

/**
 * Follows an assignment's invite emails (workflows/assignment-emails.ts) in one toast: "Sending… 2 of 5", then sent,
 * or the addresses that still failed after retries. The people are already assigned; this is only their emails.
 */
export async function followEmailProgress(token: string, total: number) {
  const plural = (n: number) => `${n} invite email${n === 1 ? "" : "s"}`;
  const id = toast.loading(`Sending ${plural(total)}…`);
  let sent = 0;
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(token)}`);
    if (!response.ok || !response.body) throw new Error(`progress ${response.status}`);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const event = JSON.parse(line) as EmailProgress;
        if (event.status === "sent") toast.loading(`Sending invite emails… ${++sent} of ${total}`, { id });
        if (event.status === "done") {
          if (event.failed.length) {
            // A new toast (not an update of the loading one), so it keeps its own, longer life.
            toast.dismiss(id);
            const sentPart = event.sent ? `${plural(event.sent)} sent. ` : "";
            toast.warning(`${sentPart}Couldn't send the invite email to ${event.failed.join(", ")}.`, { duration: 15_000 });
          } else toast.success(`${plural(event.sent)} sent`, { id });
          return;
        }
      }
    }
    toast.dismiss(id);
  } catch {
    toast.info("The invite emails are going out in the background.", { id });
  }
}
