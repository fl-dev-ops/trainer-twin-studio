import { YouTubeError, type TranscriptSegment } from "./types";

function decodeText(text: string) {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/<[^>]*>/g, "").replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
    if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? match;
    const point = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
  }).replace(/\s+/g, " ").trim();
}

function seconds(value: string) {
  const parts = value.replace(",", ".").split(":").map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/** Parses the official SRT export while retaining cue start and end times. */
export function parseCaptionSrt(srt: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  for (const block of srt.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((line) => /^\d+:\d{2}:\d{2}[,.]\d+\s+-->/.test(line));
    if (at < 0) continue;
    const timing = lines[at].match(/^(\d+:\d{2}:\d{2}[,.]\d+)\s+-->\s+(\d+:\d{2}:\d{2}[,.]\d+)/);
    if (!timing) continue;
    const startSeconds = seconds(timing[1]);
    const endSeconds = seconds(timing[2]);
    const text = decodeText(lines.slice(at + 1).join(" "));
    if (!text) continue;
    if (!Number.isFinite(startSeconds) || endSeconds < startSeconds || startSeconds < (segments.at(-1)?.startSeconds ?? 0)) {
      throw new YouTubeError("INVALID_CAPTIONS", "YouTube returned invalid caption timestamps");
    }
    segments.push({ text, startSeconds, endSeconds });
  }
  if (!segments.length) throw new YouTubeError("EMPTY_CAPTIONS", "English caption track contains no usable text");
  return segments;
}

export function transcriptTimestamp(value: number) {
  const whole = Math.floor(value);
  const parts = [Math.floor(whole / 60) % 60, whole % 60];
  if (whole >= 3600) parts.unshift(Math.floor(whole / 3600));
  return parts.map((part) => String(part).padStart(2, "0")).join(":");
}

export function transcriptLine(segment: TranscriptSegment) {
  return `[${transcriptTimestamp(segment.startSeconds)}] - ${segment.text.replace(/[\r\n]+/g, " ").trim()}`;
}

/** Stores only readable start timestamps and spoken text; exact ranges stay in the private JSON artifact. */
export function transcriptMarkdown(segments: TranscriptSegment[]) {
  return segments.map(transcriptLine).join("\n");
}

export function segmentsFromMarkdown(markdown: string): TranscriptSegment[] {
  const legacy = [...markdown.matchAll(/<!-- cue:([\d.]+),([\d.]+) -->\n\[[^\]]+\]\([^\n]+?\) (.*)/g)].map((match) => ({
    startSeconds: Number(match[1]), endSeconds: Number(match[2]), text: match[3].replace(/\\([\\`*_{}\[\]<>#])/g, "$1"),
  }));
  if (legacy.length) return legacy;
  const parsed = [...markdown.matchAll(/^\[((?:\d+:)?\d{2}:\d{2})\] - (.+)$/gm)].map((match) => ({
    startSeconds: seconds(match[1]), text: match[2].trim(),
  }));
  return parsed.map((segment, index) => ({
    ...segment,
    endSeconds: parsed[index + 1]?.startSeconds ?? segment.startSeconds + 1,
  }));
}
