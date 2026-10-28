/** Cleanup contract implemented independently by each ingestion adapter. */
export interface SourceCleaner {
  clean(rawText: string): string;
}
