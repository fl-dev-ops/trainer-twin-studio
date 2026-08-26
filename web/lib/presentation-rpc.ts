import type {
  ParsedPresentation,
  PptxViewerController,
  SlideNode,
} from "@extend-ai/react-pptx";
import { clampSlideIndex } from "@/lib/presentation";

export const PRESENTATION_RPC_METHOD = "workspace.presentation";

type Request = { action?: string; payload?: Record<string, unknown> };

export type PresentationRpcContext = {
  controller: PptxViewerController | null;
  presentation: ParsedPresentation | null;
  fileName: string;
  slideCount: number;
  warningCount: number;
  showThumbnails: boolean;
  setShowThumbnails: (visible: boolean) => void;
  setZoom: (percent: number) => Promise<void>;
};

function ready(context: PresentationRpcContext) {
  if (!context.controller?.isReady()) throw new Error("Presentation is not ready");
  return context.controller;
}

function nodeText(node: SlideNode): string[] {
  if (node.type === "shape") {
    return node.paragraphs?.map((paragraph) =>
      paragraph.runs.map((run) => run.text).join(""),
    ) ?? [];
  }
  if (node.type === "group") return node.children.flatMap(nodeText);
  if (node.type === "table") {
    return node.rows.flatMap((row) =>
      row.flatMap((cell) =>
        cell.paragraphs.map((paragraph) =>
          paragraph.runs.map((run) => run.text).join(""),
        ),
      ),
    );
  }
  if (node.type === "chart") {
    return [node.title, ...node.series.flatMap((series) => [
      series.name,
      ...(series.categories?.map(String) ?? []),
      ...series.values.map(String),
    ])].filter((value): value is string => Boolean(value));
  }
  return [node.altText].filter((value): value is string => Boolean(value));
}

function state(context: PresentationRpcContext) {
  const controller = context.controller;
  const index = controller?.getSlideIndex() ?? 0;
  return {
    fileName: context.fileName,
    ready: controller?.isReady() ?? false,
    slideCount: context.slideCount,
    slideIndex: index,
    slideNumber: context.slideCount ? index + 1 : 0,
    zoom: controller?.getZoom() ?? 100,
    showThumbnails: context.showThumbnails,
    warningCount: context.warningCount,
  };
}

export async function handlePresentationRpc(
  raw: string,
  context: PresentationRpcContext,
): Promise<string> {
  const request = JSON.parse(raw) as Request;
  const payload = request.payload ?? {};

  switch (request.action) {
    case "get_state":
      return JSON.stringify({ ok: true, result: state(context) });
    case "get_all_slides": {
      const presentation = context.presentation;
      if (!presentation) throw new Error("Presentation is not ready");
      return JSON.stringify({
        ok: true,
        result: {
          ...state(context),
          metadata: presentation.document.metadata,
          slides: presentation.document.slides.map((slide) => ({
            slideNumber: slide.index + 1,
            name: slide.name,
            hidden: slide.hidden ?? false,
            text: [
              ...slide.nodes.flatMap(nodeText),
              ...(slide.notes?.map((note) => note.text) ?? []),
              ...(slide.comments?.map((comment) => comment.text) ?? []),
            ].filter(Boolean),
          })),
        },
      });
    }
    case "next":
      await ready(context).next();
      return JSON.stringify({ ok: true, result: state(context) });
    case "previous":
      await ready(context).previous();
      return JSON.stringify({ ok: true, result: state(context) });
    case "go_to_slide": {
      const slideNumber = Number(payload.slideNumber);
      if (!Number.isInteger(slideNumber) || slideNumber < 1 || slideNumber > context.slideCount) {
        throw new Error(`Slide number must be between 1 and ${context.slideCount}`);
      }
      await ready(context).goToSlide(clampSlideIndex(slideNumber - 1, context.slideCount));
      return JSON.stringify({ ok: true, result: state(context) });
    }
    case "set_zoom": {
      const percent = Number(payload.percent);
      if (!Number.isFinite(percent) || percent < 25 || percent > 400) {
        throw new Error("Zoom must be between 25 and 400 percent");
      }
      await context.setZoom(percent);
      return JSON.stringify({ ok: true, result: state(context) });
    }
    case "fit":
      await ready(context).setFitMode("contain");
      return JSON.stringify({ ok: true, result: state(context) });
    case "set_thumbnails":
      context.setShowThumbnails(Boolean(payload.visible));
      return JSON.stringify({ ok: true, result: { visible: Boolean(payload.visible) } });
    case "search": {
      const query = String(payload.query ?? "").trim();
      if (!query) throw new Error("Search query is required");
      const results = ready(context).search(query);
      return JSON.stringify({
        ok: true,
        result: results.slice(0, 50).map((result, index) => ({
          index,
          slideNumber: result.slideIndex + 1,
          text: result.text,
          snippet: result.snippet,
        })),
      });
    }
    case "highlight_search_result": {
      const query = String(payload.query ?? "").trim();
      const resultIndex = Number(payload.resultIndex);
      const results = ready(context).search(query);
      if (!Number.isInteger(resultIndex) || !results[resultIndex]) {
        throw new Error("Search result not found");
      }
      await ready(context).highlightSearchResult(results[resultIndex]);
      return JSON.stringify({
        ok: true,
        result: { resultIndex, slideNumber: results[resultIndex].slideIndex + 1 },
      });
    }
    case "clear_search_highlights":
      ready(context).clearSearchHighlights();
      return JSON.stringify({ ok: true });
    default:
      throw new Error(`Unsupported presentation action: ${String(request.action)}`);
  }
}
