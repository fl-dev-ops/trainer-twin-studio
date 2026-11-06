import { z } from "zod";

/** Identifier-only SQS payload; all connector instructions stay in PostgreSQL. */
export const ingestionMessageSchema = z
  .object({
    jobId: z.string().min(1),
    workItemId: z.string().min(1),
  })
  .strict();

export type IngestionMessage = z.infer<typeof ingestionMessageSchema>;

/**
 * One uploaded knowledge file for the Python worker (ingestion/). The worker has no S3, Postgres or
 * Chroma access, so the message carries a signed GET URL; results come back to /api/internal/ingestion/results.
 */
export const knowledgeFileMessageSchema = z
  .object({
    docId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    orgId: z.string().min(1),
    kbId: z.string().min(1),
    filename: z.string().min(1),
    sourceUrl: z.string().url().startsWith("https://"),
  })
  .strict();

export type KnowledgeFileMessage = z.infer<typeof knowledgeFileMessageSchema>;
