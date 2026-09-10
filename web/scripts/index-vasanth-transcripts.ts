import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import type { Prisma } from "../lib/generated/prisma/client";
import { db } from "../lib/db";
import { MainCollectionService } from "../lib/main-collection";
import { extractPersonaVoiceMoments } from "../lib/persona-voice";

const TRANSCRIPT_DIR =
  process.env.VASANTH_TRANSCRIPT_DIR ??
  "/Users/suryaumapathy/Developers/Github/foreverlearning/vasanth/data/transcripts/clean";
const PERSONA_SLUG = "vasanth";

type Turn = { role?: string; text?: string };

function momentsFromTurns(turns: Turn[]) {
  const conversation_moments: Array<{ candidate_context: string; interviewer_response: string }> = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn?.role !== "interviewer" || typeof turn.text !== "string" || !turn.text.trim()) continue;
    const prev = turns[i - 1];
    conversation_moments.push({
      candidate_context: prev?.role === "candidate" && typeof prev.text === "string" ? prev.text : "",
      interviewer_response: turn.text,
    });
  }
  return { conversation_moments };
}

async function main() {
  const persona = await db.persona.findFirst({ where: { slug: PERSONA_SLUG } });
  if (!persona?.orgId) throw new Error("Persona vasanth not found");

  const files = (await readdir(TRANSCRIPT_DIR)).filter((name) => name.endsWith(".yaml")).sort();
  let indexed = 0;
  let moments = 0;
  for (const name of files) {
    const existing = await db.personaSource.findFirst({
      where: { personaId: persona.id, orgId: persona.orgId, name },
      select: { id: true, status: true },
    });
    if (existing?.status === "analyzed") {
      console.log(`skip ${name}`);
      continue;
    }

    const filePath = path.join(TRANSCRIPT_DIR, name);
    const raw = await readFile(filePath, "utf8");
    const parsed = yaml.load(raw) as { turns?: Turn[] };
    const analysis = momentsFromTurns(Array.isArray(parsed.turns) ? parsed.turns : []);
    const extracted = extractPersonaVoiceMoments(analysis);
    if (!extracted.length) {
      console.log(`empty ${name}`);
      continue;
    }

    const info = await stat(filePath);
    const source = existing
      ? await db.personaSource.update({
          where: { id: existing.id },
          data: {
            kind: "transcript",
            s3Key: `local:transcripts/clean/${name}`,
            status: "analyzed",
            analysis: analysis as Prisma.InputJsonValue,
            metadata: {
              size: info.size,
              mimeType: "text/yaml",
              voiceMoments: extracted.length,
              voiceActions: [...new Set(extracted.map((moment) => moment.action).filter(Boolean))],
            } as Prisma.InputJsonValue,
          },
        })
      : await db.personaSource.create({
          data: {
            personaId: persona.id,
            orgId: persona.orgId,
            kind: "transcript",
            name,
            s3Key: `local:transcripts/clean/${name}`,
            status: "analyzed",
            analysis: analysis as Prisma.InputJsonValue,
            metadata: {
              size: info.size,
              mimeType: "text/yaml",
              voiceMoments: extracted.length,
              voiceActions: [...new Set(extracted.map((moment) => moment.action).filter(Boolean))],
            } as Prisma.InputJsonValue,
          },
        });

    await MainCollectionService.ingestPersonaVoice(
      persona.orgId,
      persona.id,
      source.id,
      name,
      extracted,
    );
    indexed += 1;
    moments += extracted.length;
    console.log(`indexed ${name}: ${extracted.length} moments`);
  }

  const probe = await MainCollectionService.searchPersonaVoice(
    persona.orgId,
    "Action: probe\nInterviewer: Can you walk me through a specific example?",
    { personaId: persona.id, limit: 3 },
  );
  console.log(JSON.stringify({ indexed, moments, chromaHits: probe.length }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
