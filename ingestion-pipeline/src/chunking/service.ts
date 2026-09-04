import { prepareNotionDocument } from "../adapters/notion/chunking";
import { YoutubeCleaner } from "../adapters/youtube/cleaner";
import { YoutubeChunker, YOUTUBE_CHUNKING_VERSION, type TranscriptInput } from "../adapters/youtube/chunking/youtube";
import { CHUNKING_VERSION, prepareMarkdown, type PreparedDocument } from "./markdown";

export type ChunkingResult = PreparedDocument & { sourceText: string; chunkingVersion: string };

/** Single provider dispatcher for ingestion and chunking. */
export class ChunkingService {
  async prepare(provider: string, input: TranscriptInput): Promise<ChunkingResult> {
    switch (provider) {
      case "notion": {
        if (typeof input.text !== "string" || input.segments !== undefined) {
          throw new Error("Notion chunking requires Markdown text, not timed transcript segments");
        }
        return prepareNotionDocument(input.text, input.pageTitle);
      }
      case "markdown": {
        if (typeof input.text !== "string" || input.segments !== undefined) {
          throw new Error("Markdown chunking requires text, not timed transcript segments");
        }
        return { ...prepareMarkdown(input.text, input.pageTitle), sourceText: input.text, chunkingVersion: CHUNKING_VERSION };
      }
      case "youtube": {
        const prepared = await new YoutubeChunker(new YoutubeCleaner()).chunk(input);
        return { ...prepared, chunkingVersion: YOUTUBE_CHUNKING_VERSION };
      }
      default:
        throw new Error(`Unsupported chunking provider: ${provider}`);
    }
  }
}
