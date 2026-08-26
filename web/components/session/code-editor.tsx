"use client";

import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { LoaderCircle, Play } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  CodeExecutionResult,
  SupportedCodeExecutionLanguage,
} from "@/lib/code-execution";
import {
  CODE_RPC_METHOD,
  codeHighlightExtension,
  handleCodeRpc,
} from "@/lib/code-rpc";
import { useWorkspaceHandlers } from "@/lib/pipecat-workspaces";

const languages = {
  html,
  java,
  javascript,
  python,
  react: () => javascript({ jsx: true }),
} satisfies Record<SupportedCodeExecutionLanguage, () => unknown>;

const labels: Record<SupportedCodeExecutionLanguage, string> = {
  html: "HTML",
  java: "Java",
  javascript: "JavaScript",
  python: "Python",
  react: "React",
};

const extensions = [EditorView.lineWrapping, codeHighlightExtension];
const defaultCode = `// Welcome to the code editor
function greet(name) {
  return \`Hello, \${name}!\`;
}

console.log(greet("World"));`;
const subscribe = () => () => {};
const previewConsoleSource = "mock-interview-code-preview";

type BrowserConsoleEntry = {
  id: number;
  level: "log" | "info" | "warn" | "error";
  text: string;
};

type PreviewTarget = {
  channel: string;
  origin: string;
};

function ExecutionOutput({
  result,
  entries,
}: {
  result: CodeExecutionResult;
  entries: BrowserConsoleEntry[];
}) {
  const output = [result.stdout, result.stderr, result.details]
    .filter(Boolean)
    .join("\n");

  return (
    <div className="min-h-0 overflow-auto rounded-lg border bg-background p-3 font-mono text-xs">
      <div className="mb-2 flex items-center justify-between gap-3 font-sans">
        <span className="font-medium capitalize text-foreground">
          {result.outcome}
        </span>
        <span className="text-muted-foreground">
          {result.executionTimeMs !== null
            ? `${result.executionTimeMs} ms`
            : ""}
        </span>
      </div>
      {output ? (
        <pre className="whitespace-pre-wrap wrap-break-word text-foreground">
          {output}
        </pre>
      ) : null}
      {entries.map((entry) => (
        <pre
          key={entry.id}
          className={
            entry.level === "error"
              ? "whitespace-pre-wrap wrap-break-word text-destructive"
              : entry.level === "warn"
                ? "whitespace-pre-wrap wrap-break-word text-amber-700 dark:text-amber-300"
                : "whitespace-pre-wrap wrap-break-word text-foreground"
          }
        >
          {entry.level === "log" ? "" : `[${entry.level}] `}
          {entry.text}
        </pre>
      ))}
      {!output && !entries.length ? (
        <p className="text-muted-foreground">
          {result.previewUrl
            ? "Preview loaded. Browser console output appears here."
            : "Program completed with no output."}
        </p>
      ) : null}
    </div>
  );
}

