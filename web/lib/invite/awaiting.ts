/** Someone given a twin or role play by email who hasn't joined the org yet (no account / not a member). */
export type AwaitingUser = { email: string; assigned: string[] };

/**
 * People assigned by email (twin assignments, role-play assignments) who aren't members or org invitations yet: the
 * assign dialogs email them a personal link, and they join the org when they open it and sign in. Grouped by email,
 * with what they were given; newest first as passed in.
 */
export function awaitingUsers(input: {
  memberEmails: string[];
  invitedEmails: string[];
  assignments: { email: string; title: string }[];
}): AwaitingUser[] {
  const known = new Set([...input.memberEmails, ...input.invitedEmails].map((email) => email.toLowerCase()));
  const byEmail = new Map<string, AwaitingUser>();
  for (const { email, title } of input.assignments) {
    const key = email.trim().toLowerCase();
    if (!key || known.has(key)) continue;
    const row = byEmail.get(key) ?? { email: key, assigned: [] };
    if (!row.assigned.includes(title)) row.assigned.push(title);
    byEmail.set(key, row);
  }
  return [...byEmail.values()];
}
