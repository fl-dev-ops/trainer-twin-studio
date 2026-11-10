import { randomBytes } from "node:crypto";

/** Max learners assignable to a scenario in one request. Bump when bulk-send capacity grows. */
export const MAX_ASSIGNMENT_RECIPIENTS = 100;
export const ASSIGNMENT_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export const newAssignmentShareCode = () => randomBytes(18).toString("base64url");
export const assignmentExpiresAt = () => new Date(Date.now() + ASSIGNMENT_LIFETIME_MS);

/** A role-play assignment is its member's own (specs/people.md: by account, never by email). */
export function assignmentMatchesUser(assignment: { member: { userId: string } }, user: { id: string }) {
  return assignment.member.userId === user.id;
}

export function assignmentChanges(currentIds: string[], requestedIds: string[]) {
  const current = new Set(currentIds);
  const requested = [...new Set(requestedIds)];
  const next = new Set(requested);
  return {
    requested,
    added: requested.filter((id) => !current.has(id)),
    removed: currentIds.filter((id) => !next.has(id)),
  };
}
