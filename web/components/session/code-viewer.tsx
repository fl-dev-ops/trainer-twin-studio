"use client";

import Editor from "@monaco-editor/react";
import { useTheme } from "next-themes";

const LANGUAGE_LABELS: Record<string, string> = {
  html: "HTML/CSS/JavaScript",
  java: "Java",
  javascript: "JavaScript",
  js: "JavaScript",
  jsx: "React (JSX)",
  python: "Python",
  react: "React (JSX)",
  ts: "TypeScript",
  tsx: "React (TSX)",
  typescript: "TypeScript",
};

function monacoLanguage(language: string) {
  const normalized = language.trim().toLowerCase();
  if (["react", "jsx", "js", "node", "nodejs"].includes(normalized)) return "javascript";
  if (["tsx", "ts"].includes(normalized)) return "typescript";
  return normalized || "javascript";
}

/** Displays question code with the same Monaco syntax engine as the coding workspace. */
export function CodeViewer({ language, code }: { language: string; code: string }) {
  const { resolvedTheme } = useTheme();
  const lineCount = code.split("\n").length;
  const height = Math.min(360, Math.max(120, lineCount * 21 + 24));
  const normalizedLanguage = language.trim().toLowerCase();

  return (
    <div className="overflow-hidden rounded-lg border border-white/10 bg-[#101216]">
      <div className="border-b border-white/10 px-3 py-2 text-xs font-medium text-muted-foreground">
        {LANGUAGE_LABELS[normalizedLanguage] ?? language}
      </div>
      <Editor
        height={height}
        theme={resolvedTheme === "light" ? "light" : "vs-dark"}
        language={monacoLanguage(language)}
        value={code}
        options={{
          readOnly: true,
          domReadOnly: true,
          minimap: { enabled: false },
          fontSize: 14,
          lineHeight: 21,
          wordWrap: "off",
          scrollBeyondLastLine: false,
          automaticLayout: true,
          folding: false,
          glyphMargin: false,
          lineDecorationsWidth: 8,
          overviewRulerLanes: 0,
          renderLineHighlight: "none",
          padding: { top: 12, bottom: 12 },
        }}
        loading={<p className="p-3 text-sm text-muted-foreground">Loading code…</p>}
      />
    </div>
  );
}
