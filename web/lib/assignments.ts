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
