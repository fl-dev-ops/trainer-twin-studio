/**
 * Reads an eve v27 session stream (facts) as the event shapes this channel was written for (eve 0.82, v26):
 * `turn.started`, `step.started`, `message.appended`, `actions.requested`, `action.result`, `step.completed`,
 * plus `usage` and a terminal marker. Keeps openai-compat's turn loop, the question bridge and the brain trace
 * unchanged across the upgrade. One instance per delivery.
 */

type Fact = { readonly type: string; readonly data?: unknown };

export type LegacyAction = { kind: string; callId: string; toolName: string; input: unknown };
export type LegacyResult = { kind: string; callId: string; toolName: string; name: string; isError: boolean; output?: unknown };
export type LegacyEvent =
  | { type: "turn.started" }
  | { type: "step.started"; runId: string }
  | { type: "message.appended"; data: { messageDelta: string } }
  | { type: "actions.requested"; data: { actions: LegacyAction[] } }
  | { type: "action.result"; data: { result: LegacyResult } }
  | { type: "step.completed"; runId: string }
  | { type: "usage"; runId?: string; usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } }
  | { type: "terminal"; status: string };

export function createLegacyStream(deliveryId: string) {
  const partKinds = new Map<string, string>();
  const calls = new Map<string, { kind: string; name: string; input: unknown }>();
  const runs = new Set<string>();
  // A model step's tool calls arrive one fact each; v26 handed them over together, which the question
  // bridge relies on (a bridged question wins over a bridged reply of the same step).
  let pending: LegacyAction[] = [];

  const flush = (): LegacyEvent[] => {
    if (!pending.length) return [];
    const actions = pending;
    pending = [];
    return [{ type: "actions.requested", data: { actions } }];
  };

  function push(fact: Fact): LegacyEvent[] {
    const data = (fact.data ?? {}) as Record<string, any>;
    if (fact.type === "call.requested") {
      const capability = (data.capability ?? {}) as { kind?: string; name?: string };
      const kind = capability.kind ?? "tool";
      const name = capability.name ?? "unknown";
      calls.set(String(data.callId), { kind, name, input: data.input });
      // Only tools are actions the old loop knew; skills, agents and task controls still settle (below).
      if (kind === "tool") pending.push({ kind: "tool-call", callId: String(data.callId), toolName: name, input: data.input ?? {} });
      return [];
    }
    const out = flush();
    switch (fact.type) {
      case "turn.started":
        out.push({ type: "turn.started" });
        break;
      case "model.started":
        // Repeats once per attempt; one step per model run.
        if (!runs.has(data.runId)) {
          runs.add(data.runId);
          out.push({ type: "step.started", runId: data.runId });
        }
        break;
      case "content.delta":
        if (typeof data.kind === "string") partKinds.set(data.partId, data.kind);
        if (partKinds.get(data.partId) === "text" && typeof data.delta === "string" && data.delta) {
          out.push({ type: "message.appended", data: { messageDelta: data.delta } });
        }
        break;
      case "call.settled": {
        const call = calls.get(String(data.callId));
        if (!call) break;
        const output = data.output ?? (data.error ? { error: data.error } : undefined);
        out.push({
          type: "action.result",
          data: {
            result: {
              kind: call.kind === "skill" ? "load-skill-result" : call.kind === "tool" ? "tool-result" : `${call.kind}-result`,
              callId: String(data.callId),
              toolName: call.name,
              name: call.name,
              isError: data.outcome !== "completed",
              output,
            },
          },
        });
        break;
      }
      case "model.settled":
        out.push({ type: "step.completed", runId: data.runId });
        break;
      case "usage.recorded":
        if (data.kind === "model" && data.usage) {
          out.push({ type: "usage", runId: data.owner?.runId, usage: data.usage });
        }
        break;
      case "delivery.settled":
        if (data.deliveryId === deliveryId) out.push({ type: "terminal", status: `delivery.${data.outcome ?? "settled"}` });
        break;
      case "session.ended":
        out.push({ type: "terminal", status: `session.${data.outcome ?? "ended"}` });
        break;
      case "turn.settled":
        if (data.outcome === "cancelled") out.push({ type: "terminal", status: "turn.cancelled" });
        break;
    }
    return out;
  }

  return { push, flush };
}
