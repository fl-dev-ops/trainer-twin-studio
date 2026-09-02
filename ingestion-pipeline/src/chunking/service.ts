import { createSourceCleaner } from "../cleaners/factory";
import { CHUNKING_VERSION, prepareMarkdown, type PreparedDocument } from "./markdown";
import { YoutubeChunker, YOUTUBE_CHUNKING_VERSION, type TranscriptInput } from "./youtube";

export type ChunkingResult = PreparedDocument & { sourceText: string; chunkingVersion: string };

/** Single provider dispatcher for ingestion and chunking. */
export class ChunkingService {
  async prepare(provider: string, input: TranscriptInput): Promise<ChunkingResult> {
    switch (provider) {
      case "notion":
      case "markdown": {
        if (typeof input.text !== "string" || input.segments !== undefined) {
          throw new Error("Markdown chunking requires text, not timed transcript segments");
        }
        const sourceText = provider === "notion" ? createSourceCleaner("notion").clean(input.text) : input.text;
        return { ...prepareMarkdown(sourceText, input.pageTitle), sourceText, chunkingVersion: CHUNKING_VERSION };
      }
      case "youtube": {
        const prepared = await new YoutubeChunker(createSourceCleaner("youtube")).chunk(input);
        return { ...prepared, chunkingVersion: YOUTUBE_CHUNKING_VERSION };
      }
      default:
        throw new Error(`Unsupported chunking provider: ${provider}`);
    }
  }
}
