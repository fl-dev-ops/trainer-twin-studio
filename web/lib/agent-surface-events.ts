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
      questionId: string;
      instructions?: string;
      highlightLines?: [number, number];
      readOnly?: boolean;
    }
  | {
      key: string;
      tool: "choice";
      questionId: string;
      question: string;
      options: Array<{ id: string; text: string }>;
      code?: { language: string; content: string };
    }
  | {
      key: string;
      tool: "canvas";
      questionId: string;
      question: string;
      highlightElements?: string[];
      scrollToElements?: string[];
    }
  | { key: string; tool: "pdf"; sourceUrl?: string; fileId?: string; fileName?: string; page?: number; highlightQuery?: string }
  | { key: string; tool: "presentation"; sourceUrl?: string; slideNumber?: number }
  | { key: string; tool: "image"; sourceUrl?: string; fileId?: string }
  | null;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function questionCode(value: unknown): { language: string; content: string } | undefined {
  const code = record(value);
  return code && typeof code.language === "string" && typeof code.content === "string"
    ? { language: code.language, content: code.content }
    : undefined;
}
export function resolveCodeSurfaceId(source: Record<string, unknown>): string | undefined {
  for (const candidate of [source.questionId, source.eventId, source.commandId]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function codeSurface(source: Record<string, unknown>, key: string, resolvedId?: string): AgentSurface {
  const language = languages.has(
    source.language as SupportedCodeExecutionLanguage,
  )
    ? (source.language as SupportedCodeExecutionLanguage)
    : "javascript";
  const starterCode = source.starterCode ?? source.starter_code ?? source.code ?? "";
  const highlightLines =
    Array.isArray(source.highlightLines) &&
    source.highlightLines.length === 2 &&
    typeof source.highlightLines[0] === "number" &&
    typeof source.highlightLines[1] === "number"
      ? (source.highlightLines as [number, number])
      : undefined;
  const questionId = resolvedId ?? resolveCodeSurfaceId(source) ?? key;
  return {
    key,
    tool: "code",
    questionId,
    language,
    starterCode: typeof starterCode === "string" ? starterCode : "",
    instructions: typeof source.instructions === "string"
      ? source.instructions
      : typeof source.context === "string"
        ? source.context
        : typeof source.question === "string"
          ? source.question
          : undefined,
    highlightLines,
    readOnly: source.readOnly === true || source.read_only === true,
  };
}

export function parseAgentSurfaceMessage(value: unknown):
  | { surface: AgentSurface }
  | null {
  try {
    const event = record(value);
    if (!event || typeof event.type !== "string") return null;

    if (event.type === "open_code_editor") {
      const codeId = resolveCodeSurfaceId(event) ?? "current";
      return {
        surface: codeSurface(
          event,
          `agent-code-${codeId}`,
          codeId,
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
          questionId: String(event.questionId ?? event.eventId ?? "current"),
          question: typeof event.question === "string" ? event.question : "Show your design on the whiteboard.",
          highlightElements,
          scrollToElements,
        },
      };
    }
    if (event.type === "open_choice") {
      const options = Array.isArray(event.options)
        ? event.options.flatMap((value) => {
            const option = record(value);
            return option && typeof option.id === "string" && typeof option.text === "string"
              ? [{ id: option.id, text: option.text }]
              : [];
          })
        : [];
      const questionId = String(event.questionId ?? event.eventId ?? "current");
      return { surface: { key: `agent-choice-${questionId}`, questionId, tool: "choice", question: typeof event.question === "string" ? event.question : "Choose an answer", options, code: questionCode(event.code) } };
    }
    if (event.type === "open_pdf") {
      const sourceUrl = typeof event.sourceUrl === "string" ? event.sourceUrl : undefined;
      const fileId = typeof event.fileId === "string" ? event.fileId : undefined;
      const fileName = typeof event.fileName === "string" ? event.fileName : undefined;
      const page = typeof event.page === "number" ? event.page : undefined;
      const highlightQuery =
        typeof event.highlightQuery === "string"
          ? event.highlightQuery
          : typeof event.highlight === "string"
            ? event.highlight
            : typeof event.query === "string"
              ? event.query
              : undefined;
      return {
        surface: {
          key: `agent-pdf-${String(event.eventId ?? fileId ?? "current")}`,
          tool: "pdf",
          sourceUrl: sourceUrl || (fileId ? `/api/documents/${fileId}/raw` : undefined),
          fileId,
          ...(fileName ? { fileName } : {}),
          page,
          highlightQuery,
        },
      };
    }
    if (event.type === "highlight_pdf" || event.type === "highlight_document") {
      const sourceUrl = typeof event.sourceUrl === "string" ? event.sourceUrl : undefined;
      const fileId = typeof event.fileId === "string" ? event.fileId : undefined;
      const fileName = typeof event.fileName === "string" ? event.fileName : undefined;
      const page = typeof event.page === "number" ? event.page : undefined;
      const highlightQuery =
        typeof event.highlightQuery === "string"
          ? event.highlightQuery
          : typeof event.highlight === "string"
            ? event.highlight
            : typeof event.query === "string"
              ? event.query
              : undefined;
      return {
        surface: {
          key: `agent-pdf-${String(event.eventId ?? fileId ?? "current")}`,
          tool: "pdf",
          sourceUrl: sourceUrl || (fileId ? `/api/documents/${fileId}/raw` : undefined),
          fileId,
          ...(fileName ? { fileName } : {}),
          page,
          highlightQuery,
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
      return {
        surface: {
          key: question.id,
          tool: "canvas",
          questionId: question.id,
          question: typeof question.text === "string" ? question.text : "Show your design on the whiteboard.",
        },
      };
    }
    if (question.surface === "choice") {
      const options = Array.isArray(question.options)
        ? question.options.flatMap((value) => {
            const option = record(value);
            return option && typeof option.id === "string" && typeof option.text === "string"
              ? [{ id: option.id, text: option.text }]
              : [];
          })
        : [];
      return { surface: { key: question.id, questionId: question.id, tool: "choice", question: typeof question.text === "string" ? question.text : "Choose an answer", options, code: questionCode(question.code) } };
    }
    if (question.surface === "verbal") {
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
