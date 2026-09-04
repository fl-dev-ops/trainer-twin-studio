import { notionAdapter } from "./notion/processor";
import type { IngestionAdapter, JobContext } from "./types";
import { youtubeAdapter } from "./youtube/processor";

const ADAPTER_BY_CONNECTOR: Record<JobContext["sourceConnector"], IngestionAdapter> = {
  notion: notionAdapter,
  notion_public: notionAdapter,
  youtube: youtubeAdapter,
};

/** Resolves the connector-specific implementation behind the ingestion seam. */
export function ingestionAdapter(connector: JobContext["sourceConnector"]) {
  return ADAPTER_BY_CONNECTOR[connector];
}

export type { IngestionAdapter, JobContext, WorkItemContext } from "./types";
