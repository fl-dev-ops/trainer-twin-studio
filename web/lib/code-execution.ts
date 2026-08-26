export type SupportedCodeExecutionLanguage =
  | "html"
  | "java"
  | "javascript"
  | "python"
  | "react";

export type CodeExecutionResult = {
  outcome: "completed" | "error" | "timeout";
  stdout: string;
  stderr: string;
  details: string | null;
  previewUrl: string | null;
  compilationTimeMs: number | null;
  executionTimeMs: number | null;
  memoryKb: number | null;
  consoleChannel: string | null;
};

type ProviderErrorKind = "auth" | "quota" | "provider";

export class CodeExecutionProviderError extends Error {
  constructor(readonly kind: ProviderErrorKind) {
    super(`OneCompiler ${kind} failure`);
    this.name = "CodeExecutionProviderError";
  }
}

const ONECOMPILER_RUN_URL = "https://api.onecompiler.com/v1/run";
const PREVIEW_CONSOLE_SOURCE = "mock-interview-code-preview";

function previewConsoleBridge(channel: string) {
  return `
const previewConsoleChannel = ${JSON.stringify(channel)};
const previewConsoleSource = ${JSON.stringify(PREVIEW_CONSOLE_SOURCE)};
const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  clear: console.clear.bind(console),
};

function serializeConsoleValue(value) {
  if (typeof value === "string") return value;
  if (typeof value === "undefined") return "undefined";
  if (value === null) return "null";
  if (value instanceof Error) return value.stack || value.message;
  try {
    const seen = new WeakSet();
    const serialized = JSON.stringify(value, (_key, nestedValue) => {
      if (typeof nestedValue === "bigint") return nestedValue.toString() + "n";
      if (typeof nestedValue === "object" && nestedValue !== null) {
        if (seen.has(nestedValue)) return "[Circular]";
        seen.add(nestedValue);
      }
      return nestedValue;
    });
    return typeof serialized === "string" ? serialized : String(value);
  } catch {
    return String(value);
  }
}

function emitConsoleMessage(level, values) {
  window.parent.postMessage(
    {
      source: previewConsoleSource,
      type: "console",
      channel: previewConsoleChannel,
      level,
      values: values.map(serializeConsoleValue),
    },
    "*",
  );
}

for (const level of ["log", "info", "warn", "error"]) {
  console[level] = (...values) => {
    originalConsole[level](...values);
    emitConsoleMessage(level, values);
  };
}

console.clear = () => {
  originalConsole.clear();
  emitConsoleMessage("clear", []);
};

window.addEventListener("error", (event) => {
  emitConsoleMessage("error", [event.error || event.message]);
});

window.addEventListener("unhandledrejection", (event) => {
  emitConsoleMessage("error", [event.reason]);
});
`.trim();
}