export function CodeEditor({
  initialLanguage = "javascript",
  initialCode = defaultCode,
}: {
  initialLanguage?: SupportedCodeExecutionLanguage;
  initialCode?: string;
}) {
  const { resolvedTheme } = useTheme();
  const registerWorkspaceHandler = useWorkspaceHandlers();
  const mounted = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const editorView = useRef<EditorView | null>(null);
  const runController = useRef<AbortController | null>(null);
  const previewFrame = useRef<HTMLIFrameElement | null>(null);
  const previewTarget = useRef<PreviewTarget | null>(null);
  const entryId = useRef(0);
  const [language, setLanguage] =
    useState<SupportedCodeExecutionLanguage>(initialLanguage);
  const [code, setCode] = useState(initialCode);
  const [revision, setRevision] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<CodeExecutionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outputVisible, setOutputVisible] = useState(true);
  const [browserEntries, setBrowserEntries] = useState<BrowserConsoleEntry[]>(
    [],
  );

  useEffect(() => () => runController.current?.abort(), []);

  useEffect(() =>
    registerWorkspaceHandler(CODE_RPC_METHOD, (request) =>
      handleCodeRpc(request, {
        view: editorView.current,
        language,
        revision,
        setLanguage,
        run: runCode,
        cancelRun: () => runController.current?.abort(),
        getOutput: () => ({ result, error, isRunning, browserEntries }),
        clearOutput: resetRun,
        setOutputVisible,
      }),
    ),
  );

  useEffect(() => {
    function handlePreviewMessage(event: MessageEvent) {
      const target = previewTarget.current;
      const data = event.data as Record<string, unknown> | null;
      if (
        !target ||
        event.origin !== target.origin ||
        event.source !== previewFrame.current?.contentWindow ||
        !data ||
        data.source !== previewConsoleSource ||
        data.type !== "console" ||
        data.channel !== target.channel ||
        !["log", "info", "warn", "error", "clear"].includes(
          String(data.level),
        ) ||
        !Array.isArray(data.values) ||
        data.values.length > 20 ||
        !data.values.every(
          (value) => typeof value === "string" && value.length <= 4_000,
        )
      ) {
        return;
      }

      if (data.level === "clear") {
        setBrowserEntries([]);
        return;
      }
      entryId.current += 1;
      const entry: BrowserConsoleEntry = {
        id: entryId.current,
        level: data.level as BrowserConsoleEntry["level"],
        text: data.values.join(" "),
      };
      setBrowserEntries((entries) => [...entries.slice(-199), entry]);
    }

    window.addEventListener("message", handlePreviewMessage);
    return () => window.removeEventListener("message", handlePreviewMessage);
  }, []);

  function resetRun() {
    runController.current?.abort();
    runController.current = null;
    previewTarget.current = null;
    setIsRunning(false);
    setResult(null);
    setError(null);
    setBrowserEntries([]);
  }

  async function runCode(): Promise<
    | CodeExecutionResult
    | { outcome: "error"; error: string }
  > {
    if (!code.trim()) return { outcome: "error", error: "The editor is empty" };
    if (isRunning) return { outcome: "error", error: "Code is already running" };
    const controller = new AbortController();
    runController.current = controller;
    setIsRunning(true);
    setResult(null);
    setError(null);
    setBrowserEntries([]);
    previewTarget.current = null;

    try {
      const response = await fetch("/api/code/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language, code }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          body?.error ?? `Code execution failed: ${response.status}`,
        );
      }
      const nextResult = body as CodeExecutionResult;
      if (runController.current !== controller) {
        return { outcome: "error", error: "Code execution was superseded" };
      }
      if (nextResult.previewUrl && nextResult.consoleChannel) {
        previewTarget.current = {
          channel: nextResult.consoleChannel,
          origin: new URL(nextResult.previewUrl).origin,
        };
      }
      setResult(nextResult);
      return nextResult;
    } catch (runError) {
      const message =
        runError instanceof Error ? runError.message : "Code execution failed";
      if (!controller.signal.aborted) setError(message);
      return { outcome: "error", error: message };
    } finally {
      if (runController.current === controller) {
        runController.current = null;
        setIsRunning(false);
      }
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden p-2">
      <div className="min-h-0 flex-1 overflow-hidden rounded-lg">
        <CodeMirror
          value={code}
          onCreateEditor={(view) => {
            editorView.current = view;
          }}
          height="100%"
          onChange={(value) => {
            if (value.length > 20_000) {
              setError("Code is limited to 20,000 characters.");
              return;
            }
            resetRun();
            setCode(value);
            setRevision((current) => current + 1);
          }}
          extensions={[languages[language]() as never, ...extensions]}
          theme={mounted && resolvedTheme === "dark" ? oneDark : undefined}
          className="h-full overflow-hidden text-foreground [&_.cm-editor]:h-full"
          basicSetup={{
            lineNumbers: true,
            highlightActiveLineGutter: true,
            highlightSpecialChars: true,
            foldGutter: true,
            drawSelection: true,
            dropCursor: true,
            allowMultipleSelections: true,
            indentOnInput: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: true,
            rectangularSelection: true,
            crosshairCursor: false,
            highlightActiveLine: true,
            highlightSelectionMatches: true,
            closeBracketsKeymap: true,
            searchKeymap: true,
            foldKeymap: true,
            completionKeymap: true,
            lintKeymap: true,
          }}
        />
      </div>

      <div className="flex shrink-0 justify-between gap-2 px-2 pb-2 pt-1">
        <Button onClick={runCode} disabled={!code.trim() || isRunning}>
          {isRunning ? <LoaderCircle className="animate-spin" /> : <Play />}
          {isRunning ? "Running" : "Run"}
        </Button>
        <Select
          value={language}
          onValueChange={(value) => {
            resetRun();
            setLanguage(value as SupportedCodeExecutionLanguage);
          }}
        >
          <SelectTrigger className="w-36 bg-popover text-foreground">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(languages) as SupportedCodeExecutionLanguage[]).map(
              (item) => (
                <SelectItem key={item} value={item}>
                  {labels[item]}
                </SelectItem>
              ),
            )}
          </SelectContent>
        </Select>
      </div>

      {outputVisible && (isRunning || error || result) ? (
        <section
          aria-label="Code output"
          className="grid max-h-[42%] shrink-0 gap-2 md:grid-cols-2"
        >
          {result?.previewUrl ? (
            <iframe
              ref={previewFrame}
              src={result.previewUrl}
              title="Code preview"
              className="h-48 w-full rounded-lg border bg-white"
              sandbox="allow-forms allow-modals allow-same-origin allow-scripts"
              referrerPolicy="no-referrer"
            />
          ) : null}
          {isRunning ? (
            <div className="flex h-24 items-center justify-center rounded-lg border bg-background text-sm text-muted-foreground">
              Running code…
            </div>
          ) : error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive mb-2 mx-2">
              {error}
            </div>
          ) : result ? (
            <div className="px-1">
              <ExecutionOutput result={result} entries={browserEntries} />
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
