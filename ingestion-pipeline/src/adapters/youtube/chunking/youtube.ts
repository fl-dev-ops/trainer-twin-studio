import { transcriptLine } from "../../../../../shared/youtube/captions";
import type { SourceCleaner } from "../../source-cleaner";
import type { PreparedChunk, PreparedDocument } from "../../../chunking/markdown";

export const YOUTUBE_CHUNKING_VERSION = "youtube-timestamped-1200-1800-v2";
const TARGET_CHUNK_CHARS = 1200;
const MAX_CHUNK_CHARS = 1800;

export type TranscriptSegment = { text: string; startSeconds: number; endSeconds: number };
export type TranscriptInput = { pageTitle?: string } & (
  | { text: string; segments?: never }
  | { segments: TranscriptSegment[]; text?: never }
);
type Unit = { text: string; startSeconds?: number; endSeconds?: number };

/** Groups adjacent transcript cues into readable timestamped retrieval passages. */
export class YoutubeChunker {
  constructor(private readonly cleaner: SourceCleaner) {}

  async chunk(input: TranscriptInput): Promise<PreparedDocument & { sourceText: string }> {
    const startedAt = Date.now();
    console.info("[JOB:youtube-chunking] start");
    try {
      const pageTitle = (input.pageTitle ?? "").trim().replace(/\s+/g, " ");
      const units = this.prepareUnits(input);
      const sections: PreparedDocument["sections"] = [];
      const chunks: PreparedChunk[] = [];
      let current: PreparedChunk | undefined;
      const flush = () => {
        if (!current) return;
        chunks.push(current);
        sections.push({ id: current.sectionIds[0], headingPath: [], text: current.text });
        current = undefined;
      };
      for (const unit of units) {
        if (current && (current.text.length >= TARGET_CHUNK_CHARS
          || current.text.length + 1 + unit.text.length > MAX_CHUNK_CHARS)) flush();
        if (!current) {
          current = { text: unit.text, sectionIds: [`s${sections.length}`], topics: [] };
          if (unit.startSeconds !== undefined) {
            current.startSeconds = unit.startSeconds;
            current.endSeconds = unit.endSeconds;
          }
        } else {
          current.text += `\n${unit.text}`;
          if (unit.endSeconds !== undefined) current.endSeconds = Math.max(current.endSeconds!, unit.endSeconds);
        }
      }
      flush();
      const sourceText = units.map((unit) => unit.text).join("\n");
      console.info(`[JOB:youtube-chunking] complete units=${units.length} chunks=${chunks.length} elapsedMs=${Date.now() - startedAt}`);
      return { pageTitle, sourceText, sections, chunks };
    } catch (error) {
      console.error(`[JOB:youtube-chunking] failed elapsedMs=${Date.now() - startedAt} error=${error instanceof Error ? error.name : "UnknownError"}`);
      throw error;
    }
  }

  private prepareUnits(input: TranscriptInput): Unit[] {
    if (input.segments === undefined) {
      if (typeof input.text !== "string") throw new Error("Transcript text is required");
      return this.splitUnit({ text: this.cleaner.clean(input.text) });
    }
    if (input.text !== undefined || !Array.isArray(input.segments)) throw new Error("Supply text or timed segments, not both");
    let previousStart = -1;
    return input.segments.flatMap((segment) => {
      if (typeof segment?.text !== "string" || !Number.isFinite(segment.startSeconds)
        || !Number.isFinite(segment.endSeconds) || segment.startSeconds < 0
        || segment.endSeconds < segment.startSeconds || segment.startSeconds < previousStart) {
        throw new Error("Transcript segments require ordered, nonnegative time ranges");
      }
      previousStart = segment.startSeconds;
      const cleaned = { ...segment, text: this.cleaner.clean(segment.text) };
      return cleaned.text ? this.splitUnit({ ...cleaned, text: transcriptLine(cleaned) }) : [];
    });
  }

  private splitUnit(unit: Unit): Unit[] {
    const pieces: Unit[] = [];
    let text = unit.text.trim();
    while (text.length > MAX_CHUNK_CHARS) {
      const space = text.lastIndexOf(" ", MAX_CHUNK_CHARS);
      const cut = space > MAX_CHUNK_CHARS / 2 ? space : MAX_CHUNK_CHARS;
      pieces.push({ ...unit, text: text.slice(0, cut).trim() });
      text = text.slice(cut).trim();
    }
    if (text) pieces.push({ ...unit, text });
    return pieces;
  }
}
