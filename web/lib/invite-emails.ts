const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_INVITES = 50;

/** Splits a pasted list (commas, semicolons, spaces or new lines), lower-cases, de-duplicates, and separates invalid entries. */
export function parseInviteEmails(raw: string): { emails: string[]; invalid: string[] } {
  const parts = [...new Set(raw.split(/[\s,;]+/).map((part) => part.trim().toLowerCase()).filter(Boolean))];
  return { emails: parts.filter((part) => EMAIL_RE.test(part)), invalid: parts.filter((part) => !EMAIL_RE.test(part)) };
}
