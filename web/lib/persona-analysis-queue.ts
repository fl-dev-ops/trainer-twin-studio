import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { analyzePersonaSource } from "@/lib/persona-synthesis";

export const MAX_PERSONA_ANALYSIS_ATTEMPTS = 3;
// ponytail: one global slot protects the rate-limited model; shard by org when throughput demands it.
// Must exceed the worst-case analysis pipeline (~10min: 300s gemini + 120s embed + 180s compile)
// so a legitimately slow analysis is never TTL-requeued while still running.
export const ACTIVE_ANALYSIS_TTL_MS = 15 * 60 * 1000;

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

/**
 * Queue a persona source for analysis. The `PersonaSource.status` field IS the
 * queue: "uploaded" rows are claimed one at a time by `drainPersonaAnalysisQueue`.
 */
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

  await db.personaSource.update({
    where: { id: sourceId },
    data: {
      status: "uploaded",
      metadata: { ...metadata, analysisAttempts: attempts } as Prisma.InputJsonValue,
    },
  });
  return { queued: true };
}

type ClaimScope = { personaId?: string };

/**
 * Requeue sources stuck in an active state (server crashed mid-analysis).
 */
export async function recoverStaleAnalyzing(scope: ClaimScope = {}): Promise<number> {
  const result = await db.personaSource.updateMany({
    where: {
      status: { in: ["analyzing", "compiling"] },
      updatedAt: { lt: new Date(Date.now() - ACTIVE_ANALYSIS_TTL_MS) },
      ...(scope.personaId ? { personaId: scope.personaId } : {}),
    },
    data: { status: "uploaded" },
  });
  if (result.count > 0) {
    console.info(`[persona-queue] recovered ${result.count} stale analyzing source(s)`);
  }
  return result.count;
}

/**
 * Atomically claim the oldest uploaded source for analysis, or null when the
 * queue is empty or another analysis is in flight (single-flight, protects
 * OpenRouter from concurrent-request rate limits).
 */
export async function claimNextPersonaSource(scope: ClaimScope = {}): Promise<{ sourceId: string; orgId: string } | null> {
  return db.$transaction(async (tx) => {
    const active = await tx.personaSource.findFirst({
      where: {
        status: { in: ["analyzing", "compiling"] },
        updatedAt: { gt: new Date(Date.now() - ACTIVE_ANALYSIS_TTL_MS) },
        ...(scope.personaId ? { personaId: scope.personaId } : {}),
      },
      select: { id: true },
    });
    if (active) return null;

    // ponytail: string-interpolated WHERE — parameterize if the scope grows.
    const scopeFilter = scope.personaId ? Prisma.sql` AND "personaId" = ${scope.personaId}` : Prisma.empty;
    const rows = await tx.$queryRaw<Array<{ id: string; orgId: string }>>(
      Prisma.sql`SELECT id, "orgId" FROM "PersonaSource"
      WHERE status = 'uploaded'${scopeFilter}
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1`
    );
    const candidate = rows[0];
    if (!candidate) return null;

    const source = await tx.personaSource.findUniqueOrThrow({
      where: { id: candidate.id },
      select: { metadata: true },
    });
    const metadata = metadataRecord(source.metadata);
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

/**
 * Drain the queue: claim and analyze sources strictly one at a time until the
 * queue is empty or another drain holds the single-flight slot. Called from
 * request handlers via `after()` and from the ingestion cron pump; failures on
 * individual sources never stop the drain (the source is marked failed and the
 * loop continues).
 */
export async function drainPersonaAnalysisQueue(scope: ClaimScope = {}): Promise<{ processed: number }> {
  await recoverStaleAnalyzing(scope);
  let processed = 0;
  for (;;) {
    const claimed = await claimNextPersonaSource(scope);
    if (!claimed) break;
    try {
      await analyzePersonaSource(claimed.sourceId, claimed.orgId);
      processed++;
    } catch (error) {
      console.error(`[persona-queue] analysis failed for ${claimed.sourceId}:`, error);
    }
  }
  return { processed };
}
