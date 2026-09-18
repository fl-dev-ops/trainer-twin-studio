"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { CodeViewer } from "@/components/session/code-viewer";
import { useWorkspaceHandlers } from "@/lib/livekit-workspaces";
import { cn } from "@/lib/utils";

const CHOICE_RPC_METHOD = "workspace.choice";

export function ChoicePanel({
  questionId,
  question,
  options,
  code,
  onSubmit,
}: {
  questionId: string;
  question: string;
  options: Array<{ id: string; text: string }>;
  code?: { language: string; content: string };
  onSubmit: (option: { id: string; text: string }) => Promise<void>;
}) {
  const registerWorkspaceHandler = useWorkspaceHandlers();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const submittedRef = useRef(false);
  const highlightedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  submittedRef.current = submitted;
  highlightedIdRef.current = highlightedId;

  useEffect(
    () =>
      registerWorkspaceHandler(CHOICE_RPC_METHOD, async (request) => {
        let parsed: { action?: string; payload?: Record<string, unknown> };
        try {
          parsed = JSON.parse(request) as { action?: string; payload?: Record<string, unknown> };
        } catch {
          throw new Error("Invalid choice command");
        }
        const payload = parsed.payload ?? {};
        if (parsed.action === "get_state") {
          return JSON.stringify({
            ok: true,
            result: {
              questionId,
              question,
              options,
              selectedId: selectedIdRef.current,
              submitted: submittedRef.current,
              highlightedId: highlightedIdRef.current,
            },
          });
        }
        if (parsed.action !== "highlight") {
          throw new Error(`Unsupported choice action: ${String(parsed.action)}`);
        }
        const optionId = String(payload.optionId ?? payload.option_id ?? "").trim();
        if (!options.some((option) => option.id === optionId)) {
          throw new Error(`Unknown option ${optionId}`);
        }
        setHighlightedId(optionId);
        return JSON.stringify({ ok: true, result: { highlightedId: optionId } });
      }),
    [options, question, questionId, registerWorkspaceHandler],
  );

  async function handleSubmit() {
    const option = options.find(({ id }) => id === selectedId);
    if (!option || submitting || submitted) return;
    setSubmitting(true);
    try {
      await onSubmit(option);
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4 overflow-y-auto p-6">
      <p className="text-sm font-medium">{question}</p>
      {code ? <CodeViewer language={code.language} code={code.content} /> : null}
      <div className="space-y-2">
        {options.map((option) => (
          <label
            key={option.id}
            className={cn(
              "flex items-start gap-3 rounded-xl border p-3 text-sm",
              highlightedId === option.id ? "border-white/40 bg-white/5" : "border-white/10",
            )}
          >
            <input
              type="radio"
              name={`question-${questionId}`}
              value={option.id}
              className="mt-0.5"
              checked={selectedId === option.id}
              disabled={submitting || submitted}
              onChange={() => setSelectedId(option.id)}
            />
            <span>
              <span className="font-medium">{option.id}.</span> {option.text}
            </span>
          </label>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {submitted ? "Answer submitted. Waiting for the next question." : "Select one option, then submit your answer."}
        </p>
        <Button type="button" size="sm" disabled={!selectedId || submitting || submitted} onClick={() => void handleSubmit()}>
          {submitting ? "Submitting…" : submitted ? "Submitted" : "Submit answer"}
        </Button>
      </div>
    </div>
  );
}
