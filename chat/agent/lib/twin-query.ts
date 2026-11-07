import { generateText, Output } from "ai";
import { z } from "zod";
import type { TwinPlaybook } from "./brain";
import { cerebrasProviderOptions, isCerebrasModel, resolveModel } from "./cerebras";
import { DECISION_MODEL } from "./models";

/**
 * The step the old scenario_examples flow got from the twin's own model (decide the moment, then search), done by a
 * small fast model outside the conversation: which playbook and situation the learner's turn is about, and a
 * one-sentence search for the trainer's lines. Raw learner speech searches poorly; the stored lines lead with a
 * situation sentence ("Why you tell a waiting client that the timing window has already closed"), so this matches.
 * Qwen on Cerebras, called directly with CEREBRAS_API_KEY (lib/cerebras.ts): ~0.45 s, the same picks as gpt-4.1-mini at
 * ~1.3 s. Locked (lib/models.ts).
 */
export const TWIN_QUERY_MODEL = DECISION_MODEL;

export type TwinQuery = { playbook: string; step?: string; query: string };
/** The query model's verdict that this turn needs no lines (small talk, thanks, a question about the call itself). */
export const NO_SEARCH = { skip: true } as const;

export async function writeTwinQuery(
  playbooks: TwinPlaybook[],
  heard: string,
  lastReply: string,
  abortSignal: AbortSignal,
): Promise<TwinQuery | typeof NO_SEARCH | null> {
  if (playbooks.length === 0) return null;
  const catalog = playbooks
    .map((playbook) => [
      `Playbook ${playbook.slug}: ${playbook.name}`,
      ...playbook.steps.map((step) => `  - situation ${step.id}: ${step.name || step.id}`),
    ].join("\n"))
    .join("\n");
  const { output: object } = await generateText({
    model: resolveModel(TWIN_QUERY_MODEL),
    ...(isCerebrasModel(TWIN_QUERY_MODEL) ? { providerOptions: cerebrasProviderOptions() } : {}),
    temperature: 0,
    abortSignal,
    output: Output.object({ schema: z.object({
      search: z.boolean().describe("false when the message brings no client moment to advise on: greetings, thanks, okay, small talk, a question about the call itself, or a request outside every playbook"),
      playbook: z.enum(playbooks.map((playbook) => playbook.slug) as [string, ...string[]]),
      situation: z.string().describe("The situation id from that playbook, or \"none\" if none fits"),
      query: z.string().describe("One sentence: what is happening with the client right now"),
    }) }),
    system: [
      "A sales agent is asking their trainer for advice about a real client. First decide whether their latest message brings a client moment to advise on; if not, set search to false. Otherwise decide which of the trainer's playbooks and situations it is about, then write one sentence describing the client moment, to search the trainer's recorded answers.",
      "Read the trainer's previous reply for context: a short follow-up continues that moment. Describe what the client said or did and what the agent faces, e.g. \"client says it is not the right time and wants to wait six months for the market\". No advice, no names.",
      "",
      catalog,
    ].join("\n"),
    prompt: `Trainer's previous reply: ${lastReply.slice(0, 600) || "(none)"}\n\nAgent's latest message: ${heard.slice(0, 1000)}`,
  });
  if (!object.search) return NO_SEARCH;
  const playbook = playbooks.find((p) => p.slug === object.playbook);
  const step = playbook?.steps.some((s) => s.id === object.situation) ? object.situation : undefined;
  const query = object.query.trim();
  return playbook && query.length >= 2 ? { playbook: playbook.slug, step, query: query.slice(0, 500) } : null;
}
