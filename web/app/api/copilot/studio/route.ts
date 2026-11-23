import { timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { embedTexts, searchKnowledge } from "@/lib/knowledge";
import { MainCollectionService, type ScenarioScope, type ScenarioStep } from "@/lib/main-collection";
import { type PinnedTwinSkill, twinPlaybooks, sessionTwinPlaybooks, resolveTwinCatalog } from "@/lib/twins";
import { enqueueWorkspaceCommand } from "@/lib/workspace-commands";
import { buildSessionContext, getCachedSessionContext } from "@/lib/session-context";
import { recordTurnEvidence, recordTurnLines, turnEvidenceSchema } from "@/lib/twin/evidence";
import { modelImage } from "@/lib/model-image";
import { uploadBytes } from "@/lib/upload-bytes";
import { resolveUpload, UploadError } from "@/lib/uploads";
import { getObjectText } from "@/lib/s3";
import { authorizeRuntimeSession, publicSessionExpired } from "@/lib/interview-sessions";
import { errorResponse } from "@/lib/errors";
import { loadSessionSkills, resolveSnapshotSkill } from "@/lib/session-skills";
import { skillRefusals } from "@/lib/skills";
import { runsAsMainTwin } from "@/lib/main-twin";

/** How much of a knowledge document one read_knowledge_document call returns (about 3k tokens). */
const KNOWLEDGE_PAGE_CHARS = 12_000;

export const runtime = "nodejs";

const slug = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i);
const requestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("authorizeRuntimeSession"),
    sessionId: z.string().min(1).max(100),
    token: z.string().max(200).optional(),
  }).strict(),
  z.object({
    action: z.literal("searchKnowledge"),
    knowledgeBase: slug,
    query: z.string().trim().min(2).max(500),
    limit: z.number().int().min(1).max(8),
    topics: z.array(z.string().trim().min(1)).optional(),
  }).strict(),
  z.object({
    action: z.literal("searchScenarioItems"),
    agentSlug: slug,
    query: z.string().trim().min(2).max(500),
    step: z.string().trim().min(1).max(100).optional(),
    role: z.enum(["trainer", "learner", "client"]).optional(),
    limit: z.number().int().min(1).max(6).optional(),
    /** Twin sessions: narrow to one playbook (its scenario id or slug). */
    playbook: z.string().trim().min(1).max(200).optional(),
    /** All-skills twin sessions: search only the skills pinned when the session started. */
    sessionId: z.string().min(1).max(100).optional(),
    /** Small twins' per-turn lines: keep what was returned for this turn's "Why this answer" (lib/twin/evidence.ts). */
    recordTurnLines: z.object({ heard: z.string().max(4000), situation: z.string().max(500) }).strict().optional(),
  }).strict(),
  z.object({
    action: z.literal("readDocument"),
    documentId: z.string().trim().min(1).max(120),
    query: z.string().trim().min(1).max(500).optional(),
    section: z.string().trim().min(1).max(100).optional(),
  }).strict(),
  z.object({
    // read_knowledge_document: a knowledge-base document's Markdown, paged (ids from search_knowledge's docId).
    action: z.literal("readKnowledgeDocument"),
    documentId: z.string().trim().min(1).max(120),
    page: z.number().int().min(1).max(500).optional(),
  }).strict(),
  z.object({
    // The chat channel's fetchFile (trainertwin-upload://<id>): a file attached to this session, as an S3 link.
    action: z.literal("resolveUpload"),
    documentId: z.string().trim().min(1).max(120),
    sessionId: z.string().trim().min(1).max(100),
  }).strict(),
  z.object({
    action: z.literal("getSessionContext"),
    sessionId: z.string().optional(),
    agentSlug: z.string().optional(),
    personaSlug: z.string().optional(),
  }).strict(),
  z.object({
    action: z.literal("getWorkspaceState"),
    sessionId: z.string().trim().min(1),
  }).strict(),
  z.object({
    action: z.literal("enqueueWorkspaceCommand"),
    sessionId: z.string().trim().min(1),
    callId: z.string().trim().min(1),
    tool: z.string().trim().min(1).max(80),
    input: z.unknown().optional(),
  }).strict(),
  z.object({
    action: z.literal("finishSession"),
    sessionId: z.string().trim().min(1),
  }).strict(),
  turnEvidenceSchema.extend({ action: z.literal("recordTurnEvidence") }).strict(),
  z.object({
    action: z.literal("isCalibrationSession"),
    sessionId: z.string().trim().min(1),
  }).strict(),
]);

