/**
 * "What was off?" on a card marked Feels off: one tap per thing that was wrong, each a bucket of the twin quality
 * methodology and, later, one place in the skill its fix goes (her answer is the fix). Stored as these codes;
 * answers marked before them keep their old labels.
 */
export const OFF_REASONS = [
  { code: "advice", label: "The advice" }, // method adherence: rules, decision and approach moments
  { code: "facts", label: "The facts" }, // factual accuracy: knowledge moments, a gap in her material
  { code: "style", label: "How it's said" }, // persona adherence: phrasing moments, style samples
  { code: "scope", label: "Out of scope" }, // should have said "ask me": the topic's scope line
] as const;

export type OffReason = (typeof OFF_REASONS)[number]["code"];

export const isOffReason = (code: string): code is OffReason => OFF_REASONS.some((reason) => reason.code === code);

/** A stored reason as shown: a code's label, or an older answer's own label as it was saved. */
export const offReasonLabel = (reason: string) => OFF_REASONS.find((r) => r.code === reason)?.label ?? reason;
