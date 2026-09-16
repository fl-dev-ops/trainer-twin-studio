"use client";

import Editor from "@monaco-editor/react";
import { LoaderCircle, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { editor } from "monaco-editor";
import type {
  CodeExecutionResult,
  SupportedCodeExecutionLanguage,
} from "@/lib/code-execution";
import { useWorkspaceHandlers } from "@/lib/livekit-workspaces";

const CODE_RPC_METHOD = "workspace.code";
const MAX_CODE_ANSWER_CHARS = 20_000;
const MAX_CODE_RPC_RESPONSE_BYTES = 14 * 1024;
/**
 * RPC contract mirrors the reference interview agent exactly: the only supported
 * actions are `get_range` and `highlight_range` with one-based line numbers.
 */
function serializeCodeRangeResponse(result: {
  fromLine: number;
  toLine: number;
  from: number;
  to: number;
  text: string;
}) {
  const response = JSON.stringify({
    ok: true,
    result: { ...result, truncated: false },
  });
  if (new TextEncoder().encode(response).byteLength > MAX_CODE_RPC_RESPONSE_BYTES) {
    throw new Error("Code range is too large; request fewer lines");
  }
  return response;
}

const LANGUAGE_LABELS: Record<SupportedCodeExecutionLanguage, string> = {
  html: "HTML",
  java: "Java",
  javascript: "JavaScript",
  python: "Python",
  react: "React (JSX)",
};

/** Monaco has no JSX grammar of its own: React answers are edited as JavaScript. */
function monacoLanguage(language: SupportedCodeExecutionLanguage) {
  return language === "react" ? "javascript" : language;
}

type BrowserConsoleEntry = {
  id: number;
  level: "log" | "info" | "warn" | "error";
  text: string;
};

type PreviewConsoleTarget = { channel: string; origin: string };

function ExecutionConsole({
  result,
  browserEntries,
}: {
  result: CodeExecutionResult;
  browserEntries: BrowserConsoleEntry[];
}) {
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return (
    <div className="space-y-3">
      {result.outcome === "timeout" ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-300">
          Execution timed out.
        </p>
      ) : null}
      {stdout.length || stderr.length ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border bg-[#101216] p-3 text-xs leading-relaxed text-foreground/85">
          {stdout}
          {stderr ? (
            <span className="block whitespace-pre-wrap text-destructive">{stderr}</span>
          ) : null}
        </pre>
      ) : null}
      {browserEntries.length ? (
        <div className="rounded-lg border bg-[#101216] p-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Browser console</p>
          <div className="space-y-1 text-xs">
            {browserEntries.map((entry) => (
              <div
                key={entry.id}
                className={
                  entry.level === "error"
                    ? "text-destructive"
                    : entry.level === "warn"
                      ? "text-amber-300"
                      : "text-foreground/85"
                }
              >
                {entry.text}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {!stdout.length && !stderr.length && !browserEntries.length ? (
        <p className="text-sm text-muted-foreground">No output produced.</p>
      ) : null}
    </div>
  );
}

export function CodeEditor({
  initialLanguage = "javascript",
  initialCode,
  instructions,
  highlightLines,
  readOnly = false,
  onSubmit,
}: {
  initialLanguage?: SupportedCodeExecutionLanguage;
  initialCode?: string;
  instructions?: string;
  highlightLines?: [number, number];
  readOnly?: boolean;
  onSubmit?: (language: SupportedCodeExecutionLanguage, code: string) => Promise<void>;
}) {
  const registerWorkspaceHandler = useWorkspaceHandlers();
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const decorationIdsRef = useRef<string[]>([]);
  const runAbortControllerRef = useRef<AbortController | null>(null);
  const previewFrameRef = useRef<HTMLIFrameElement | null>(null);
  const previewConsoleTargetRef = useRef<PreviewConsoleTarget | null>(null);
  const browserConsoleSequenceRef = useRef(0);
  const [language, setLanguage] =
    useState<SupportedCodeExecutionLanguage>(initialLanguage);
  const [code, setCode] = useState(initialCode ?? "");
  const [activeTab, setActiveTab] = useState<"code" | "output">("code");
  const [isRunning, setIsRunning] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [runResult, setRunResult] = useState<CodeExecutionResult | null>(null);
  const [browserConsoleEntries, setBrowserConsoleEntries] = useState<
    BrowserConsoleEntry[]
  >([]);

  useEffect(
    () => () => {
      runAbortControllerRef.current?.abort();
    },
    [],
  );

  useEffect(() =>
    registerWorkspaceHandler(CODE_RPC_METHOD, async (request) => {
      const mountedEditor = editorRef.current;
      const model = mountedEditor?.getModel();
      if (!mountedEditor || !model) {
        throw new Error("Code editor is not ready");
      }
      let parsed: { action?: string; payload?: Record<string, unknown> };
      try {
        parsed = JSON.parse(request) as { action?: string; payload?: Record<string, unknown> };
      } catch {
        throw new Error("Invalid code command");
      }
      const payload = parsed.payload ?? {};

      if (parsed.action === "get_range") {
        const fromLine = Number(payload.fromLine);
        const requestedToLine = Number(payload.toLine);
        if (
          !Number.isInteger(fromLine) ||
          !Number.isInteger(requestedToLine) ||
          fromLine < 1 ||
          requestedToLine < fromLine ||
          fromLine > model.getLineCount()
        ) {
          throw new Error("Invalid code line range");
        }
        const toLine = Math.min(requestedToLine, model.getLineCount());
        return serializeCodeRangeResponse({
          fromLine,
          toLine,
          from: model.getOffsetAt({ lineNumber: fromLine, column: 1 }),
          to: model.getOffsetAt({
            lineNumber: toLine,
            column: model.getLineMaxColumn(toLine),
          }),
          text: model.getValueInRange({
            startLineNumber: fromLine,
            startColumn: 1,
            endLineNumber: toLine,
            endColumn: model.getLineMaxColumn(toLine),
          }),
        });
      }

      if (parsed.action !== "highlight_range") {
        throw new Error(`Unsupported code action: ${String(parsed.action)}`);
      }

      const fromLine = Number(payload.fromLine);
      const requestedToLine = Number(payload.toLine);
      if (
        !Number.isInteger(fromLine) ||
        !Number.isInteger(requestedToLine) ||
        fromLine < 1 ||
        requestedToLine < fromLine ||
        fromLine > model.getLineCount()
      ) {
        throw new Error("Invalid code line range");
      }
      const toLine = Math.min(requestedToLine, model.getLineCount());
      const range = {
        startLineNumber: fromLine,
        startColumn: 1,
        endLineNumber: toLine,
        endColumn: model.getLineMaxColumn(toLine),
      };
      setActiveTab("code");
      decorationIdsRef.current = mountedEditor.deltaDecorations(
        decorationIdsRef.current,
        [
          {
            range,
            options: {
              isWholeLine: true,
              inlineClassName: "agent-code-highlight",
            },
          },
        ],
      );
      requestAnimationFrame(() => {
        mountedEditor.layout();
        mountedEditor.revealRangeInCenter(range);
      });
      return JSON.stringify({ ok: true });
    }));

  // Opening highlight from the surface payload (starter surface can carry a range).
  function applyInitialHighlight(instance: editor.IStandaloneCodeEditor) {
    editorRef.current = instance;
    if (highlightLines && highlightLines.length === 2) {
      const [fromLine, toLine] = highlightLines;
      const model = instance.getModel();
      if (model && fromLine >= 1 && toLine >= fromLine && toLine <= model.getLineCount()) {
        const range = {
          startLineNumber: fromLine,
          startColumn: 1,
          endLineNumber: toLine,
          endColumn: model.getLineMaxColumn(toLine),
        };
        decorationIdsRef.current = instance.deltaDecorations(decorationIdsRef.current, [
          { range, options: { isWholeLine: true, inlineClassName: "agent-code-highlight" } },
        ]);
        requestAnimationFrame(() => {
          instance.layout();
          instance.revealRangeInCenter(range);
        });
      }
    }
  }

  useEffect(() => {
    function handlePreviewMessage(event: MessageEvent) {
      const target = previewConsoleTargetRef.current;
      const data = event.data as Record<string, unknown> | null;
      if (
        !target ||
        event.origin !== target.origin ||
        event.source !== previewFrameRef.current?.contentWindow ||
        !data ||
        data.source !== "mock-interview-code-preview" ||
        data.type !== "console" ||
        data.channel !== target.channel ||
        !["log", "info", "warn", "error", "clear"].includes(String(data.level)) ||
        !Array.isArray(data.values) ||
        data.values.length > 20 ||
        !data.values.every(
          (value) => typeof value === "string" && value.length <= 4_000,
        )
      ) {
        return;
      }
      if (data.level === "clear") {
        setBrowserConsoleEntries([]);
        return;
      }
      browserConsoleSequenceRef.current += 1;
      const entry: BrowserConsoleEntry = {
        id: browserConsoleSequenceRef.current,
        level: data.level as BrowserConsoleEntry["level"],
        text: (data.values as string[]).join(" "),
      };
      setBrowserConsoleEntries((entries) => [...entries.slice(-199), entry]);
    }

    window.addEventListener("message", handlePreviewMessage);
    return () => window.removeEventListener("message", handlePreviewMessage);
  }, []);

  async function handleRun() {
    if (!code.trim() || isRunning) return;
    const abortController = new AbortController();
    runAbortControllerRef.current = abortController;
    setIsRunning(true);
    setRunResult(null);
    previewConsoleTargetRef.current = null;
    setBrowserConsoleEntries([]);
    setActiveTab("output");
    try {
      const response = await fetch("/api/code/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language, code }),
        signal: abortController.signal,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `Code execution failed: ${response.status}`);
      }
      const result = (await response.json()) as CodeExecutionResult;
      if (runAbortControllerRef.current === abortController) {
        previewConsoleTargetRef.current =
          result.previewUrl && result.consoleChannel
            ? {
                channel: result.consoleChannel,
                origin: new URL(result.previewUrl).origin,
              }
            : null;
        setRunResult(result);
      }
    } catch (error) {
      if (abortController.signal.aborted) return;
      console.error(error);
      setActiveTab("code");
      toast.error(error instanceof Error ? error.message : "Code execution failed.");
    } finally {
      if (runAbortControllerRef.current === abortController) {
        runAbortControllerRef.current = null;
        setIsRunning(false);
      }
    }
  }

  const webPreviewUrl =
    language === "html" || language === "react" ? (runResult?.previewUrl ?? null) : null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-card">
      {instructions ? (
        <div className="max-h-32 shrink-0 overflow-y-auto border-b border-white/[0.05] px-4 py-3 text-sm text-foreground/85">
          {instructions}
        </div>
      ) : null}
      <div
        role="tablist"
        aria-label="Code editor views"
        className="flex shrink-0 items-end gap-1 border-b border-white/[0.05] px-3"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "code"}
          onClick={() => setActiveTab("code")}
          className={`cursor-pointer border-b-2 border-transparent px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === "code"
              ? "border-primary text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Code
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "output"}
          onClick={() => setActiveTab("output")}
          className={`cursor-pointer border-b-2 border-transparent px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === "output"
              ? "border-primary text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Output
        </button>
      </div>

      <div className="min-h-0 flex-1">
        <div role="tabpanel" hidden={activeTab !== "code"} className="h-full">
          <Editor
            height="100%"
            theme="vs-dark"
            language={monacoLanguage(language)}
            value={code}
            onMount={applyInitialHighlight}
            onChange={(value) => {
              if (readOnly) return;
              const nextCode = value ?? "";
              if (nextCode.length > MAX_CODE_ANSWER_CHARS) {
                toast.error("Code answers are limited to 20,000 characters.");
                return;
              }
              runAbortControllerRef.current?.abort();
              runAbortControllerRef.current = null;
              setIsRunning(false);
              setCode(nextCode);
              setRunResult(null);
              previewConsoleTargetRef.current = null;
              setBrowserConsoleEntries([]);
              setActiveTab("code");
            }}
            options={{
              minimap: { enabled: false },
              fontSize: 14,
              wordWrap: "on",
              scrollBeyondLastLine: false,
              automaticLayout: true,
              readOnly,
              domReadOnly: readOnly,
            }}
            loading={<p className="p-4 text-sm text-muted-foreground">Loading editor…</p>}
          />
        </div>
        <div
          role="tabpanel"
          hidden={activeTab !== "output"}
          className="h-full overflow-auto bg-background/45 p-4"
        >
          {isRunning ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Running code…
            </div>
          ) : runResult ? (
            <div className="space-y-3">
              {webPreviewUrl ? (
                <div className="h-72 overflow-hidden rounded-lg bg-white sm:h-80">
                  <iframe
                    ref={previewFrameRef}
                    src={webPreviewUrl}
                    title="Code preview"
                    className="size-full border-0 bg-white"
                    sandbox="allow-forms allow-modals allow-same-origin allow-scripts"
                    referrerPolicy="no-referrer"
                  />
                </div>
              ) : null}
              <ExecutionConsole result={runResult} browserEntries={browserConsoleEntries} />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Run your code to see its output here.
            </div>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-white/[0.05] px-4 py-3">
        {!readOnly ? (
          <select
            value={language}
            onChange={(event) => {
              runAbortControllerRef.current?.abort();
              runAbortControllerRef.current = null;
              setIsRunning(false);
              const nextLanguage = event.target.value as SupportedCodeExecutionLanguage;
              setLanguage(nextLanguage);
              setRunResult(null);
              previewConsoleTargetRef.current = null;
              setBrowserConsoleEntries([]);
              setActiveTab("code");
            }}
            className="rounded-lg border border-white/10 bg-[#1a1d23] px-3 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/15"
          >
            {(Object.keys(LANGUAGE_LABELS) as SupportedCodeExecutionLanguage[]).map((lang) => (
              <option key={lang} value={lang}>
                {LANGUAGE_LABELS[lang]}
              </option>
            ))}
          </select>
        ) : <span />}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleRun}
            disabled={!code.trim() || isRunning || isSubmitting}
            className="flex items-center gap-2 rounded-lg border border-white/10 bg-[#1a1d23] px-4 py-1.5 text-sm font-medium text-foreground transition-[background-color,scale] hover:bg-[#232733] active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isRunning ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Play className="size-4" />
            )}
            {isRunning ? "Running…" : "Run"}
          </button>
          {!readOnly && onSubmit ? (
            <button
              type="button"
              onClick={async () => {
                setIsSubmitting(true);
                try {
                  await onSubmit(language, code);
                  toast.success("Code submitted.");
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : "Code submission failed.");
                } finally {
                  setIsSubmitting(false);
                }
              }}
              disabled={!code.trim() || isRunning || isSubmitting}
              className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-[opacity,scale] active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting ? "Submitting…" : "Submit"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
