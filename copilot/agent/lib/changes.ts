import { z } from "zod";

/** One line per changed field, for an approval card: `key → value` (long values cut). */
export function describeChanges(
  fields: Record<string, unknown> | undefined,
  label: (key: string) => string = (key) => key,
  proposed: readonly string[] = [],
): string {
  return Object.entries(fields ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const text = typeof value === "boolean" ? (value ? "on" : "off") : JSON.stringify(value);
      const mark = proposed.includes(key) ? " (suggested)" : "";
      return `${label(key)} → ${text.length > 140 ? `${text.slice(0, 140)}…` : text}${mark}`;
    })
    .join("; ");
}


/** Fields the copilot filled in itself; the card marks them "(suggested)" so the trainer approves them knowingly. */
export const proposedInput = z.array(z.string()).optional().describe(
  "Names of the fields you filled in yourself because the trainer didn't give them (e.g. uploadTitle, voiceId). The card marks them as suggested.",
);