function authorized(request: Request) {
  const expected = process.env.COPILOT_SERVICE_SECRET;
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const orgId = request.headers.get("x-trainertwin-org-id")?.trim();
  if (!orgId) return Response.json({ error: "Organization is required" }, { status: 400 });
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid Copilot request" }, { status: 400 });
  const input = parsed.data;

  if (input.action === "authorizeRuntimeSession") {
    const session = await db.interviewSession.findFirst({
      where: { id: input.sessionId, orgId, status: { in: ["active", "closing"] }, deletedAt: null },
      select: { anonymousId: true, allowedSeconds: true, startedAt: true, deletedAt: true },
    });
    const token = input.token || request.headers.get("x-trainertwin-runtime-token") || "";
    const authorized = session && !publicSessionExpired(session)
      && (!session.anonymousId || (token && (await authorizeRuntimeSession(input.sessionId, token))?.orgId === orgId));
    return authorized
      ? Response.json({ valid: true, anonymous: Boolean(session.anonymousId) }, { headers: { "Cache-Control": "no-store" } })
      : Response.json({ error: "Session is no longer available", valid: false }, { status: 401 });
  }

  const sessionId = request.headers.get("x-trainertwin-session-id") || ("sessionId" in input ? input.sessionId : undefined);
  if (sessionId) {
    const session = await db.interviewSession.findFirst({
      where: { id: sessionId, orgId },
      select: { id: true, anonymousId: true, personaSlug: true, agentSlug: true },
    });
    // A public call (it sends its runtime token) must name a live session of this org; any other caller falls through
    // to the action's own session checks.
    if (!session && request.headers.get("x-trainertwin-runtime-token")) {
      return Response.json({ error: "Session is no longer available" }, { status: 401 });
    }
    if (session?.anonymousId) {
      const token = request.headers.get("x-trainertwin-runtime-token") || "";
      if (!token || (await authorizeRuntimeSession(session.id, token))?.orgId !== orgId) {
        return Response.json({ error: "Session is no longer available" }, { status: 401 });
      }
      const allowed = ["getSessionContext", "searchScenarioItems", "searchStyleEpisodes", "getPersonaStyleMoments",
        "recordTurnEvidence", "isCalibrationSession", "finishSession"];
      const finishCommand = input.action === "enqueueWorkspaceCommand" && input.tool === "finish_session";
      if ((!allowed.includes(input.action) && !finishCommand)
        || ("sessionId" in input && input.sessionId && input.sessionId !== session.id)
        || ("agentSlug" in input && input.agentSlug && input.agentSlug !== session.agentSlug)
        || ("personaSlug" in input && input.personaSlug && input.personaSlug !== session.personaSlug)) {
        return Response.json({ error: "This action is not available in a public call" }, { status: 403 });
      }
      if (input.action === "searchScenarioItems" || input.action === "getSessionContext") input.sessionId = session.id;
    }
  }

  if (input.action === "readDocument") {
    const doc = await db.contextDocument.findFirst({
      where: { id: input.documentId, orgId, status: "ready" },
      include: {
        chunks: { orderBy: { chunkIndex: "asc" } },
      },
    });
    if (!doc) return Response.json({ error: `Document "${input.documentId}" not found` }, { status: 404 });

    let chunks = doc.chunks;
    if (input.section) {
      const sec = input.section.toLowerCase();
      const matched = chunks.filter((c) => c.heading?.toLowerCase().includes(sec));
      if (matched.length > 0) chunks = matched;
    }
    if (input.query) {
      const qTerms = input.query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
      const matched = chunks.filter((c) => {
        const txt = (c.text + " " + (c.heading ?? "")).toLowerCase();
        return qTerms.some((term) => txt.includes(term));
      });
      if (matched.length > 0) chunks = matched;
    }

    return Response.json({
      documentId: doc.id,
      name: doc.name,
      kind: doc.kind,
      // An image has no text: the chat agent shows it to the model itself (chat/agent/tools/read_document.ts).
      ...(doc.kind === "image" ? { image: await modelImage(await uploadBytes(doc), doc.mimeType) } : {}),
      chunks: chunks.map((c) => ({
        index: c.chunkIndex,
        heading: c.heading,
        pageNumber: c.pageNumber,
        text: c.text,
      })),
    });
  }

  if (input.action === "readKnowledgeDocument") {
    const doc = await db.knowledgeDocument.findFirst({
      where: { id: input.documentId, kb: { orgId }, status: "indexed", s3MarkdownKey: { not: null } },
      select: { id: true, title: true, s3MarkdownKey: true },
    });
    if (!doc?.s3MarkdownKey) return Response.json({ error: `Knowledge document "${input.documentId}" not found` }, { status: 404 });
    const text = await getObjectText(doc.s3MarkdownKey);
    const pages = Math.max(1, Math.ceil(text.length / KNOWLEDGE_PAGE_CHARS));
    const page = Math.min(input.page ?? 1, pages);
    return Response.json({
      documentId: doc.id,
      title: doc.title,
      page,
      pages,
      text: text.slice((page - 1) * KNOWLEDGE_PAGE_CHARS, page * KNOWLEDGE_PAGE_CHARS),
    });
  }

  if (input.action === "resolveUpload") {
    try {
      return Response.json(await resolveUpload({ orgId, id: input.documentId, sessionId: input.sessionId }));
    } catch (error) {
      if (error instanceof UploadError) return Response.json({ error: error.message }, { status: error.status });
      throw error;
    }
  }

  if (input.action === "getWorkspaceState") {
    const session = await db.interviewSession.findFirst({
      where: { id: input.sessionId, orgId }, select: { runtimeState: true },
    });
    const state = session?.runtimeState as { uiState?: unknown } | null;
    return Response.json({ uiState: state?.uiState ?? null });
  }

  if (input.action === "getSessionContext") {
    try {
      const startedAt = performance.now();
      const context = input.sessionId
        ? await getCachedSessionContext(orgId, input.sessionId)
        : await buildSessionContext({
            orgId,
            agentSlug: input.agentSlug,
            personaSlug: input.personaSlug,
          });
      console.info("[session-context]", {
        sessionId: input.sessionId ?? null,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return Response.json(context);
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (input.action === "recordTurnEvidence") {
    return Response.json(await recordTurnEvidence(orgId, turnEvidenceSchema.parse(input)));
  }

  if (input.action === "isCalibrationSession") {
    const calibration = await db.twinCalibration.findFirst({
      where: { sessionId: input.sessionId, session: { orgId } },
      select: { id: true },
    });
    return Response.json({ calibration: Boolean(calibration) });
  }

  if (input.action === "enqueueWorkspaceCommand" || input.action === "finishSession") {
    return Response.json(await enqueueWorkspaceCommand({
      orgId,
      sessionId: input.sessionId,
      callId: input.action === "finishSession" ? `finish-${input.sessionId}` : input.callId,
      tool: input.action === "finishSession" ? "finish_session" : input.tool,
      payload: input.action === "finishSession" ? {} : input.input,
    }));
  }

  // Real lines from a scenario-ingest scenario (items.json), for the chat tool scenario_examples.
  if (input.action === "searchScenarioItems") {
    try {
    const previewAgent = !input.sessionId
      ? await db.agent.findFirst({ where: { slug: input.agentSlug, orgId }, select: {
        id: true, slug: true, primarySkillId: true, data: true, personaId: true, kind: true, version: true,
      } })
      : null;
    const previewSkills = async () => {
      if (!previewAgent) return null;
      const data = previewAgent.data && typeof previewAgent.data === "object" && !Array.isArray(previewAgent.data)
        ? previewAgent.data as Record<string, unknown> : {};
      const isMainTwin = runsAsMainTwin(previewAgent.kind, data);
      if (!isMainTwin && !previewAgent.primarySkillId) return null;
      return db.$transaction(async (tx) => {
        if (!isMainTwin) {
          if (previewAgent.kind === "BOT") return null;
          const version = await resolveSnapshotSkill(orgId, previewAgent, previewAgent.kind, tx);
          return {
            kind: previewAgent.kind, agentSlug: previewAgent.slug, personaId: previewAgent.personaId, isMainTwin,
            catalog: [{ slug: previewAgent.slug, version: previewAgent.version, skillVersionId: version.id }],
            pins: [{ alias: previewAgent.slug, position: 0, version }], data,
          };
        }
        const selected = await resolveTwinCatalog(orgId, previewAgent.personaId, tx, previewAgent.id);
        const versions = await tx.skillVersion.findMany({
          where: { id: { in: selected.pins.map((pin) => pin.skillVersionId) }, status: "ready", indexStatus: "ready", skill: { orgId } },
          select: {
            id: true, version: true, skillId: true, status: true, indexStatus: true, format: true, skillText: true,
            manifest: true, artifacts: true, itemCount: true, skill: { select: { orgId: true, ownerSlug: true } },
          },
        });
        const pins = selected.pins.map((pin) => {
          const version = versions.find((version) => version.id === pin.skillVersionId && version.skill.ownerSlug === pin.alias);
          if (!version) throw skillRefusals.unavailable();
          return { alias: pin.alias, position: pin.position, version };
        });
        return { kind: previewAgent.kind, agentSlug: previewAgent.slug, personaId: previewAgent.personaId, isMainTwin, catalog: selected.catalog, pins, data };
      });
    };
    const managedSkill = input.sessionId
      ? await loadSessionSkills(orgId, input.sessionId, input.agentSlug, true)
      : await previewSkills();
    if (managedSkill) {
      const all = managedSkill.isMainTwin ? await sessionTwinPlaybooks(orgId, managedSkill) : [];
      const named = input.playbook ? all.filter((p) => p.id === input.playbook || p.slug === input.playbook) : [];
      const chosen = input.agentSlug !== managedSkill.agentSlug
        ? all.filter((p) => p.slug === input.agentSlug)
        : named.length ? named : all;
      const aliases = new Set(chosen.map((p) => p.slug));
      const pins = managedSkill.pins.filter((pin) => !managedSkill.isMainTwin || aliases.has(pin.alias));
      const steps = managedSkill.isMainTwin ? chosen.flatMap((p) => p.steps as ScenarioStep[]) : pins.flatMap(({ version }) => {
        const manifest = version.manifest as { steps?: unknown; situations?: unknown };
        const steps = manifest.steps ?? manifest.situations;
        return Array.isArray(steps) ? steps as ScenarioStep[] : [];
      });
      const options = {
        step: input.step,
        role: input.role ?? (pins[0]?.version.format === "builder-roleplay" ? "client" : "trainer"),
        limit: input.limit,
        steps,
      };
      const legacyScope = managedSkill.isMainTwin
        ? managedSkill.catalog.filter((entry) => !entry.skillVersionId && aliases.has(entry.slug)).map(({ slug, version }) => ({ slug, version }))
        : [];
      const [managedExamples, legacyExamples] = await Promise.all([
        pins.length ? MainCollectionService.searchSkillItems(orgId, pins.map(({ version }) => ({
          skillVersionId: version.id,
          indexScope: version.artifacts,
          itemCount: version.itemCount,
        })), input.query, options) : [],
        legacyScope.length ? MainCollectionService.searchScenarioItems(orgId, legacyScope, input.query, options) : [],
      ]);
      const examples = [...managedExamples, ...legacyExamples].sort((a, b) => b.score - a.score).slice(0, input.limit ?? 3);
      const turnLines = input.recordTurnLines;
      if (turnLines && input.sessionId) {
        const sessionId = input.sessionId;
        after(() => recordTurnLines(orgId, sessionId, { ...turnLines, examples }).catch((error) => {
          console.error("[twin-evidence] turn lines failed", error);
        }));
      }
      return Response.json({ query: input.query, examples });
    }
    // The embedding needs only the query: start it now so it runs alongside the DB lookups below.
    const queryEmbedding = embedTexts([input.query]).then(([embedding]) => embedding);
    queryEmbedding.catch(() => {}); // awaited in searchScenarioItems; this only stops an early DB error leaving it unhandled
    // scenario.json's steps map the newer items' `action` to a step, and a step to its moves.
    const agent = previewAgent ?? await db.agent.findFirst({ where: { slug: input.agentSlug, orgId }, select: { data: true, personaId: true, kind: true, version: true } });
    const data = agent?.data as { source?: unknown; skill?: unknown; scenario?: { steps?: unknown; situations?: unknown } } | null;
    let exampleData = data;
    let scope: { skills: ScenarioScope[]; steps: ScenarioStep[] };
    if (agent && runsAsMainTwin(agent.kind, data)) {
      // The all-skills twin searches its persona's skill twins: all of them, or the one the model has loaded.
      const pinned = input.sessionId
        ? (await db.interviewSession.findFirst({ where: { id: input.sessionId, orgId, agentSlug: input.agentSlug }, select: { compiledSnapshot: true } }))
          ?.compiledSnapshot as { twinSkills?: PinnedTwinSkill[] } | null | undefined
        : undefined;
      const all = await twinPlaybooks(orgId, agent.personaId, Array.isArray(pinned?.twinSkills) ? pinned.twinSkills : undefined);
      const named = input.playbook ? all.filter((p) => p.id === input.playbook || p.slug === input.playbook) : [];
      // An unknown name (e.g. a sanitised skill name) widens to all playbooks rather than finding nothing.
      const chosen = named.length > 0 ? named : all;
      // Each skill at the version the call pinned (or the live one).
      scope = { skills: chosen.map((p) => ({ slug: p.slug, version: p.version })), steps: chosen.flatMap((p) => p.steps as ScenarioStep[]) };
    } else {
      // Pin the example role and step mapping as well as its version; publishing must not change a running call.
      const started = input.sessionId
        ? await db.interviewSession.findFirst({ where: { id: input.sessionId, orgId, agentSlug: input.agentSlug }, select: { agentVersion: true, compiledSnapshot: true } })
        : null;
      const snapshot = started?.compiledSnapshot as { agent?: { data?: typeof data } } | null | undefined;
      exampleData = snapshot?.agent?.data ?? data;
      const steps = exampleData?.scenario?.steps ?? exampleData?.scenario?.situations;
      const version = started?.agentVersion ?? agent?.version;
      scope = { skills: version ? [{ slug: input.agentSlug, version }] : [], steps: Array.isArray(steps) ? (steps as ScenarioStep[]) : [] };
    }
    const examples = await MainCollectionService.searchScenarioItems(orgId, scope.skills, input.query, {
      step: input.step,
      role: input.role ?? (agent?.kind === "ROLEPLAY" && typeof exampleData?.skill === "string" && exampleData.source !== "scenario-ingest" ? "client" : "trainer"),
      limit: input.limit,
      steps: scope.steps,
      queryEmbedding,
    });
    const turnLines = input.recordTurnLines;
    if (turnLines && input.sessionId) {
      const sessionId = input.sessionId;
      // After the response: the twin's turn never waits for this write.
      after(() => recordTurnLines(orgId, sessionId, { ...turnLines, examples }).catch((error) => {
        console.error("[twin-evidence] turn lines failed", error);
      }));
    }
    return Response.json({ query: input.query, examples });
    } catch (error) {
      return errorResponse(error);
    }
  }

  try {
    const knowledgeBase = await db.knowledgeBase.findFirst({
      where: { slug: input.knowledgeBase, orgId, documents: { some: { status: "indexed" } } },
      select: { id: true },
    });
    if (!knowledgeBase) return Response.json({ error: `No indexed knowledge base named "${input.knowledgeBase}"` });
    const results = await searchKnowledge(knowledgeBase.id, input.query, input.limit, orgId, input.topics);
    const relevant = results.length > 0;
    return Response.json({
      query: input.query,
      knowledgeBase: input.knowledgeBase,
      relevant,
      ...(!relevant ? { reason: "No approved reference met the relevance threshold" } : {}),
      results: results.map(({ id, docId, kbId, source, title, chunkIndex, topic, text, score }) => ({
        chunkId: id,
        docId,
        kbId: kbId ?? knowledgeBase.id,
        source,
        title,
        chunkIndex,
        topic,
        text,
        score,
      })),
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Copilot request failed" }, { status: 500 });
  }
}
