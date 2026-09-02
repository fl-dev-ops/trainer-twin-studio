import { NotionCleaner } from "./notion";
import { YoutubeCleaner } from "./youtube";

export type SourceType = "notion" | "youtube";
export interface SourceCleaner {
  clean(rawText: string): string;
}

/** Select source-specific cleanup; acquisition remains outside the cleaner. */
export function createSourceCleaner(source: SourceType): SourceCleaner {
  switch (source) {
    case "notion": return new NotionCleaner();
    case "youtube": return new YoutubeCleaner();
    default: throw new Error("Unsupported source cleaner type");
  }
}
