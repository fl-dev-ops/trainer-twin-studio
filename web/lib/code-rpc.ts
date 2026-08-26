import { redo, undo } from "@codemirror/commands";
import { indentRange } from "@codemirror/language";
import { StateEffect, StateField, type Text } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import type { SupportedCodeExecutionLanguage } from "@/lib/code-execution";

export const CODE_RPC_METHOD = "workspace.code";

export type CodeRpcContext = {
  view: EditorView | null;
  language: SupportedCodeExecutionLanguage;
  revision: number;
  setLanguage: (language: SupportedCodeExecutionLanguage) => void;
  run: () => Promise<unknown>;
  cancelRun: () => void;
  getOutput: () => unknown;
  clearOutput: () => void;
  setOutputVisible: (visible: boolean) => void;
};

type Request = { action?: string; payload?: Record<string, unknown> };

const setHighlights = StateEffect.define<Array<{ from: number; to: number }>>();
export const codeHighlightExtension = StateField.define({
  create: () => Decoration.none,
  update(highlights, transaction) {
    highlights = highlights.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setHighlights)) {
        highlights = Decoration.set(
          effect.value.map(({ from, to }) =>
            Decoration.mark({ class: "agent-code-highlight" }).range(from, to),
          ),
        );
      }
    }
    return highlights;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function range(payload: Record<string, unknown>, length: number) {
  const from = Number(payload.from);
  const to = Number(payload.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > length) {
    throw new Error("Invalid range");
  }
  return { from, to };
}

function lineRange(payload: Record<string, unknown>, doc: Text) {
  const fromLine = Number(payload.fromLine);
  const toLine = Number(payload.toLine);
  if (!Number.isInteger(fromLine) || !Number.isInteger(toLine) || fromLine < 1 || toLine < fromLine || toLine > doc.lines) {
    throw new Error("Invalid line range");
  }
  return { fromLine, toLine, from: doc.line(fromLine).from, to: doc.line(toLine).to };
}

