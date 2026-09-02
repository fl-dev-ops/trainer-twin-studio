/** Clean already-acquired plain transcripts without removing spoken content. */
export class YoutubeCleaner {
  clean(rawText: string): string {
    return rawText.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
}
