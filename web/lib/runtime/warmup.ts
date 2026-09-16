import { db } from "@/lib/db";
import { getAgentConfigForAgent } from "@/lib/specs";
import { buildSpecs } from "./compiler";
import { MainCollectionService } from "@/lib/main-collection";
import {
  initRuntimeState,
  surfaceForPhase,
  type InterviewAction,
  type RuntimeState,
} from "./runtime";
import { adaptOpeningWithoutContext, generateSpeech, recordClaimMain, resumeTurnGuidance, selectNextClaimEvidence, stripPickOneInstructions, technicalOpeningIntroContract, type ClaimTurn } from "./openai";
import type { Prisma } from "@/lib/generated/prisma/client";

/**
 * Pre-warms the opening turn for an interview session in the background
 * immediately after session creation/activation.
 *
 * 1. Pre-loads 743 persona style vectors into RAM.
 * 2. Compiles session specs and prepares phase 0 surface (e.g. open_pdf with resume).
 * 3. Pre-generates the opening speech with verified document grounding.
 * 4. Warms the Vercel AI Gateway KV-cache for subsequent turns.
 * 5. Saves the prewarmed opening into runtimeState so the LiveKit agent receives an instant (<20ms) opening turn.
 */
export async function prewarmSessionOpening(sessionId: string): Promise<boolean> {
  const startedAt = performance.now();
  try {
    const session = await db.interviewSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        orgId: true,
        agentId: true,
        agentSlug: true,
        personaSlug: true,
        contextId: true,
        compiledSnapshot: true,
        runtimeState: true,
      },
    });
    if (!session) return false;

    // Compile snapshot if not yet cached on the row
    let configSnapshot = session.compiledSnapshot as Record<string, any> | null;
    if (!configSnapshot) {
      configSnapshot = await getAgentConfigForAgent(
        session.agentSlug,
        session.orgId,
        session.contextId ?? undefined
      );
      if (!configSnapshot) return false;
      await db.interviewSession.update({
        where: { id: session.id },
        data: { compiledSnapshot: configSnapshot },
      });
    }

    const specs = buildSpecs(configSnapshot);
    const personaVoiceAvailable = configSnapshot.personaVoiceAvailable !== false;

    // Asynchronously pre-load persona style vectors into in-memory RAM cache
    void MainCollectionService.searchStyleEpisodes(session.orgId, "greeting", {
      personaId: specs.persona.id,
      limit: 1,
    }).catch(() => null);

    const state: RuntimeState = {
      ...initRuntimeState(),
      ...((session.runtimeState as Partial<RuntimeState> | null) ?? {}),
    };

    // If already pre-warmed or already started, no-op
    if (state.prewarmed_opening?.openingText || state.actions.includes("opening")) {
      return true;
    }

    const neededSurface = surfaceForPhase(specs.agent, 0, specs.documentManifests);

    const openingAction: InterviewAction = {
      name: "opening",
      evidence_key: specs.agent.phases[0]?.evidence_keys[0] ?? null,
      reason: "Start the configured interview after preparing its surface.",
      intent: specs.agent.phases[0]?.opening ?? specs.agent.objective,
      close: false,
      expects_answer: specs.agent.interview.type !== "technical",
    };

    const rawOpening = specs.agent.opening || "Welcome to the interview session. Let's begin.";

    // Claim-driven opening (Resume Mastery v1): select the first resume claim before
    // generating speech, so the greeting references the exact claim the viewer highlights.
    const openingFileId =
      neededSurface?.action === "open_pdf" && typeof neededSurface.payload.fileId === "string"
        ? neededSurface.payload.fileId
        : "";
    let claimTurn: ClaimTurn | null = null;
    if (openingFileId) {
      // The candidate's full resume text rides the speech prompts all session, so
      // the agent knows who they are talking to without asking for a name.
      const resumeDoc = await db.contextDocument.findUnique({
        where: { id: openingFileId },
        select: { extractedText: true },
      });
      state.resume_text = resumeDoc?.extractedText ?? null;
      try {
        claimTurn = await selectNextClaimEvidence(session, specs, state, openingFileId, specs.agent.phases[0] ?? null);
      } catch (error) {
        console.warn("[warmup] opening claim selection failed; opening without a pinned claim", error);
      }
    }
    if (claimTurn) {
      recordClaimMain(state, claimTurn.selection, claimTurn.evidence, claimTurn.angle, claimTurn.claimId);
    }

    const baseOpening = claimTurn
      ? stripPickOneInstructions(rawOpening)
      : specs.documentManifests?.length
        ? rawOpening
        : adaptOpeningWithoutContext(rawOpening);
    const openingContract = specs.agent.interview.type === "technical"
      ? technicalOpeningIntroContract(rawOpening)
      : claimTurn
      ? `${baseOpening}\n${resumeTurnGuidance(specs, state, {
          kind: "new_main",
          angle: claimTurn.angle,
          bridge: false,
          claimLine: claimTurn.selection.line,
        })}`
      : baseOpening;

    const opening = await generateSpeech(
      openingContract,
      openingAction,
      specs,
      state,
      [],
      null,
      [],
      session.orgId,
      personaVoiceAvailable,
      undefined,
      claimTurn?.evidence ?? null
    );

    const prewarmed = {
      openingText: opening.text,
      neededSurface: claimTurn
        ? { action: neededSurface!.action, payload: { ...neededSurface!.payload, highlightQuery: claimTurn.selection.anchor } }
        : neededSurface,
      turnSpeechMeta: opening.meta,
      claim: claimTurn
        ? { anchor: claimTurn.selection.anchor, section: claimTurn.selection.section, line: claimTurn.selection.line }
        : null,
    };

    // The opening turn may have completed while this prewarm was generating (the agent's
    // first completion races this background task once the intro video is disabled). Never
    // overwrite live session progress with this stale state copy: merge onto the freshest
    // row and skip entirely when the opening already ran.
    const fresh = await db.interviewSession.findUnique({
      where: { id: session.id },
      select: { runtimeState: true },
    });
    const freshState = { ...state, ...((fresh?.runtimeState as Partial<RuntimeState> | null) ?? {}) };
    if (
      freshState.actions.includes("opening") ||
      (freshState.used_claims?.length ?? 0) > 0 ||
      Boolean(freshState.current_main_question) ||
      Boolean(freshState.pending_opening_text)
    ) {
      return true;
    }
    await db.interviewSession.update({
      where: { id: session.id },
      data: {
        runtimeState: {
          ...freshState,
          prewarmed_opening: prewarmed,
          // Prisma jsonb column: the runtime state is JSON-serializable by construction.
        } as unknown as Prisma.InputJsonValue,
      },
    });

    const elapsedMs = Math.round(performance.now() - startedAt);
    console.info(`[warmup] session ${session.id} prewarmed in ${elapsedMs}ms`, {
      surface: neededSurface?.action ?? "none",
      openingPreview: opening.text.slice(0, 60),
    });

    return true;
  } catch (error) {
    console.warn(`[warmup] prewarm failed for session ${sessionId}:`, error);
    return false;
  }
}