function injectHtmlBridge(code: string, bridge: string) {
  const bridgeTag = `<script>${bridge}</script>`;
  if (/<head(?:\s[^>]*)?>/i.test(code)) {
    return code.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}\n${bridgeTag}`);
  }
  if (/<body(?:\s[^>]*)?>/i.test(code)) {
    return code.replace(/<body(?:\s[^>]*)?>/i, (body) => `${body}\n${bridgeTag}`);
  }
  return `${bridgeTag}\n${code}`;
}

function maskJavaCommentsAndStrings(code: string) {
  let masked = "";
  let state: "code" | "line-comment" | "block-comment" | "string" | "char" =
    "code";

  for (let index = 0; index < code.length; index += 1) {
    const char = code[index];
    const next = code[index + 1];

    if (state === "code") {
      if (char === "/" && next === "/") {
        masked += "  ";
        index += 1;
        state = "line-comment";
      } else if (char === "/" && next === "*") {
        masked += "  ";
        index += 1;
        state = "block-comment";
      } else if (char === '"') {
        masked += " ";
        state = "string";
      } else if (char === "'") {
        masked += " ";
        state = "char";
      } else {
        masked += char;
      }
      continue;
    }

    if (state === "line-comment") {
      masked += char === "\n" ? "\n" : " ";
      if (char === "\n") state = "code";
      continue;
    }

    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        masked += "  ";
        index += 1;
        state = "code";
      } else {
        masked += char === "\n" ? "\n" : " ";
      }
      continue;
    }

    masked += char === "\n" ? "\n" : " ";
    if (char === "\\") {
      if (next !== undefined) {
        masked += next === "\n" ? "\n" : " ";
        index += 1;
      }
    } else if (
      (state === "string" && char === '"') ||
      (state === "char" && char === "'")
    ) {
      state = "code";
    }
  }

  return masked;
}

function getJavaFilename(code: string) {
  const masked = maskJavaCommentsAndStrings(code);
  let depth = 0;
  let topLevelCode = "";

  for (const char of masked) {
    if (char === "{") {
      depth += 1;
      topLevelCode += " ";
    } else if (char === "}") {
      depth = Math.max(0, depth - 1);
      topLevelCode += " ";
    } else {
      topLevelCode += depth === 0 ? char : " ";
    }
  }

  const declarations = topLevelCode.matchAll(
    /(?:^|[;\n])\s*((?:(?:(?:public|abstract|final|sealed|non-sealed|strictfp)\s+)|(?:@(?!interface\b)[A-Za-z_$][\w$.]*(?:\s*\([^;{}]*\))?\s+))*)(?:class|interface|enum|record|@interface)\s+([A-Za-z_$][\w$]*)\b/gm,
  );

  for (const declaration of declarations) {
    if (/\bpublic\b/.test(declaration[1])) {
      return `${declaration[2]}.java`;
    }
  }
  return "Main.java";
}

function getFiles(
  language: SupportedCodeExecutionLanguage,
  code: string,
  consoleChannel: string | null,
) {
  if (language === "python") {
    return [{ name: "main.py", content: code }];
  }
  if (language === "javascript") {
    return [{ name: "main.js", content: code }];
  }
  if (language === "html") {
    if (!consoleChannel) {
      throw new Error("HTML execution requires a console channel");
    }
    return [
      {
        name: "index.html",
        content: injectHtmlBridge(code, previewConsoleBridge(consoleChannel)),
      },
    ];
  }
  if (language === "react") {
    if (!consoleChannel) {
      throw new Error("React execution requires a console channel");
    }
    return [
      { name: "App.jsx", content: code },
      {
        name: "index.jsx",
        content: `import React from "react";
import ReactDOM from "react-dom/client";

${previewConsoleBridge(consoleChannel)}

import("./App.jsx")
  .then(({ default: App }) => {
    ReactDOM.createRoot(document.getElementById("root")).render(<App />);
  })
  .catch((error) => console.error(error));
`,
      },
      {
        name: "index.html",
        content:
          '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>React code</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/index.jsx"></script>\n  </body>\n</html>\n',
      },
      {
        name: "package.json",
        content: JSON.stringify(
          {
            name: "react",
            private: true,
            version: "1.0.0",
            type: "module",
            scripts: {
              dev: "vite",
              build: "vite build --base ./",
            },
            dependencies: {
              react: "^19.2.7",
              "react-dom": "^19.2.7",
            },
            devDependencies: {
              "@vitejs/plugin-react": "^4.3.4",
              vite: "^5.0.8",
            },
          },
          null,
          2,
        ),
      },
    ];
  }
  return [{ name: getJavaFilename(code), content: code }];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function asNullableString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNullableNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asWebPreviewUrl(language: SupportedCodeExecutionLanguage, value: string) {
  if (
    (language !== "html" && language !== "react") ||
    value.length === 0
  ) {
    return null;
  }
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && url.hostname === "app.onecompiler.com"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function getProviderErrorKind(
  statusCode: number,
  providerError: string,
): ProviderErrorKind {
  if (statusCode === 429 || /\bE002\b|quota|rate limit/i.test(providerError)) {
    return "quota";
  }
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    /\bE00[34]\b|invalid (?:access_token|api key)|(?:access_token|api key) missing/i.test(
      providerError,
    )
  ) {
    return "auth";
  }
  return "provider";
}

export async function executeCode({
  language,
  code,
  apiKey,
  signal,
}: {
  language: SupportedCodeExecutionLanguage;
  code: string;
  apiKey: string;
  signal?: AbortSignal;
}): Promise<CodeExecutionResult> {
  const consoleChannel =
    language === "html" || language === "react" ? crypto.randomUUID() : null;
  const files = getFiles(language, code, consoleChannel);
  const startedAt = Date.now();
  console.info(
    `[EXT-API:onecompiler] start language=${language} files=${files.length}`,
  );

  let response: Response;
  try {
    response = await fetch(ONECOMPILER_RUN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({
        language,
        stdin: "",
        files,
      }),
      cache: "no-store",
      signal,
    });
  } catch (error) {
    console.error(
      `[EXT-API:onecompiler] failed language=${language} elapsedMs=${Date.now() - startedAt}`,
      error,
    );
    throw new CodeExecutionProviderError("provider");
  }

  console.info(
    `[EXT-API:onecompiler] complete language=${language} status=${response.status} elapsedMs=${Date.now() - startedAt}`,
  );

  let rawBody: unknown;
  try {
    rawBody = await response.json();
  } catch {
    if (!response.ok) {
      throw new CodeExecutionProviderError(
        getProviderErrorKind(response.status, ""),
      );
    }
    throw new CodeExecutionProviderError("provider");
  }

  const body = asRecord(rawBody);
  if (!body) {
    if (!response.ok) {
      throw new CodeExecutionProviderError(
        getProviderErrorKind(response.status, ""),
      );
    }
    throw new CodeExecutionProviderError("provider");
  }

  const providerStatus = asString(body.status);
  const providerError = asString(body.error);
  if (!response.ok || providerStatus !== "success") {
    console.error(
      `[EXT-API:onecompiler] provider-failure language=${language} status=${response.status}`,
    );
    throw new CodeExecutionProviderError(
      getProviderErrorKind(response.status, providerError),
    );
  }

  const providerStdout = asString(body.stdout);
  const previewUrl = asWebPreviewUrl(language, providerStdout);
  const stdout = previewUrl ? "" : providerStdout;
  const stderr = asString(body.stderr);
  const details = asNullableString(body.exception) ?? asNullableString(body.error);
  const outcome = /\bE001\b|operation\s+timed?\s*out/i.test(providerError)
    ? "timeout"
    : details || stderr
      ? "error"
      : "completed";

  return {
    outcome,
    stdout,
    stderr,
    details,
    previewUrl,
    compilationTimeMs: asNullableNumber(body.compilationTime),
    executionTimeMs: asNullableNumber(body.executionTime),
    memoryKb: asNullableNumber(body.memoryUsed),
    consoleChannel: previewUrl ? consoleChannel : null,
  };
}