export async function handleCodeRpc(
  raw: string,
  context: CodeRpcContext,
): Promise<string> {
  const request = JSON.parse(raw) as Request;
  const payload = request.payload ?? {};
  const view = context.view;
  const doc = view?.state.doc;

  switch (request.action) {
    case "get_state":
      return JSON.stringify({
        ok: true,
        revision: context.revision,
        result: {
          language: context.language,
          code: doc?.toString() ?? "",
          cursor: view?.state.selection.main.head ?? 0,
          selection: view
            ? {
                from: view.state.selection.main.from,
                to: view.state.selection.main.to,
                text: view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
              }
            : null,
        },
      });

    case "get_selection": {
      if (!view || !doc) throw new Error("Editor is not ready");
      const { from, to } = view.state.selection.main;
      return JSON.stringify({
        ok: true,
        revision: context.revision,
        result: {
          from,
          to,
          text: view.state.sliceDoc(from, to),
          fromLine: doc.lineAt(from).number,
          toLine: doc.lineAt(to).number,
        },
      });
    }

    case "get_range": {
      if (!doc) throw new Error("Editor is not ready");
      const lines = lineRange(payload, doc);
      return JSON.stringify({ ok: true, revision: context.revision, result: { ...lines, text: doc.sliceString(lines.from, lines.to) } });
    }

    case "get_diagnostics":
      return JSON.stringify({ ok: true, revision: context.revision, result: [] });

    case "apply_edits": {
      if (!view || !doc || !Array.isArray(payload.edits)) throw new Error("Editor is not ready");
      const changes = payload.edits.map((edit) => {
        const value = edit as Record<string, unknown>;
        const positions = range(value, doc.length);
        if (typeof value.text !== "string") throw new Error("Invalid edit");
        return { ...positions, insert: value.text };
      });
      view.dispatch({ changes });
      return JSON.stringify({ ok: true, revision: context.revision + 1 });
    }

    case "replace_document":
      if (!view || !doc || typeof payload.text !== "string") throw new Error("Invalid document");
      view.dispatch({ changes: { from: 0, to: doc.length, insert: payload.text } });
      return JSON.stringify({ ok: true, revision: context.revision + 1 });

    case "replace_selection":
      if (!view || typeof payload.text !== "string") throw new Error("Invalid replacement");
      view.dispatch(view.state.replaceSelection(payload.text));
      return JSON.stringify({ ok: true, revision: context.revision + 1 });

    case "insert_at_cursor":
      if (!view || typeof payload.text !== "string") throw new Error("Invalid insertion");
      view.dispatch({ changes: { from: view.state.selection.main.head, insert: payload.text } });
      return JSON.stringify({ ok: true, revision: context.revision + 1 });

    case "format":
      if (!view || !doc) throw new Error("Editor is not ready");
      view.dispatch({ changes: indentRange(view.state, 0, doc.length) });
      return JSON.stringify({ ok: true, revision: context.revision + 1 });

    case "set_language":
      if (!["html", "java", "javascript", "python", "react"].includes(String(payload.language))) throw new Error("Unsupported language");
      context.setLanguage(payload.language as SupportedCodeExecutionLanguage);
      return JSON.stringify({ ok: true, result: { language: payload.language } });

    case "undo":
    case "redo":
      if (!view) throw new Error("Editor is not ready");
      return JSON.stringify({ ok: true, revision: context.revision + 1, result: { changed: request.action === "undo" ? undo(view) : redo(view) } });

    case "select_range": {
      if (!view || !doc) throw new Error("Editor is not ready");
      const { from, to } = range(payload, doc.length);
      view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
      view.focus();
      return JSON.stringify({ ok: true });
    }

    case "select_lines": {
      if (!view || !doc) throw new Error("Editor is not ready");
      const { from, to } = lineRange(payload, doc);
      view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
      view.focus();
      return JSON.stringify({ ok: true });
    }

    case "highlight_range": {
      if (!view || !doc) throw new Error("Editor is not ready");
      const highlighted = range(payload, doc.length);
      view.dispatch({ effects: setHighlights.of([highlighted]) });
      return JSON.stringify({ ok: true });
    }

    case "highlight_lines": {
      if (!view || !doc) throw new Error("Editor is not ready");
      const highlighted = lineRange(payload, doc);
      view.dispatch({ effects: setHighlights.of([highlighted]) });
      return JSON.stringify({ ok: true });
    }

    case "clear_highlights":
      if (!view) throw new Error("Editor is not ready");
      view.dispatch({ effects: setHighlights.of([]) });
      return JSON.stringify({ ok: true });

    case "reveal_range": {
      if (!view || !doc) throw new Error("Editor is not ready");
      const { from } = range(payload, doc.length);
      view.dispatch({ effects: EditorView.scrollIntoView(from, { y: "center" }) });
      return JSON.stringify({ ok: true });
    }

    case "set_cursor":
      if (!view || !doc) throw new Error("Editor is not ready");
      range({ from: payload.position, to: payload.position }, doc.length);
      view.dispatch({ selection: { anchor: Number(payload.position) }, scrollIntoView: true });
      return JSON.stringify({ ok: true });

    case "focus":
      if (!view) throw new Error("Editor is not ready");
      view.focus();
      return JSON.stringify({ ok: true });

    case "run":
      return JSON.stringify({ ok: true, result: await context.run() });
    case "cancel_run":
      context.cancelRun();
      return JSON.stringify({ ok: true });
    case "get_run_status":
      return JSON.stringify({ ok: true, result: context.getOutput() });
    case "get_output":
      return JSON.stringify({ ok: true, result: context.getOutput() });
    case "clear_output":
      context.clearOutput();
      return JSON.stringify({ ok: true });
    case "show_output":
    case "hide_output":
      context.setOutputVisible(request.action === "show_output");
      return JSON.stringify({ ok: true });

    default:
      throw new Error(`Unsupported code action: ${String(request.action)}`);
  }
}
