import type { SupportedCodeExecutionLanguage } from "@/lib/code-execution";

const languages = new Set<SupportedCodeExecutionLanguage>([
  "html",
  "java",
  "javascript",
  "python",
  "react",
]);

export type AgentSurface =
  | {
      key: string;
      tool: "code";
      language: SupportedCodeExecutionLanguage;
      starterCode: string;
    }
  | { key: string; tool: "canvas" }
  | { key: string; tool: "pdf"; sourceUrl?: string }
  | { key: string; tool: "presentation"; sourceUrl?: string }
  | null;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function codeSurface(source: Record<string, unknown>, key: string): AgentSurface {
  const language = languages.has(
    source.language as SupportedCodeExecutionLanguage,
  )
    ? (source.language as SupportedCodeExecutionLanguage)
    : "javascript";
  const starterCode = source.starterCode ?? source.starter_code ?? "";
  return {
    key,
    tool: "code",
    language,
    starterCode: typeof starterCode === "string" ? starterCode : "",
  };
}

export function parseAgentSurfaceMessage(value: unknown):
  | { surface: AgentSurface }
  | null {
  try {
    const event = record(value);
    if (!event || typeof event.type !== "string") return null;

    if (event.type === "open_code_editor") {
      return {
        surface: codeSurface(
          event,
          `agent-code-${String(event.eventId ?? event.questionId ?? "current")}`,
        ),
      };
    }
    if (event.type === "open_whiteboard") {
      return {
        surface: {
          key: `agent-canvas-${String(event.eventId ?? event.questionId ?? "current")}`,
          tool: "canvas",
        },
      };
    }
    if (event.type === "open_pdf") {
      const sourceUrl = typeof event.sourceUrl === "string" ? event.sourceUrl : undefined;
      return {
        surface: {
          key: `agent-pdf-${String(event.eventId ?? "current")}`,
          tool: "pdf",
          sourceUrl,
        },
      };
    }
    if (event.type === "open_presentation") {
      const sourceUrl = typeof event.sourceUrl === "string" ? event.sourceUrl : undefined;
      return {
        surface: {
          key: `agent-presentation-${String(event.eventId ?? "current")}`,
          tool: "presentation",
          sourceUrl,
        },
      };
    }
    if (event.type === "close_surface") {
      return { surface: null };
    }
    if (event.type !== "interview_question_started") return null;

    const metadata = record(event.metadata);
    const question = record(metadata?.question);
    if (!question || typeof question.id !== "string") return null;
    if (question.surface === "code") {
      return { surface: codeSurface(question, question.id) };
    }
    if (question.surface === "whiteboard") {
      return { surface: { key: question.id, tool: "canvas" } };
    }
    if (question.surface === "verbal" || question.surface === "choice") {
      return { surface: null };
    }
    return null;
  } catch {
    return null;
  }
}

export function parseAgentSurfaceEvent(payload: Uint8Array) {
  try {
    return parseAgentSurfaceMessage(JSON.parse(new TextDecoder().decode(payload)));
  } catch {
    return null;
  }
}
