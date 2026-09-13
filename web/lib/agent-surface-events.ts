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
      highlightLines?: [number, number];
    }
  | {
      key: string;
      tool: "canvas";
      highlightElements?: string[];
      scrollToElements?: string[];
    }
  | { key: string; tool: "pdf"; sourceUrl?: string; fileId?: string; page?: number }
  | { key: string; tool: "presentation"; sourceUrl?: string; slideNumber?: number }
  | { key: string; tool: "image"; sourceUrl?: string; fileId?: string }
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
  const highlightLines =
    Array.isArray(source.highlightLines) &&
    source.highlightLines.length === 2 &&
    typeof source.highlightLines[0] === "number" &&
    typeof source.highlightLines[1] === "number"
      ? (source.highlightLines as [number, number])
      : undefined;
  return {
    key,
    tool: "code",
    language,
    starterCode: typeof starterCode === "string" ? starterCode : "",
    highlightLines,
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
      const highlightElements = Array.isArray(event.highlightElements)
        ? event.highlightElements.map(String)
        : undefined;
      const scrollToElements = Array.isArray(event.scrollToElements)
        ? event.scrollToElements.map(String)
        : undefined;
      return {
        surface: {
          key: `agent-canvas-${String(event.eventId ?? event.questionId ?? "current")}`,
          tool: "canvas",
          highlightElements,
          scrollToElements,
        },
      };
    }
    if (event.type === "open_pdf") {
      const sourceUrl = typeof event.sourceUrl === "string" ? event.sourceUrl : undefined;
      const fileId = typeof event.fileId === "string" ? event.fileId : undefined;
      const page = typeof event.page === "number" ? event.page : undefined;
      return {
        surface: {
          key: `agent-pdf-${String(event.eventId ?? fileId ?? "current")}`,
          tool: "pdf",
          sourceUrl: sourceUrl || (fileId ? `/api/documents/${fileId}/raw` : undefined),
          fileId,
          page,
        },
      };
    }
    if (event.type === "open_image") {
      const sourceUrl = typeof event.sourceUrl === "string" ? event.sourceUrl : undefined;
      const fileId = typeof event.fileId === "string" ? event.fileId : undefined;
      return {
        surface: {
          key: `agent-image-${String(event.eventId ?? fileId ?? "current")}`,
          tool: "image",
          sourceUrl: sourceUrl || (fileId ? `/api/documents/${fileId}/raw` : undefined),
          fileId,
        },
      };
    }
    if (event.type === "open_presentation") {
      const sourceUrl = typeof event.sourceUrl === "string" ? event.sourceUrl : undefined;
      const fileId = typeof event.fileId === "string" ? event.fileId : undefined;
      const slideNumber =
        typeof event.slideNumber === "number"
          ? event.slideNumber
          : typeof event.page === "number"
            ? event.page
            : undefined;
      return {
        surface: {
          key: `agent-presentation-${String(event.eventId ?? fileId ?? "current")}`,
          tool: "presentation",
          sourceUrl: sourceUrl || (fileId ? `/api/documents/${fileId}/raw` : undefined),
          slideNumber,
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
