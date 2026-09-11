import type { Prisma } from "@/lib/generated/prisma/client";
import { send } from "@vercel/queue";
import { z } from "zod";
import { db } from "@/lib/db";
import { analyzePersonaSource } from "@/lib/persona-synthesis";

export const PERSONA_ANALYSIS_TOPIC = "persona-analysis";
export const MAX_PERSONA_ANALYSIS_ATTEMPTS = 3;
const ACTIVE_ANALYSIS_TTL_MS = 10 * 60 * 1000;

export const personaAnalysisMessageSchema = z.object({ sourceId: z.string().min(1) }).strict();
export type PersonaAnalysisMessage = z.infer<typeof personaAnalysisMessageSchema>;

export class PersonaAnalysisBusyError extends Error {
  constructor() {
    super("Another persona source is being analyzed");
    this.name = "PersonaAnalysisBusyError";
  }
}

function metadataRecord(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

export function personaAnalysisAttempts(metadata: unknown): number {
  const value = metadataRecord(metadata).analysisAttempts;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

export function personaSourceIsComplete(status: string, metadata: unknown): boolean {
  return status === "analyzed" && Number(metadataRecord(metadata).voiceMoments ?? 0) > 0;
}

export async function enqueuePersonaAnalysis(sourceId: string, orgId?: string) {
  const source = await db.personaSource.findFirst({
    where: { id: sourceId, ...(orgId ? { orgId } : {}) },
    select: { id: true, status: true, metadata: true },
  });
  if (!source) throw new Error("Source not found");
  if (
    source.status === "analyzing" ||
    source.status === "compiling" ||
    personaSourceIsComplete(source.status, source.metadata)
  ) {
    return { queued: false };
  }

  let metadata = metadataRecord(source.metadata);
  let attempts = personaAnalysisAttempts(metadata);
  if (source.status === "failed" && attempts >= MAX_PERSONA_ANALYSIS_ATTEMPTS) {
    attempts = 0;
    metadata = { ...metadata, analysisAttempts: 0 };
  }

  let messageId: string | null = null;
  try {
    const result = await send<PersonaAnalysisMessage>(
      PERSONA_ANALYSIS_TOPIC,
      { sourceId },
      { idempotencyKey: `${sourceId}:${attempts}`, retentionSeconds: 7 * 24 * 60 * 60 },
    );
    messageId = result.messageId;
  } catch (error) {
    console.warn(`[persona-queue] send to queue failed for ${sourceId}, will be picked up by pump:`, error);
  }

  const { error: _error, ...queuedMetadata } = metadata;
  await db.personaSource.update({
    where: { id: sourceId },
    data: { status: "uploaded", metadata: queuedMetadata as Prisma.InputJsonValue },
  });
  return { queued: true, messageId };
}

export async function claimPersonaSource(sourceId: string): Promise<{ orgId: string } | null> {
  return db.$transaction(async (tx) => {
    // ponytail: one global slot protects the rate-limited model; shard by org when throughput demands it.
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(76110401)");

    const source = await tx.personaSource.findUnique({
      where: { id: sourceId },
      select: { orgId: true, status: true, metadata: true },
    });
    if (!source || personaSourceIsComplete(source.status, source.metadata)) return null;
    if (source.status === "failed" && personaAnalysisAttempts(source.metadata) >= MAX_PERSONA_ANALYSIS_ATTEMPTS) {
      return null;
    }

    const active = await tx.personaSource.findFirst({
      where: {
        id: { not: sourceId },
        status: { in: ["analyzing", "compiling"] },
        updatedAt: { gt: new Date(Date.now() - ACTIVE_ANALYSIS_TTL_MS) },
      },
      select: { id: true },
    });
    if (active) throw new PersonaAnalysisBusyError();

    const metadata = metadataRecord(source.metadata);
    const { error: _error, ...cleanMetadata } = metadata;
    await tx.personaSource.update({
      where: { id: sourceId },
      data: {
        status: "analyzing",
        metadata: {
          ...cleanMetadata,
          analysisAttempts: personaAnalysisAttempts(metadata) + 1,
        } as Prisma.InputJsonValue,
      },
    });
    return { orgId: source.orgId };
  });
}

export async function claimNextPersonaSource(): Promise<{ sourceId: string; orgId: string } | null> {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(76110401)");

    const active = await tx.personaSource.findFirst({
      where: {
        status: { in: ["analyzing", "compiling"] },
        updatedAt: { gt: new Date(Date.now() - ACTIVE_ANALYSIS_TTL_MS) },
      },
      select: { id: true },
    });
    if (active) return null;

    const candidate = await tx.personaSource.findFirst({
      where: { status: "uploaded" },
      orderBy: { createdAt: "asc" },
      select: { id: true, orgId: true, metadata: true },
    });
    if (!candidate) return null;

    const metadata = metadataRecord(candidate.metadata);
    const { error: _error, ...cleanMetadata } = metadata;
    await tx.personaSource.update({
      where: { id: candidate.id },
      data: {
        status: "analyzing",
        metadata: {
          ...cleanMetadata,
          analysisAttempts: personaAnalysisAttempts(metadata) + 1,
        } as Prisma.InputJsonValue,
      },
    });
    return { sourceId: candidate.id, orgId: candidate.orgId };
  });
}

export async function processPersonaAnalysisMessage(message: unknown): Promise<void> {
  const { sourceId } = personaAnalysisMessageSchema.parse(message);
  const claimed = await claimPersonaSource(sourceId);
  if (!claimed) return;
  await analyzePersonaSource(sourceId, claimed.orgId);
}

export async function processNextQueuedPersonaSource(): Promise<{ processed: boolean; sourceId?: string }> {
  const claimed = await claimNextPersonaSource();
  if (!claimed) return { processed: false };
  await analyzePersonaSource(claimed.sourceId, claimed.orgId);
  return { processed: true, sourceId: claimed.sourceId };
}
