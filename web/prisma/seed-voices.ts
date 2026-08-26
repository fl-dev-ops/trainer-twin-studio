/** Seeds the built-in sample voices from data/voices/*.wav (+ matching .txt transcripts).
 *  Idempotent: re-running updates the S3 objects and bumps updatedAt (new cache version). */

import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../lib/generated/prisma/client";
import { putObject, voicePrefix } from "../lib/s3";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "postgresql://suryaumapathy@localhost:5432/trainertwin?schema=public" }),
});
const VOICES_DIR = path.join(import.meta.dirname, "../data/voices");

async function main() {
  const files = (await fs.readdir(VOICES_DIR)).filter((f) => f.endsWith(".wav"));
  for (const file of files) {
    const name = file.replace(/\.wav$/, "");
    const transcript = (await fs.readFile(path.join(VOICES_DIR, `${name}.txt`), "utf-8")).trim();
    const audio = new Uint8Array(await fs.readFile(path.join(VOICES_DIR, file)));

    const existing = await prisma.voice.findFirst({ where: { name, kind: "sample" } });
    const prefix = voicePrefix(existing?.id ?? `${name}-sample`);
    await putObject(`${prefix}/reference.wav`, audio, "audio/wav");
    await putObject(`${prefix}/transcript.txt`, transcript, "text/plain");

    const voice = await prisma.voice.upsert({
      where: { id: existing?.id ?? `${name}-sample` },
      update: { s3AudioKey: `${prefix}/reference.wav`, s3TranscriptKey: `${prefix}/transcript.txt` },
      create: {
        id: `${name}-sample`,
        name,
        kind: "sample",
        s3AudioKey: `${prefix}/reference.wav`,
        s3TranscriptKey: `${prefix}/transcript.txt`,
      },
    });
    console.log(`seeded sample voice ${voice.name} (${voice.id})`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
