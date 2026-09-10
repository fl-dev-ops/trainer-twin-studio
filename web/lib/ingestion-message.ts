import { z } from "zod";

/** Identifier-only SQS payload; all connector instructions stay in PostgreSQL. */
export const ingestionMessageSchema = z
  .object({
    jobId: z.string().min(1),
    workItemId: z.string().min(1),
  })
  .strict();

export type IngestionMessage = z.infer<typeof ingestionMessageSchema>;
