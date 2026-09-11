import { notionAdapter } from "./notion/processor";
import { uploadAdapter } from "./upload/processor";
import type { IngestionAdapter, JobContext } from "./types";
import { youtubeAdapter } from "./youtube/processor";

const ADAPTER_BY_CONNECTOR: Record<JobContext["sourceConnector"], IngestionAdapter> = {
  upload: uploadAdapter,
  notion: notionAdapter,
  notion_public: notionAdapter,
  youtube: youtubeAdapter,
};

/** Resolves the connector-specific implementation behind the ingestion seam. */
export function ingestionAdapter(connector: JobContext["sourceConnector"]) {
  const adapter = ADAPTER_BY_CONNECTOR[connector];
  if (!adapter) {
    throw new Error(`Unsupported connector: ${connector}`);
  }
  return adapter;
}

export type { IngestionAdapter, JobContext, WorkItemContext } from "./types";
