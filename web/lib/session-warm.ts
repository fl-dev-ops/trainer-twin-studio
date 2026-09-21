import { db } from "@/lib/db";
import { getAgentConfigForAgent } from "@/lib/specs";
import { buildSpecs } from "@/lib/runtime/compiler";
import { surfaceForPhase } from "@/lib/runtime/runtime";
import { MainCollectionService } from "@/lib/main-collection";
import { redactLearnerNames } from "@/lib/persona-voice";

/**
 * Prewarms the chat brain's opening turn in the background right after session
 * activation. While the learner connects (and any intro video plays), this:
 *
 * 1. Pins the compiled spec snapshot on the session row (getSessionContext reuses it).
 * 2. Enqueues the opening `surface` command (e.g. open_pdf) so the learner's
 *    document is already on screen before the greeting — the brain then skips
 *    its surface tool call.
 * 3. Pre-runs the opening style retrieval the brain would otherwise do via the
 *    search_style tool (~2.3s: vector load + query embedding).
 *
 * Results land in `InterviewSession.warmOpening`; the brain reads them through
 * getSessionContext and, when present, skips ALL opening tool calls and speaks
 * in one LLM completion. Every step is best-effort: a missed warm just means
 * the brain runs today's slower path.
 */

const OPENING_STYLE_QUERY = "greeting the learner at the start of a training session";

export async function warmChatOpening(sessionId: string, orgId: string): Promise<void> {
  const startedAt = performance.now();
  try {
    const session = await db.interviewSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        orgId: true,
        agentSlug: true,
        personaSlug: true,
        contextId: true,
        compiledSnapshot: true,
        warmOpening: true,
      },
    });
    if (!session || session.warmOpening) return;

    // 1. Pin the compiled snapshot (also used by getSessionContext and the old voice runtime).
    let snapshot = session.compiledSnapshot as Record<string, unknown> | null;
    if (!snapshot) {
      snapshot = (await getAgentConfigForAgent(session.agentSlug, orgId, session.contextId ?? undefined)) as
        | Record<string, unknown>
        | null;
      if (!snapshot) return;
      await db.interviewSession.update({
        where: { id: sessionId },
        data: { compiledSnapshot: JSON.parse(JSON.stringify(snapshot)) },
      });
    }

    const specs = buildSpecs(snapshot as Parameters<typeof buildSpecs>[0]);
    const personaId = (snapshot as { persona?: { id?: string } }).persona?.id;

    // 2. Opening surface (open_pdf etc.) as a durable command; the browser executes
    //    it on connect. Same shape the brain's surface tool would have enqueued.
    let surfaceQueued = false;
    if (personaId) {
      const neededSurface = surfaceForPhase(specs.agent, 0, specs.documentManifests);
      if (neededSurface) {
        try {
          await db.workspaceCommand.upsert({
            where: { id: `warm-surface-${sessionId}` },
            create: {
              id: `warm-surface-${sessionId}`,
              sessionId,
              tool: "surface",
              input: neededSurface as object,
              status: "pending",
            },
            update: {},
          });
          surfaceQueued = true;
        } catch {
          // Command table unavailable or session not yet activatable; the brain
          // will call surface itself on the non-warm path.
        }
      }
    }

    // 3. Opening style retrieval — same studio code path as the search_style tool
    //    (episodes + style hits, learner names redacted).
    let openingStyle: unknown = null;
    if (personaId) {
      const [styleHits, episodeHits] = await Promise.all([
        MainCollectionService.searchStyleEpisodes(orgId, OPENING_STYLE_QUERY, {
          personaId,
          sessionPhase: "opening",
          limit: 4,
          diversify: true,
        }),
        MainCollectionService.searchPersonaEpisodes(orgId, OPENING_STYLE_QUERY, {
          personaId,
          sessionPhase: "opening",
          limit: 2,
          diversify: true,
        }),
      ]);
      openingStyle = {
        pastExchanges: episodeHits.map((hit) => ({
          exchange: redactLearnerNames(hit.text, []),
          score: hit.score,
        })),
        phrasingStyle: styleHits.map((hit) => {
          const pastName = (hit as { pastLearnerName?: string }).pastLearnerName;
          return {
            text: redactLearnerNames(hit.text, [pastName]),
            score: hit.score,
            metadata: {
              sessionPhase: (hit as { sessionPhase?: string }).sessionPhase,
              styleFunction: redactLearnerNames((hit as { styleFunction?: string }).styleFunction ?? "", [pastName]),
              styleShape: redactLearnerNames((hit as { styleShape?: string }).styleShape ?? "", [pastName]),
              usesLearnerName: (hit as { usesLearnerName?: boolean }).usesLearnerName,
              startsWithThanks: (hit as { startsWithThanks?: boolean }).startsWithThanks,
              hasDoubledAcknowledgement: (hit as { hasDoubledAcknowledgement?: boolean }).hasDoubledAcknowledgement,
            },
          };
        }),
      };
    }

    if (!openingStyle && !surfaceQueued) return;

    // Only warm sessions that have not started talking yet; the fresh-state check
    // keeps a late warm from clobbering an in-flight session.
    const fresh = await db.interviewSession.findUnique({
      where: { id: sessionId },
      select: { runtimeState: true, warmOpening: true },
    });
    if (fresh?.warmOpening) return;
    const state = (fresh?.runtimeState ?? null) as Record<string, unknown> | null;
    if (state && (Array.isArray(state.actions) && (state.actions as string[]).includes("opening"))) return;

    await db.interviewSession.update({
      where: { id: sessionId },
      data: {
        warmOpening: JSON.parse(
          JSON.stringify({
            style: openingStyle,
            surfaceQueued,
            createdAt: new Date().toISOString(),
          }),
        ),
      },
    });

    console.info(
      `[session-warm] ${sessionId} warmed in ${Math.round(performance.now() - startedAt)}ms (surface=${surfaceQueued}, style=${Boolean(openingStyle)})`,
    );
  } catch (error) {
    console.warn(`[session-warm] prewarm failed for session ${sessionId}:`, error);
  }
}
