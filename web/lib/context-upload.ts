export type AgentContextUpload = {
  required: boolean;
  prompt: string;
  label: string;
  accept: string;
};

export const DEFAULT_CONTEXT_ACCEPT =
  ".md,.txt,.pdf,.docx,.doc,.pptx,.ppt,.xlsx,.xls,.csv,.json,.png,.jpg,.jpeg,.webp";
export const RESUME_CONTEXT_ACCEPT = ".pdf,.docx,.doc,.md,.txt";

const MODE_DEFAULTS: Record<string, { prompt: string; label: string }> = {
  resume_grounding: {
    prompt: "Upload your current résumé as a PDF.",
    label: "Résumé",
  },
  resume_topics_only: {
    prompt: "Upload your current résumé as a PDF.",
    label: "Résumé",
  },
  session_evidence: {
    prompt: "Upload the document you’ll discuss in this session.",
    label: "Document",
  },
};

const FALLBACK = {
  prompt: "Upload the document this session needs.",
  label: "Document",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Agent-level context, or the first stage that requires an upload. */
export function contextConfigFromAgentData(data: unknown): Record<string, unknown> | null {
  const agent = asRecord(data);
  if (!agent) return null;
  const config = asRecord(agent.config);
  const top = asRecord(config?.context);
  if (top?.required) return top;
  const stages = Array.isArray(agent.stages) ? agent.stages : [];
  for (const stage of stages) {
    const ctx = asRecord(asRecord(asRecord(stage)?.config)?.context);
    if (!ctx?.required) continue;
    return {
      ...ctx,
      prompt: text(top?.prompt) || ctx.prompt,
      label: text(top?.label) || ctx.label,
    };
  }
  return top;
}

export function resolveContextUpload(context: unknown): AgentContextUpload {
  const ctx = asRecord(context);
  const mode = text(ctx?.mode) || "none";
  const required = Boolean(ctx?.required);
  const defaults = MODE_DEFAULTS[mode] ?? FALLBACK;
  const resume = mode === "resume_grounding" || mode === "resume_topics_only";
  return {
    required,
    prompt: required ? text(ctx?.prompt) || defaults.prompt : text(ctx?.prompt),
    label: text(ctx?.label) || defaults.label,
    accept: resume ? RESUME_CONTEXT_ACCEPT : DEFAULT_CONTEXT_ACCEPT,
  };
}

export function contextUploadFromAgentData(data: unknown): AgentContextUpload {
  return resolveContextUpload(contextConfigFromAgentData(data));
}

export function applyLearnerUpload(
  context: Record<string, unknown> | undefined,
  opts: { interviewType: "resume" | "technical"; prompt?: string },
): Record<string, unknown> {
  const next = { ...(context ?? {}) };
  const prompt = opts.prompt?.trim();
  if (opts.interviewType === "resume") {
    if (!text(next.mode) || next.mode === "none") next.mode = "resume_grounding";
    next.required = true;
    next.prompt = prompt || text(next.prompt) || MODE_DEFAULTS.resume_grounding.prompt;
    next.label = text(next.label) || "Résumé";
    return next;
  }
  if (prompt) {
    next.required = true;
    next.prompt = prompt;
    if (!text(next.mode) || next.mode === "none") next.mode = "session_evidence";
    return next;
  }
  return next;
}
