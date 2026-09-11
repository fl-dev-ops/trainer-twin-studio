/**
 * Persona analysis queue tests.
 *
 * Unit tests cover the pure helpers. DB-backed tests cover claim ordering,
 * single-flight behavior, stale-row recovery, enqueue guards, and drain
 * semantics against the real local database (same setup as
 * lib/runtime/runtime-e2e.test.ts). analyzePersonaSource is stubbed via
 * mock.module so no OpenRouter/S3 calls are made.
 */

import { describe, expect, it, beforeAll, afterAll, mock } from "bun:test";
import { db } from "@/lib/db";
import { randomBytes } from "node:crypto";
import {
  MAX_PERSONA_ANALYSIS_ATTEMPTS,
  ACTIVE_ANALYSIS_TTL_MS,
  personaAnalysisAttempts,
  personaSourceIsComplete,
} from "./persona-analysis-queue";

// Stub the heavy analyzer before the queue module (which imports it) is loaded.
const analyzed: string[] = [];
let failNextId: string | null = null;
mock.module("@/lib/persona-synthesis", () => ({
  analyzePersonaSource: async (sourceId: string) => {
    if (sourceId === failNextId) {
      failNextId = null;
      await db.personaSource.update({
        where: { id: sourceId },
        data: { status: "failed", metadata: { error: "boom" } },
      });
      throw new Error("boom");
    }
    analyzed.push(sourceId);
    await db.personaSource.update({
      where: { id: sourceId },
      data: { status: "analyzed", metadata: { voiceMoments: 1 } },
    });
  },
}));

const {
  claimNextPersonaSource,
  drainPersonaAnalysisQueue,
  enqueuePersonaAnalysis,
  recoverStaleAnalyzing,
} = await import("./persona-analysis-queue");

describe("persona analysis queue helpers", () => {
  it("personaAnalysisAttempts extraction", () => {
    expect(personaAnalysisAttempts(null)).toBe(0);
    expect(personaAnalysisAttempts({})).toBe(0);
    expect(personaAnalysisAttempts({ analysisAttempts: 2 })).toBe(2);
    expect(personaAnalysisAttempts({ analysisAttempts: "invalid" })).toBe(0);
    expect(personaAnalysisAttempts({ analysisAttempts: -1 })).toBe(0);
  });

  it("personaSourceIsComplete checks analyzed status and voice moments", () => {
    expect(personaSourceIsComplete("uploaded", { voiceMoments: 5 })).toBe(false);
    expect(personaSourceIsComplete("analyzed", {})).toBe(false);
    expect(personaSourceIsComplete("analyzed", { voiceMoments: 0 })).toBe(false);
    expect(personaSourceIsComplete("analyzed", { voiceMoments: 10 })).toBe(true);
  });

  it("MAX_PERSONA_ANALYSIS_ATTEMPTS is 3", () => {
    expect(MAX_PERSONA_ANALYSIS_ATTEMPTS).toBe(3);
  });
});

describe("persona analysis queue (DB)", () => {
  let orgId = "";
  let personaId = "";
  const createdSourceIds: string[] = [];

  const createSource = async (status: string, metadata: Record<string, unknown> = {}) => {
    const source = await db.personaSource.create({
      data: {
        personaId,
        orgId,
        kind: "transcript",
        name: `src-${randomBytes(4).toString("hex")}.txt`,
        s3Key: "test/unused",
        status,
        metadata: metadata as any,
      },
    });
    createdSourceIds.push(source.id);
    return source;
  };

  beforeAll(async () => {
    const member = await db.member.findFirstOrThrow();
    orgId = member.organizationId;
    const persona = await db.persona.create({
      data: {
        orgId,
        slug: `test-queue-${randomBytes(4).toString("hex")}`,
        name: "Queue Test Persona",
        data: {},
      },
    });
    personaId = persona.id;
  });

  afterAll(async () => {
    await db.personaSource.deleteMany({ where: { id: { in: createdSourceIds } } });
    await db.persona.deleteMany({ where: { id: personaId } });
  });

  it("claims uploaded sources in createdAt order and increments attempts", async () => {
    const a = await createSource("uploaded", { analysisAttempts: 0 });
    const b = await createSource("uploaded", {});

    const first = await claimNextPersonaSource({ personaId });
    expect(first?.sourceId).toBe(a.id);

    const claimedA = await db.personaSource.findUniqueOrThrow({ where: { id: a.id } });
    expect(claimedA.status).toBe("analyzing");
    expect(personaAnalysisAttempts(claimedA.metadata)).toBe(1);

    // While A is fresh-analyzing, single-flight blocks the next claim
    expect(await claimNextPersonaSource({ personaId })).toBeNull();

    // Finish A; now B is claimable (single-flight no longer blocked)
    await db.personaSource.update({ where: { id: a.id }, data: { status: "analyzed" } });
    const second = await claimNextPersonaSource({ personaId });
    expect(second?.sourceId).toBe(b.id);
    await db.personaSource.update({ where: { id: b.id }, data: { status: "analyzed" } });
  });

  it("recovers stale analyzing rows back to uploaded", async () => {
    const stuck = await createSource("analyzing", {});
    await db.personaSource.update({
      where: { id: stuck.id },
      data: { updatedAt: new Date(Date.now() - ACTIVE_ANALYSIS_TTL_MS - 1000) },
    });

    expect(await recoverStaleAnalyzing()).toBeGreaterThanOrEqual(1);
    const row = await db.personaSource.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(row.status).toBe("uploaded");
  });

  it("drain processes the backlog sequentially and survives failing sources", async () => {
    // Clear leftovers from earlier tests in this persona so the drain starts empty
    await db.personaSource.updateMany({
      where: { personaId, status: { in: ["uploaded", "analyzing", "failed"] } },
      data: { status: "analyzed" },
    });
    const s1 = await createSource("uploaded");
    const s2 = await createSource("uploaded");
    const s3 = await createSource("uploaded");
    analyzed.length = 0;
    failNextId = s2.id; // stub marks it failed and throws, like the real analyzer

    const result = await drainPersonaAnalysisQueue({ personaId });
    expect(result.processed).toBe(2);
    expect(analyzed).toEqual([s1.id, s3.id]); // s2 failed, s3 still processed

    const failedRow = await db.personaSource.findUniqueOrThrow({ where: { id: s2.id } });
    expect(failedRow.status).toBe("failed");
  });

  it("enqueuePersonaAnalysis refuses active/complete sources and resets exhausted attempts", async () => {
    const complete = await createSource("analyzed", { voiceMoments: 3 });
    expect((await enqueuePersonaAnalysis(complete.id, orgId)).queued).toBe(false);

    const exhausted = await createSource("failed", {
      analysisAttempts: MAX_PERSONA_ANALYSIS_ATTEMPTS,
      error: "x",
    });
    expect((await enqueuePersonaAnalysis(exhausted.id, orgId)).queued).toBe(true);
    const row = await db.personaSource.findUniqueOrThrow({ where: { id: exhausted.id } });
    expect(row.status).toBe("uploaded");
    expect(personaAnalysisAttempts(row.metadata)).toBe(0);
  });
});
