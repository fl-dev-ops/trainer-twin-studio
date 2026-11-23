/**
 * People added by email get an account before they ever sign in (lib/org-people.ts), named after their email's local
 * part. That name is a placeholder: it is replaced by the name Google gives at sign-in, or by the one the person types
 * when asked (components/name-prompt.tsx).
 */

export function emailPlaceholderName(email: string): string {
  return email.split("@")[0] || email;
}

/** Still the name made from the email (or empty), so it may be filled in from a better source. */
export function isPlaceholderName(name: string | null | undefined, email: string): boolean {
  const current = (name ?? "").trim();
  // shortcut: an exact email-derived name is indistinguishable from a chosen one without tracking confirmation.
  const normalizedEmail = email.toLowerCase();
  return !current || current === emailPlaceholderName(normalizedEmail) || current === normalizedEmail;
}

/**
 * The name and photo in a Google ID token. The token came straight from Google's token endpoint during sign-in, so its
 * claims are read without verifying the signature again. Returns {} for anything unreadable.
 */
export function googleProfile(idToken: string | null | undefined): { name?: string; picture?: string } {
  const payload = idToken?.split(".")[1];
  if (!payload) return {};
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const name = typeof claims.name === "string" && claims.name.trim() ? claims.name.trim().slice(0, 120) : undefined;
    const picture = typeof claims.picture === "string" && claims.picture.startsWith("https://") ? claims.picture : undefined;
    return { ...(name ? { name } : {}), ...(picture ? { picture } : {}) };
  } catch {
    return {};
  }
}
