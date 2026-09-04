import type { Pool } from "pg";
import type { PipelineConfig } from "../config";

export type JobContext = {
  jobId: string;
  sourceId: string;
  orgId: string;
  kbId: string;
  kbSlug: string;
  status: string;
  sourceConnector: "notion" | "notion_public" | "youtube";
  accessTokenCiphertext: string | null;
  youtubeConnectionId: string | null;
  connectionUserId: string | null;
  externalId: string;
};

export type WorkItemContext = {
  id: string;
  workKey: string;
  parentWorkItemId: string | null;
  parentWorkKey: string | null;
  kind: string;
  payload: unknown;
};

export interface IngestionAdapter {
  process(pool: Pool, config: PipelineConfig, job: JobContext, workItem: WorkItemContext): Promise<void>;
}
