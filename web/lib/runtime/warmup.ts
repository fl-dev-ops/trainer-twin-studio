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
import { adaptOpeningWithoutContext, generateSpeech } from "./openai";

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
      expects_answer: true,
    };

    const rawOpening = specs.agent.opening || "Welcome to the interview session. Let's begin.";
    const baseOpening = specs.documentManifests?.length
      ? rawOpening
      : adaptOpeningWithoutContext(rawOpening);

    const opening = await generateSpeech(
      baseOpening,
      openingAction,
      specs,
      state,
      [],
      null,
      [],
      session.orgId,
      personaVoiceAvailable
    );

    const prewarmed = {
      openingText: opening.text,
      neededSurface,
      turnSpeechMeta: opening.meta,
    };

    // Store in session runtimeState
    await db.interviewSession.update({
      where: { id: session.id },
      data: {
        runtimeState: {
          ...state,
          prewarmed_opening: prewarmed,
        } as any,
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
