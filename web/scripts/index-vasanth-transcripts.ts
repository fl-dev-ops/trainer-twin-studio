import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import type { Prisma } from "../lib/generated/prisma/client";
import { db } from "../lib/db";
import { MainCollectionService } from "../lib/main-collection";
import { createPersonaStyleMoment, createPersonaVoiceEpisode, extractPersonaVoiceMoments } from "../lib/persona-voice";

const TRANSCRIPT_DIR =
  process.env.VASANTH_TRANSCRIPT_DIR ??
  "/Users/suryaumapathy/Developers/Github/foreverlearning/vasanth/data/transcripts/clean";
const PERSONA_SLUG = "vasanth";
const EPISODE_MODE = process.argv.includes("--episodes");
const STYLE_MODE = process.argv.includes("--styles");
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const STYLE_MODEL = process.env.PERSONA_ANALYSIS_MODEL ?? "openai/gpt-4.1-mini";

if (EPISODE_MODE && STYLE_MODE) throw new Error("Choose either --episodes or --styles");
if (STYLE_MODE && !OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is required for --styles");

type Turn = { role?: string; text?: string };
type Transcript = {
  title?: string;
  track?: string;
  seniority?: string;
  topics?: string[];
  participants?: { candidate?: string };
  turns?: Turn[];
};
type Phase = "opening" | "middle" | "closing";
type StyleAnalysis = {
  index: number;
  learnerState: string;
  speechFunction: string;
  sentenceShape: string;
  phrasingFeatures: string;
  cadence: string;
  delexicalizedPattern: string;
};

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

function interviewerEntries(transcript: Transcript) {
  const turns = Array.isArray(transcript.turns) ? transcript.turns : [];
  const indexes = turns.flatMap((turn, index) =>
    turn.role === "interviewer" && typeof turn.text === "string" && turn.text.trim() ? [index] : [],
  );
  return indexes.map((turnIndex, index) => ({
    index,
    turnIndex,
    phase: (index < 2 ? "opening" : index >= indexes.length - 2 ? "closing" : "middle") as Phase,
    response: turns[turnIndex].text!,
    candidate: turns[turnIndex - 1]?.role === "candidate" ? turns[turnIndex - 1].text : undefined,
    nextCandidate: turns[turnIndex + 1]?.role === "candidate" ? turns[turnIndex + 1].text : undefined,
    previousInterviewer: index > 0 ? turns[indexes[index - 1]].text : undefined,
  }));
}

function episodesFromTranscript(transcript: Transcript) {
  const sessionContext = [
    transcript.title,
    transcript.track ? `track: ${transcript.track}` : undefined,
    transcript.seniority ? `seniority: ${transcript.seniority}` : undefined,
    transcript.topics?.length ? `topics: ${transcript.topics.join(", ")}` : undefined,
  ].filter(Boolean).join("; ");
  return interviewerEntries(transcript).map((entry) => createPersonaVoiceEpisode({
    interviewerResponse: entry.response,
    candidateContext: entry.candidate,
    previousInterviewerContext: entry.previousInterviewer,
    nextCandidateContext: entry.nextCandidate,
    sessionContext,
    sessionPhase: entry.phase,
    pastLearnerName: transcript.participants?.candidate,
  }));
}

async function styleAnalyses(transcript: Transcript): Promise<StyleAnalysis[]> {
  const entries = interviewerEntries(transcript);
  const analyses: StyleAnalysis[] = [];
  for (let offset = 0; offset < entries.length; offset += 12) {
    const batch = entries.slice(offset, offset + 12);
    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENROUTER_API_KEY}` },
      body: JSON.stringify({
        model: STYLE_MODEL,
        temperature: 0,
        max_tokens: 6000,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `Analyze how Vasanth phrases each response, independent of its technical topic. Return one item per input index. Do not evaluate correctness or invent quotes.

Use concise labels:
- learnerState: greeting|strong|partial|vague|confused|incorrect|defensive|meta_question|off_topic|closing
- speechFunction: open_session|orient|acknowledge|paraphrase|probe|clarify|correct|hint|explain|answer_meta|reassure|redirect|feedback|close
- sentenceShape: ordered moves joined by " -> "
- phrasingFeatures: comma-separated wording features such as repetition, doubled acknowledgement, direct address, tag question, filler bridge, paraphrase, imperative, reassurance
- cadence: one short topic-neutral description
- delexicalizedPattern: preserve Vasanth's characteristic function words and sentence shape while replacing names, technologies, companies and claims with <learner>, <topic>, <claim>, or <example>; maximum 30 words

Return JSON only: {"moments":[{"index":0,"learnerState":"...","speechFunction":"...","sentenceShape":"...","phrasingFeatures":"...","cadence":"...","delexicalizedPattern":"..."}]}`,
          },
          {
            role: "user",
            content: JSON.stringify(batch.map((entry) => ({
              index: entry.index,
              sessionPhase: entry.phase,
              learnerBefore: entry.candidate ?? "",
              vasanthResponse: entry.response,
            }))),
          },
        ],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error(`Style analysis failed: ${response.status} ${await response.text()}`);
    const payload = await response.json() as { choices: Array<{ message: { content: string } }> };
    const parsed = JSON.parse(payload.choices[0]?.message.content ?? "{}") as { moments?: StyleAnalysis[] };
    if (Array.isArray(parsed.moments)) analyses.push(...parsed.moments);
  }
  return analyses;
}

async function stylesFromTranscript(transcript: Transcript) {
  const analyses = new Map((await styleAnalyses(transcript)).map((analysis) => [Number(analysis.index), analysis]));
  return interviewerEntries(transcript).map((entry) => {
    const analysis = analyses.get(entry.index) ?? {
      index: entry.index,
      learnerState: entry.phase === "opening" ? "greeting" : entry.phase === "closing" ? "closing" : "vague",
      speechFunction: entry.phase === "opening" ? "open_session" : entry.phase === "closing" ? "close" : "probe",
      sentenceShape: "response",
      phrasingFeatures: "",
      cadence: "natural spoken response",
      delexicalizedPattern: "<response>",
    };
    return createPersonaStyleMoment({
      interviewerResponse: entry.response,
      pastLearnerName: transcript.participants?.candidate,
      sessionPhase: entry.phase,
      ...analysis,
    });
  });
}

async function main() {
  const persona = await db.persona.findFirst({ where: { slug: { equals: PERSONA_SLUG, mode: "insensitive" } } });
  if (!persona?.orgId) throw new Error("Persona vasanth not found");

  const files = (await readdir(TRANSCRIPT_DIR)).filter((name) => name.endsWith(".yaml")).sort();
  let indexed = 0;
  let moments = 0;
  for (const name of files) {
    const existing = await db.personaSource.findFirst({
      where: { personaId: persona.id, orgId: persona.orgId, name },
      select: { id: true, status: true, metadata: true },
    });
    if (existing?.status === "analyzed" && !EPISODE_MODE && !STYLE_MODE) {
      console.log(`skip ${name}`);
      continue;
    }

    const filePath = path.join(TRANSCRIPT_DIR, name);
    const raw = await readFile(filePath, "utf8");
    const parsed = yaml.load(raw) as Transcript;
    const extracted = STYLE_MODE
      ? await stylesFromTranscript(parsed)
      : EPISODE_MODE
        ? episodesFromTranscript(parsed)
        : extractPersonaVoiceMoments(momentsFromTurns(Array.isArray(parsed.turns) ? parsed.turns : []));
    if (!extracted.length) {
      console.log(`empty ${name}`);
      continue;
    }

    const info = await stat(filePath);
    const metadata = existing?.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata)
      ? existing.metadata as Record<string, unknown>
      : {};
    const experimentalMetadata = STYLE_MODE
      ? { styleMoments: extracted.length }
      : { episodeMoments: extracted.length };
    const source = existing
      ? await db.personaSource.update({
          where: { id: existing.id },
          data: EPISODE_MODE || STYLE_MODE
            ? { metadata: { ...metadata, ...experimentalMetadata } as Prisma.InputJsonValue }
            : {
                kind: "transcript",
                s3Key: `local:transcripts/clean/${name}`,
                status: "analyzed",
                analysis: momentsFromTurns(Array.isArray(parsed.turns) ? parsed.turns : []) as Prisma.InputJsonValue,
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
            analysis: momentsFromTurns(Array.isArray(parsed.turns) ? parsed.turns : []) as Prisma.InputJsonValue,
            metadata: {
              size: info.size,
              mimeType: "text/yaml",
              ...(EPISODE_MODE || STYLE_MODE ? experimentalMetadata : { voiceMoments: extracted.length }),
            } as Prisma.InputJsonValue,
          },
        });

    const recordType = STYLE_MODE ? "persona_style_episode" : EPISODE_MODE ? "persona_voice_episode" : "persona_voice";
    await MainCollectionService.ingestPersonaVoice(persona.orgId, persona.id, source.id, name, extracted, recordType);
    indexed += 1;
    moments += extracted.length;
    console.log(`indexed ${name}: ${extracted.length} ${STYLE_MODE ? "styles" : EPISODE_MODE ? "episodes" : "moments"}`);
  }

  console.log(JSON.stringify({ mode: STYLE_MODE ? "styles" : EPISODE_MODE ? "episodes" : "voice", indexed, moments }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
