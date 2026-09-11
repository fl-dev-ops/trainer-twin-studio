export type IngestionMessage = { jobId: string; workItemId: string };

export function identifierOnlyMessage(input: IngestionMessage): string {
  return JSON.stringify({ jobId: input.jobId, workItemId: input.workItemId });
}

/** Validates the exact identifier-only SQS payload without loading infrastructure clients. */
export function parseQueueMessage(body: string): IngestionMessage {
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid ingestion message");
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "jobId,workItemId") throw new Error("Invalid ingestion message fields");
  if (typeof value.jobId !== "string" || typeof value.workItemId !== "string" || !value.jobId || !value.workItemId) {
    throw new Error("Invalid ingestion message identifiers");
  }
  return { jobId: value.jobId, workItemId: value.workItemId };
}
