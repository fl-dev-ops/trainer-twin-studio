/**
 * Persona synthesis pipeline: upload source materials → analyze with Gemini
 * → synthesize rich persona YAML from cross-source behavioral patterns.
 *
 * Supported source types:
 * - video / audio  → uploaded to Gemini Files API for multimodal analysis
 * - document       → converted to markdown via documentToMarkdown, analyzed as text
 * - transcript / chat → analyzed as text via OpenRouter
 */
import type { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { deletePrefix, getObjectBytes, personaSourcePrefix, putObject } from "@/lib/s3";
import { documentToMarkdown } from "@/lib/documents";
import { extractPersonaVoiceMoments, shouldRebuildPersona } from "@/lib/persona-voice";
import { MainCollectionService } from "@/lib/main-collection";
import { saveSpec } from "@/lib/specs";

const OPENROUTER_BASE_URL = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? process.env.LLM_API_KEY ?? "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const ANALYSIS_MODEL = process.env.PERSONA_ANALYSIS_MODEL ?? "google/gemini-2.5-flash";
const GEMINI_FILES_ENDPOINT = "https://generativelanguage.googleapis.com";

// ---- Kind detection --------------------------------------------------------

export type SourceKind = "video" | "audio" | "document" | "transcript" | "chat";

export function detectKind(filename: string, mimeType: string): SourceKind {
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (["mp4", "mov", "avi", "webm", "mkv", "m4v"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "ogg", "flac", "aac"].includes(ext)) return "audio";
  if (["pdf", "docx", "doc", "pptx", "ppt", "xlsx"].includes(ext)) return "document";
  if (["json", "csv"].includes(ext)) return "chat";
  return "transcript";
}

// ---- CRUD ------------------------------------------------------------------

type PersonaIdentity = { id: string; slug: string; name: string };

async function findPersona(orgId: string, slug: string): Promise<PersonaIdentity | null> {
  return db.persona.findUnique({ where: { orgId_slug: { orgId, slug } }, select: { id: true, slug: true, name: true } });
}

export async function uploadPersonaSource(orgId: string, personaSlug: string, file: File) {
  const persona = await findPersona(orgId, personaSlug);
  if (!persona) throw new Error("Persona not found");
  const kind = detectKind(file.name, file.type);
  const source = await db.personaSource.create({
    data: {
      personaId: persona.id, orgId, kind, name: file.name, s3Key: "pending", status: "uploaded",
      metadata: { size: file.size, mimeType: file.type || "application/octet-stream" } as Prisma.InputJsonValue,
    },
  });
  const s3Key = `${personaSourcePrefix(orgId, persona.id, source.id)}/${encodeURIComponent(file.name)}`;
  await putObject(s3Key, new Uint8Array(await file.arrayBuffer()), file.type || "application/octet-stream");
  await db.personaSource.update({ where: { id: source.id }, data: { s3Key } });
  return { id: source.id, kind, name: file.name, status: "uploaded" as const };
}

export async function listPersonaSources(personaSlug: string, orgId: string) {
  const persona = await findPersona(orgId, personaSlug);
  if (!persona) throw new Error("Persona not found");
  return db.personaSource.findMany({
    where: { personaId: persona.id, orgId },
    orderBy: { createdAt: "asc" },
    select: { id: true, kind: true, name: true, status: true, metadata: true, createdAt: true },
  });
}

export async function deletePersonaSource(id: string, orgId: string) {
  const source = await db.personaSource.findFirst({
    where: { id, orgId },
    include: { persona: { select: { id: true, slug: true, name: true } } },
  });
  if (!source) throw new Error("Source not found");
  await Promise.all([
    deletePrefix(source.s3Key),
    MainCollectionService.removePersonaSource(orgId, source.id),
  ]);
  await db.personaSource.delete({ where: { id } });
  await rebuildPersonaIfCorpusReady(source.persona, orgId);
}

// ---- Gemini Files API (for video / audio) ----------------------------------

async function uploadToGeminiFiles(bytes: Uint8Array, mimeType: string, displayName: string): Promise<string> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is required for video/audio analysis. Set it in your environment.");

  // Start resumable upload
  const startRes = await fetch(
    `${GEMINI_FILES_ENDPOINT}/upload/v1beta/files?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": bytes.length.toString(),
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: { displayName } }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const uploadUrl = startRes.headers.get("X-Goog-Upload-URL");
  if (!uploadUrl) throw new Error(`Failed to start Gemini file upload: ${startRes.status} ${await startRes.text()}`);

  // Upload file content
  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Length": bytes.length.toString(),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: Buffer.from(bytes),
    signal: AbortSignal.timeout(300_000),
  });
  if (!uploadRes.ok) throw new Error(`Gemini file upload failed: ${uploadRes.status} ${await uploadRes.text()}`);
  const fileData = await uploadRes.json() as { file: { uri: string; state: string } };
  return fileData.file.uri;
}

// ---- Analysis prompt -------------------------------------------------------

const ANALYSIS_SYSTEM = `You are an expert behavioral analyst. Your job is to extract the unique speaking patterns and behavioral tendencies of a specific interviewer from source material. Return only valid JSON — no markdown, no explanation.`;

function buildAnalysisPrompt(personaName: string, sourceKind: SourceKind, sourceName: string): string {
  return `Analyze the source material below and extract behavioral patterns of the interviewer named "${personaName}".
Source type: ${sourceKind} | Source: ${sourceName}

Focus on what makes this person sound like THEMSELVES — their unique word choices, sentence patterns, reactions, and decision-making style when candidates give different types of answers.

Return a JSON object with EXACTLY this structure:
{
  "source_type": "${sourceKind}",
  "interviewer_turns_analyzed": <integer — count of distinct interviewer speaking turns found>,
  "tone_description": "<one concrete sentence describing their overall communication style>",
  "habits": ["<specific recurring behavior>", ...],
  "avoidances": ["<thing they never do>", ...],
  "speaking_patterns": {
    "sentence_length": "<short|medium|long|varies> — <brief description>",
    "question_style": "<concrete description of how they frame questions>",
    "bridges": ["<bridge phrase they use to transition>", ...],
    "acknowledgments": {
      "strong": ["<phrase used when answer is good>", ...],
      "weak": ["<phrase used when answer is poor/vague>", ...]
    },
    "transitions": ["<transition phrase>", ...],
    "filler_words": ["<filler>", ...],
    "avoids_words": ["<word/phrase they never use>"]
  },
  "behavioral_patterns": {
    "on_vague_answer": {
      "action": "<one of: ask_exact_example|narrow_hint|request_justification|isolate_missing_part>",
      "examples": ["<verbatim quote from source>", ...],
      "confidence": <0.0-1.0>
    },
    "on_unsupported_claim": {
      "action": "<one of: request_justification|probe_required_evidence|deepen_with_tradeoff>",
      "examples": ["<verbatim quote>", ...],
      "confidence": <0.0-1.0>
    },
    "on_partial_answer": {
      "action": "<one of: isolate_missing_part|ask_exact_example|scaffold_missing_link>",
      "examples": ["<verbatim quote>", ...],
      "confidence": <0.0-1.0>
    },
    "on_contradictory_answer": {
      "action": "surface_contradiction",
      "examples": ["<verbatim quote>", ...],
      "confidence": <0.0-1.0>
    },
    "on_unknown": {
      "action": "<one of: narrow_hint|scaffold_missing_link|ask_reflection>",
      "examples": ["<verbatim quote>", ...],
      "confidence": <0.0-1.0>
    },
    "on_strong_answer": {
      "action": "<one of: deepen_with_tradeoff|deepen_with_edge_case|ask_reflective_walkthrough>",
      "examples": ["<verbatim quote>", ...],
      "confidence": <0.0-1.0>
    }
  },
  "conversation_moments": [
    {
      "candidate_context": "<verbatim candidate statement immediately before the response>",
      "action": "<canonical action performed>",
      "interviewer_response": "<verbatim interviewer response>"
    }
  ],
  "verbatim_phrases": {
    "ask_exact_example": ["<phrase>", ...],
    "request_justification": ["<phrase>", ...],
    "isolate_missing_part": ["<phrase>", ...],
    "surface_contradiction": ["<phrase>", ...],
    "narrow_hint": ["<phrase>", ...],
    "deepen_with_tradeoff": ["<phrase>", ...],
    "deepen_with_edge_case": ["<phrase>", ...],
    "scaffold_missing_link": ["<phrase>", ...],
    "ask_reflection": ["<phrase>", ...]
  }
}

Rules:
- Only include verbatim phrases that ACTUALLY appear in the source material — never invent quotes
- conversation_moments must pair adjacent candidate and interviewer turns; use an empty array when the source has no dialogue
- Use empty arrays when an action type has no evidence in this source
- Be conservative with confidence — high confidence only when you see 3+ clear examples
- For video/audio: analyze only the interviewer as the persona; include candidate words only as context paired with the interviewer's next response
- For documents/notes: infer behavioral patterns from the methodology described`;
}

// ---- Analysis execution ----------------------------------------------------

async function analyzeWithText(content: string, personaName: string, sourceKind: SourceKind, sourceName: string): Promise<unknown> {
  const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENROUTER_API_KEY}` },
    body: JSON.stringify({
      model: ANALYSIS_MODEL,
      messages: [
        { role: "system", content: ANALYSIS_SYSTEM },
        { role: "user", content: `${buildAnalysisPrompt(personaName, sourceKind, sourceName)}\n\n--- SOURCE CONTENT ---\n${content}` },
      ],
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`Analysis API returned ${res.status}: ${await res.text()}`);
  const data = await res.json() as { choices: { message: { content: string } }[] };
  return JSON.parse(data.choices[0].message.content);
}

async function analyzeWithMedia(geminiFileUri: string, mimeType: string, personaName: string, sourceKind: SourceKind, sourceName: string): Promise<unknown> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is required for video/audio analysis");
  const res = await fetch(
    `${GEMINI_FILES_ENDPOINT}/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { fileData: { mimeType, fileUri: geminiFileUri } },
            { text: buildAnalysisPrompt(personaName, sourceKind, sourceName) },
          ],
        }],
        systemInstruction: { parts: [{ text: ANALYSIS_SYSTEM }] },
        generationConfig: { responseMimeType: "application/json" },
      }),
      signal: AbortSignal.timeout(300_000),
    },
  );
  if (!res.ok) throw new Error(`Gemini API returned ${res.status}: ${await res.text()}`);
  const data = await res.json() as { candidates: { content: { parts: { text: string }[] } }[] };
  const text = data.candidates[0]?.content?.parts?.[0]?.text ?? "{}";
  return JSON.parse(text);
}

// ---- Automatic persona compilation ----------------------------------------

async function rebuildPersonaIfCorpusReady(persona: PersonaIdentity, orgId: string, triggerSourceId?: string) {
  const sources = await db.personaSource.findMany({
    where: { personaId: persona.id, orgId },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: { id: true, status: true },
  });
  // Concurrent analyses can all finish together; only the most recently
  // completed source compiles the settled corpus.
  if (!shouldRebuildPersona(sources, triggerSourceId)) return;
  if (triggerSourceId) {
    await db.personaSource.update({ where: { id: triggerSourceId }, data: { status: "compiling" } });
  }
  try {
    await saveSpec("personas", persona.slug, await synthesizePersona(persona.slug, orgId), orgId);
  } catch (error) {
    console.error(`[persona-synthesis] automatic persona update failed for ${persona.slug}:`, error);
  } finally {
    if (triggerSourceId) {
      await db.personaSource.update({ where: { id: triggerSourceId }, data: { status: "analyzed" } });
    }
  }
}

// ---- Public: analyze one source -------------------------------------------

export async function analyzePersonaSource(sourceId: string, orgId: string): Promise<void> {
  const source = await db.personaSource.findFirst({
    where: { id: sourceId, orgId },
    include: { persona: { select: { id: true, slug: true, name: true } } },
  });
  if (!source) throw new Error("Source not found");

  const metadata = (source.metadata ?? {}) as Record<string, string>;
  const mimeType = metadata.mimeType ?? "application/octet-stream";
  await db.personaSource.update({ where: { id: sourceId }, data: { status: "analyzing" } });

  try {
    const existingChunks = extractPersonaVoiceMoments(source.analysis);
    if (existingChunks.length) {
      await MainCollectionService.ingestPersonaVoice(orgId, source.personaId, source.id, source.name, existingChunks);
      await db.personaSource.update({
        where: { id: sourceId },
        data: { status: "analyzed", metadata: { ...metadata, voiceMoments: existingChunks.length, voiceActions: [...new Set(existingChunks.map((moment) => moment.action).filter(Boolean))] } as Prisma.InputJsonValue },
      });
      await rebuildPersonaIfCorpusReady(source.persona, orgId, sourceId);
      return;
    }

    let analysis: unknown;
    if (source.kind === "video" || source.kind === "audio") {
      const bytes = await getObjectBytes(source.s3Key);
      const geminiUri = await uploadToGeminiFiles(bytes, mimeType, source.name);
      analysis = await analyzeWithMedia(geminiUri, mimeType, source.persona.name, source.kind as SourceKind, source.name);
    } else if (source.kind === "document") {
      const bytes = await getObjectBytes(source.s3Key);
      const file = new File([Buffer.from(bytes)], source.name, { type: mimeType });
      const { markdown } = await documentToMarkdown(file);
      analysis = await analyzeWithText(markdown, source.persona.name, source.kind as SourceKind, source.name);
    } else {
      const bytes = await getObjectBytes(source.s3Key);
      analysis = await analyzeWithText(new TextDecoder().decode(bytes), source.persona.name, source.kind as SourceKind, source.name);
    }
    const chunks = extractPersonaVoiceMoments(analysis);
    await db.personaSource.update({
      where: { id: sourceId },
      data: { analysis: analysis as Prisma.InputJsonValue },
    });
    await MainCollectionService.ingestPersonaVoice(orgId, source.personaId, source.id, source.name, chunks);
    await db.personaSource.update({
      where: { id: sourceId },
      data: { status: "analyzed", metadata: { ...metadata, voiceMoments: chunks.length, voiceActions: [...new Set(chunks.map((moment) => moment.action).filter(Boolean))] } as Prisma.InputJsonValue },
    });
    await rebuildPersonaIfCorpusReady(source.persona, orgId, sourceId);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Analysis failed";
    await db.personaSource.update({
      where: { id: sourceId },
      data: {
        status: "failed",
        metadata: { ...metadata, error: errorMsg } as Prisma.InputJsonValue,
      },
    });
    throw error;
  }
}

// ---- Synthesis prompt -------------------------------------------------------

const SYNTHESIS_SYSTEM = `You are an expert at synthesizing behavioral observations into precise persona specifications for AI voice interviewers. Return only valid YAML — no markdown code blocks, no explanation.`;

// ---- Public: synthesize persona from all analyzed sources ------------------

export async function synthesizePersona(personaSlug: string, orgId: string): Promise<string> {
  const persona = await findPersona(orgId, personaSlug);
  if (!persona) throw new Error("Persona not found");
  const sources = await db.personaSource.findMany({
    where: { personaId: persona.id, orgId, status: { in: ["analyzed", "compiling"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true, kind: true, name: true, analysis: true },
  });
  if (sources.length === 0) throw new Error("No analyzed sources found. Analyze at least one source before synthesizing.");

  const date = new Date().toISOString().split("T")[0];
  const analysesText = sources.map((s, i) =>
    `--- Source ${i + 1}: "${s.name}" (${s.kind}) ---\n${JSON.stringify(s.analysis, null, 2)}`
  ).join("\n\n");

  const prompt = `Synthesize behavioral analyses from ${sources.length} source(s) of interviewer "${persona.name}" into a complete persona specification.

ANALYSES:
${analysesText}

Guidelines:
- Prefer patterns that appear across MULTIPLE sources (higher confidence = higher weight)
- Collect ALL verbatim phrases across sources, deduplicate, keep best 5-8 per action type
- decision_preferences must map to canonical action names: ask_exact_example, narrow_hint, request_justification, isolate_missing_part, surface_contradiction, scaffold_missing_link, deepen_with_tradeoff, deepen_with_edge_case, ask_reflection, redirect_role
- calibration values are floats 0.0-1.0
- Be specific and concrete — abstract descriptions like "professional" are useless
- language.acknowledgments.strong, language.acknowledgments.weak, and language.bridges must each contain at least one verbatim phrase from the sources
- Do not copy projects, people, or facts from sources into the persona spec; style and habits only

Return ONLY valid YAML (no markdown fences) with this EXACT structure:

schema_version: 1
kind: persona
persona:
  id: ${personaSlug}
  name: ${persona.name}
  version: 1
  source_evidence:
    source_count: ${sources.length}
    extraction_date: ${date}
    confidence: <low|medium|high>
  style:
    tone: <one specific sentence>
    habits:
      - <habit 1>
    avoid:
      - <avoidance 1>
  language:
    sentence_length: <short|medium|long|varies> — <description>
    question_style: <concrete description>
    bridges:
      - <bridge phrase>
    acknowledgments:
      strong:
        - <phrase>
      weak:
        - <phrase>
    transitions:
      - <phrase>
    filler_words:
      - <word>
    avoids_words:
      - <phrase>
  decision_preferences:
    vague: <action>
    unsupported: <action>
    partial: <action>
    contradictory: surface_contradiction
    unknown: <action>
    strong: <action>
    role_violation: redirect_role
  calibration:
    warmth_on_strong_answer: <float 0.0-1.0>
    firmness_on_weak_answer: <float 0.0-1.0>
    patience_with_confusion: <float 0.0-1.0>
    preamble_before_question: <none|short|long>
  examples:
    ask_exact_example:
      - <verbatim phrase>
    request_justification:
      - <verbatim phrase>
    isolate_missing_part:
      - <verbatim phrase>
    surface_contradiction:
      - <verbatim phrase>
    narrow_hint:
      - <verbatim phrase>
    deepen_with_tradeoff:
      - <verbatim phrase>
    deepen_with_edge_case:
      - <verbatim phrase>
    scaffold_missing_link:
      - <verbatim phrase>
    ask_reflection:
      - <verbatim phrase>`;

  const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENROUTER_API_KEY}` },
    body: JSON.stringify({
      model: ANALYSIS_MODEL,
      messages: [
        { role: "system", content: SYNTHESIS_SYSTEM },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`Synthesis API returned ${res.status}: ${await res.text()}`);
  const data = await res.json() as { choices: { message: { content: string } }[] };
  return (data.choices[0].message.content ?? "")
    .replace(/^```(?:ya?ml)?\s*\n?/i, "")
    .replace(/\n?```\s*$/, "")
    .trim();
}
