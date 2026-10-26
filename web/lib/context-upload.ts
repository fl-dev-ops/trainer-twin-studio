export type AgentContextUpload = {
  required: boolean;
  prompt: string;
  label: string;
  accept: string;
  maxFiles: number;
  /** Show the upload card before the session even when not required. */
  offered: boolean;
  /** A document may be attached when the session starts. */
  allowed: boolean;
  /** The learner shares their entire screen for the whole session. */
  screenShare: boolean;
  /** The learner may attach a file during the conversation. */
  duringSession: boolean;
};

/** Twin conversation settings (Agent.data.twinSettings), set on the twin's configure page. Off unless turned on. */
export type TwinSettings = {
  preScreenshare: boolean;
  preUpload: boolean;
  duringUpload: boolean;
  uploadTitle: string;
  uploadInstruction: string;
};

export const TWIN_UPLOAD_TITLE_DEFAULT = "Documents";

export const DEFAULT_CONTEXT_ACCEPT =
  ".md,.txt,.pdf,.docx,.doc,.pptx,.ppt,.xlsx,.xls,.csv,.json,.png,.jpg,.jpeg,.webp";
export const RESUME_CONTEXT_ACCEPT = ".pdf,.docx,.doc,.md,.txt";

const MODE_DEFAULTS: Record<string, { prompt: string; label: string }> = {
  resume_grounding: {
    prompt: "Upload your current résumé as a PDF.",
    label: "Documents",
  },
  resume_topics_only: {
    prompt: "Upload your current résumé as a PDF.",
    label: "Documents",
  },
  session_evidence: {
    prompt: "Upload the document you’ll discuss in this session.",
    label: "Documents",
  },
};

const FALLBACK = {
  prompt: "Upload the document this session needs.",
  label: "Documents",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function documentLabel(value: unknown, fallback = "Documents") {
  const label = text(value);
  return label || fallback;
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
  const maxFiles = typeof ctx?.max_files === "number" && Number.isInteger(ctx.max_files) && ctx.max_files >= 1
    ? Math.min(ctx.max_files, 5)
    : 1;
  return {
    required,
    prompt: required ? text(ctx?.prompt) || defaults.prompt : text(ctx?.prompt),
    label: documentLabel(ctx?.label, defaults.label),
    accept: resume ? RESUME_CONTEXT_ACCEPT : DEFAULT_CONTEXT_ACCEPT,
    maxFiles,
    // Role plays: the card shows only when required, any picked document is accepted, the whole screen is
    // always shared, and there is no attaching mid-call.
    offered: required,
    allowed: true,
    screenShare: true,
    duringSession: false,
  };
}

export function twinSettingsFromAgentData(data: unknown): TwinSettings {
  const settings = asRecord(asRecord(data)?.twinSettings);
  return {
    preScreenshare: settings?.preScreenshare === true,
    preUpload: settings?.preUpload === true,
    duringUpload: settings?.duringUpload === true,
    uploadTitle: text(settings?.uploadTitle),
    uploadInstruction: text(settings?.uploadInstruction),
  };
}

/** What the session screen offers for this agent. Twins follow their settings; everything else the role play rules. */
export function contextUploadFromAgentData(data: unknown, kind?: string | null): AgentContextUpload {
  if (kind !== "TWIN") return resolveContextUpload(contextConfigFromAgentData(data));
  const settings = twinSettingsFromAgentData(data);
  return {
    required: false,
    prompt: settings.uploadInstruction,
    label: settings.uploadTitle || TWIN_UPLOAD_TITLE_DEFAULT,
    accept: DEFAULT_CONTEXT_ACCEPT,
    maxFiles: 1,
    offered: settings.preUpload,
    allowed: settings.preUpload,
    screenShare: settings.preScreenshare,
    duringSession: settings.duringUpload,
  };
}

export function applyLearnerUpload(
  context: Record<string, unknown> | undefined,
  opts: {
    interviewType: "resume" | "technical";
    prompt?: string;
    label?: string;
    maxFiles?: number;
  },
): Record<string, unknown> {
  const next = { ...(context ?? {}) };
  const prompt = opts.prompt?.trim();
  const label = opts.label?.trim();
  if (opts.interviewType === "resume") {
    if (!text(next.mode) || next.mode === "none") next.mode = "resume_grounding";
    next.required = true;
    next.prompt = prompt || text(next.prompt) || MODE_DEFAULTS.resume_grounding.prompt;
    next.label = label || text(next.label) || MODE_DEFAULTS.resume_grounding.label;
    next.max_files = opts.maxFiles ?? (typeof next.max_files === "number" ? next.max_files : 1);
    return next;
  }
  if (prompt) {
    next.required = true;
    next.prompt = prompt;
    if (label) next.label = label;
    if (!text(next.mode) || next.mode === "none") next.mode = "session_evidence";
  }
  if (opts.maxFiles) next.max_files = opts.maxFiles;
  return next;
}
