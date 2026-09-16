/** Max learners assignable to a scenario in one request. Bump when bulk-send capacity grows. */
export const MAX_ASSIGNMENT_RECIPIENTS = 100;

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
