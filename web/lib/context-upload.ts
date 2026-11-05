export type AgentContextUpload = {
  required: boolean;
  prompt: string;
  label: string;
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

/**
 * Before the call: what the learner may bring (Agent.data.before; twins saved earlier: data.twinSettings).
 * Set on the twin's configure page. Off unless turned on. One of the three phases (before / during / after,
 * plans/roleplay-skill.md).
 */
export type BeforeSettings = {
  preScreenshare: boolean;
  preUpload: boolean;
  duringUpload: boolean;
  uploadTitle: string;
  uploadInstruction: string;
};

export const TWIN_UPLOAD_TITLE_DEFAULT = "Documents";

/**
 * What may be uploaded, fixed for every agent (twins and role plays) and the copilot. Before a call: a PDF or an image,
 * up to 10 MB. During a conversation (a call, a calibration, a copilot chat): an image up to 5 MB or a PDF up to 10 MB.
 * Images are PNG, JPEG or WebP (what the upload verifies from the bytes).
 */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const DURING_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const BEFORE_UPLOAD_ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp";
export const BEFORE_UPLOAD_RULE = "A PDF or an image (PNG, JPEG or WebP), up to 10 MB.";
/** The session start's refusal (the API returns it as a 400). */
export const BEFORE_UPLOAD_REFUSED = `This file can't be used for the conversation. ${BEFORE_UPLOAD_RULE}`;
export const DURING_UPLOAD_ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp";
export const DURING_UPLOAD_RULE = "An image (PNG, JPEG or WebP) up to 5 MB, or a PDF up to 10 MB.";

export type UploadWhen = "before" | "during";
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const extOf = (name: string) => `.${(name.split(".").pop() ?? "").toLowerCase()}`;

/** Why this file can't be uploaded, or null if it can (checked by the browser before uploading, and by the server). */
export function uploadProblem(file: { name: string; size?: number | null }, when: UploadWhen): string | null {
  const ext = extOf(file.name);
  const size = file.size ?? 0;
  if (!(when === "before" ? BEFORE_UPLOAD_ACCEPT : DURING_UPLOAD_ACCEPT).split(",").includes(ext)) {
    return when === "before"
      ? "Only a PDF or an image (PNG, JPEG or WebP) can be added before the conversation."
      : "Only an image (PNG, JPEG or WebP) or a PDF can be added here.";
  }
  if (when === "during" && IMAGE_EXTS.has(ext) && size > DURING_IMAGE_MAX_BYTES) return "That image is over 5 MB. Use a smaller one.";
  if (size > UPLOAD_MAX_BYTES) return "That file is over 10 MB. Use a smaller one.";
  return null;
}

/** Why this file can't be added before the conversation, or null if it can (checked before uploading). */
export const beforeUploadProblem = (file: { name: string; size?: number | null }) => uploadProblem(file, "before");

/** Why this file can't be attached during the conversation, or null if it can (checked before uploading). */
export const duringUploadProblem = (file: { name: string; size?: number | null }) => uploadProblem(file, "during");

/** The server's check on a stored upload (kind and type verified from its bytes at upload). */
export const uploadAllowed = (doc: { kind: string; mimeType: string; size: number | null }, when: UploadWhen) => {
  const size = doc.size ?? 0;
  if (doc.kind === "image") return size <= (when === "during" ? DURING_IMAGE_MAX_BYTES : UPLOAD_MAX_BYTES);
  return doc.mimeType === "application/pdf" && size <= UPLOAD_MAX_BYTES;
};

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
  const maxFiles = typeof ctx?.max_files === "number" && Number.isInteger(ctx.max_files) && ctx.max_files >= 1
    ? Math.min(ctx.max_files, 5)
    : 1;
  return {
    required,
    prompt: required ? text(ctx?.prompt) || defaults.prompt : text(ctx?.prompt),
    label: documentLabel(ctx?.label, defaults.label),
    maxFiles,
    // Role plays: the card shows only when required, any picked document is accepted, the whole screen is
    // always shared, and there is no attaching mid-call.
    offered: required,
    allowed: true,
    screenShare: true,
    duringSession: false,
  };
}

const storedBefore = (data: unknown) => asRecord(asRecord(data)?.before) ?? asRecord(asRecord(data)?.twinSettings);

/** Twins always follow their before settings; any other agent only once it has a `before` block. */
export const usesBeforeSettings = (data: unknown, kind?: string | null) => kind === "TWIN" || asRecord(asRecord(data)?.before) !== null;

export function beforeSettings(data: unknown): BeforeSettings {
  const settings = storedBefore(data);
  return {
    preScreenshare: settings?.preScreenshare === true,
    preUpload: settings?.preUpload === true,
    duringUpload: settings?.duringUpload === true,
    uploadTitle: text(settings?.uploadTitle),
    uploadInstruction: text(settings?.uploadInstruction),
  };
}

/** What the session screen offers for this agent: its before settings, else the older role-play rules. */
export function contextUploadFromAgentData(data: unknown, kind?: string | null): AgentContextUpload {
  if (!usesBeforeSettings(data, kind)) return resolveContextUpload(contextConfigFromAgentData(data));
  const settings = beforeSettings(data);
  return {
    required: false,
    prompt: settings.uploadInstruction,
    label: settings.uploadTitle || TWIN_UPLOAD_TITLE_DEFAULT,
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
