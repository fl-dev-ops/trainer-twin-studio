import { z } from "zod";

/** Field names as a trainer reads them on a card: `voiceId` is "voice", `uploadTitle` is "upload title". */
const FIELD_NAMES: Record<string, string> = { voiceId: "voice", voiceLabel: "voice", personaSlug: "persona", maxSeconds: "time limit (seconds)" };
export function fieldName(key: string): string {
  return FIELD_NAMES[key] ?? key.replace(/Id$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
}

/** The fields the copilot filled in itself, named for the trainer: "voice, upload title". */
export const suggestedNames = (proposed: readonly string[] = []) => [...new Set(proposed.map(fieldName))].join(", ");

/**
 * One line per changed field, for an approval card: `name → value` (long values cut, "(suggested)" on the ones the
 * copilot filled in). Lines are separated by newlines: the studio shows each as a row.
 */
export function describeChanges(
  fields: Record<string, unknown> | undefined,
  label: (key: string) => string = fieldName,
  proposed: readonly string[] = [],
): string {
  const lines = Object.entries(fields ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const text = typeof value === "boolean" ? (value ? "on" : "off") : typeof value === "string" ? value : JSON.stringify(value);
      const flat = text.replace(/\s+/g, " ").trim() || "(empty)";
      const mark = proposed.includes(key) ? " (suggested)" : "";
      return `${label(key)} → ${flat.length > 140 ? `${flat.slice(0, 140)}…` : flat}${mark}`;
    });
  return lines.length ? `\n${lines.join("\n")}` : "";
}

/** Fields the copilot filled in itself; the card marks them "(suggested)" so the trainer approves them knowingly. */
export const proposedInput = z.array(z.string()).optional().describe(
  "Names of the fields you filled in yourself because the trainer didn't give them (e.g. uploadTitle, voiceId). The card marks them as suggested.",
);
