"use client";

import { ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  ReactPptxViewer,
  type ParsedPresentation,
  type PptxViewerController,
  type PptxViewerError,
  type PresentationWarning,
} from "@extend-ai/react-pptx";
import {
  ChevronLeft,
  ChevronRight,
  Expand,
  FileUp,
  LoaderCircle,
  Maximize2,
  Minimize2,
  PanelLeft,
  Presentation,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { clampSlideIndex, nextSlideIndex } from "@/lib/presentation";
import {
  handlePresentationRpc,
  PRESENTATION_RPC_METHOD,
} from "@/lib/presentation-rpc";
import { useWorkspaceHandlers } from "@/lib/pipecat-workspaces";
import { cn } from "@/lib/utils";
import "@extend-ai/react-pptx/styles.css";

const zoomSteps = [50, 75, 100, 125, 150, 200];

export function PresentationViewer({ sourceUrl }: { sourceUrl?: string }) {
  const registerWorkspaceHandler = useWorkspaceHandlers();
  const controllerRef = useRef<PptxViewerController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const [source, setSource] = useState<File | string | null>(sourceUrl ?? null);
  const [fileName, setFileName] = useState(
    sourceUrl ? decodeURIComponent(sourceUrl.split("/").pop()?.split("?")[0] || "Presentation") : "",
  );
  const [presentation, setPresentation] = useState<ParsedPresentation | null>(null);
  const [slideCount, setSlideCount] = useState(0);
  const [slideIndex, setSlideIndex] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [showThumbnails, setShowThumbnails] = useState(true);
  const [loading, setLoading] = useState(Boolean(sourceUrl));
  const [error, setError] = useState<string | null>(null);
  const [warningCount, setWarningCount] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() =>
    registerWorkspaceHandler(PRESENTATION_RPC_METHOD, (request) =>
      handlePresentationRpc(request, {
        controller: controllerRef.current,
        presentation,
        fileName,
        slideCount,
        warningCount,
        showThumbnails,
        setShowThumbnails,
        setZoom: async (percent) => {
          await controllerRef.current?.setZoom(percent);
          setZoom(percent);
        },
      }),
    ),
  [fileName, presentation, registerWorkspaceHandler, showThumbnails, slideCount, warningCount]);

  useEffect(() => {
    const onFullscreenChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  const goTo = useCallback(
    async (index: number) => {
      const next = clampSlideIndex(index, slideCount);
      await controllerRef.current?.goToSlide(next, { behavior: "smooth" });
      setSlideIndex(next);
    },
    [slideCount],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!source || event.target instanceof HTMLInputElement) return;
      const next = nextSlideIndex(event.key, slideIndex, slideCount);
      if (next === null) return;
      event.preventDefault();
      void goTo(next);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goTo, slideCount, slideIndex, source]);

  function openFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setSource(file);
    setFileName(file.name);
    setSlideIndex(0);
    setPresentation(null);
    setSlideCount(0);
    setWarningCount(0);
    setError(null);
    setLoading(true);
  }

  async function setViewerZoom(next: number) {
    const normalized = Math.max(25, Math.min(400, next));
    await controllerRef.current?.setZoom(normalized);
    setZoom(normalized);
  }

  function stepZoom(direction: -1 | 1) {
    const next = direction > 0
      ? zoomSteps.find((value) => value > zoom) ?? 400
      : [...zoomSteps].reverse().find((value) => value < zoom) ?? 25;
    void setViewerZoom(next);
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await rootRef.current?.requestFullscreen();
  }

  return (
    <section
      ref={rootRef}
      aria-label="Presentation viewer"
      className="session-surface session-tool-surface flex h-full min-h-0 flex-col overflow-hidden rounded-xl bg-card"
    >
      <input
        ref={fileInputRef}
        className="sr-only"
        type="file"
        accept=".ppt,.pptx,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation"
        onChange={openFile}
      />

      <header className="flex min-h-12 flex-wrap items-center gap-1 border-b bg-card px-2">
        <Button
          aria-label="Toggle slide thumbnails"
          variant={showThumbnails ? "secondary" : "ghost"}
          size="icon-sm"
          disabled={!source}
          onClick={() => setShowThumbnails((visible) => !visible)}
        >
          <PanelLeft />
        </Button>
        <div className="mx-1 hidden min-w-0 flex-1 items-center gap-2 sm:flex">
          <Presentation className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{fileName || "Presentation"}</span>
          {warningCount ? (
            <span className="text-xs text-muted-foreground">{warningCount} rendering warnings</span>
          ) : null}
        </div>

        <Button aria-label="Previous slide" variant="ghost" size="icon-sm" disabled={!source || slideIndex === 0} onClick={() => void goTo(slideIndex - 1)}>
          <ChevronLeft />
        </Button>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          <span className="sr-only">Current slide</span>
          <input
            aria-label="Current slide"
            className="h-7 w-10 rounded-md border bg-background text-center text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            disabled={!source}
            inputMode="numeric"
            value={source ? slideIndex + 1 : 0}
            onChange={(event) => void goTo(Number(event.target.value) - 1)}
          />
          <span>/ {slideCount}</span>
        </label>
        <Button aria-label="Next slide" variant="ghost" size="icon-sm" disabled={!source || slideIndex >= slideCount - 1} onClick={() => void goTo(slideIndex + 1)}>
          <ChevronRight />
        </Button>

        <div className="ml-auto flex items-center gap-1">
          <Button aria-label="Zoom out" variant="ghost" size="icon-sm" disabled={!source || zoom <= 25} onClick={() => stepZoom(-1)}>
            <ZoomOut />
          </Button>
          <button className="min-w-12 text-xs tabular-nums text-muted-foreground" disabled={!source} onClick={() => void setViewerZoom(100)}>
            {zoom}%
          </button>
          <Button aria-label="Zoom in" variant="ghost" size="icon-sm" disabled={!source || zoom >= 400} onClick={() => stepZoom(1)}>
            <ZoomIn />
          </Button>
          <Button aria-label="Fit slide" variant="ghost" size="icon-sm" disabled={!source} onClick={() => void controllerRef.current?.setFitMode("contain")}>
            <Maximize2 />
          </Button>
          <Button aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"} variant="ghost" size="icon-sm" disabled={!source} onClick={() => void toggleFullscreen()}>
            {fullscreen ? <Minimize2 /> : <Expand />}
          </Button>
          <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
            <FileUp data-icon="inline-start" />
            {source ? "Replace" : "Open"}
          </Button>
        </div>
      </header>

      <div className="relative min-h-0 flex-1 bg-muted/40">
        {!source ? (
          <div className="absolute inset-0 grid place-items-center p-6">
            <div className="flex max-w-sm flex-col items-center gap-4 text-center">
              <div className="grid size-16 place-items-center rounded-2xl border bg-card shadow-sm">
                <Presentation className="size-7" />
              </div>
              <div className="flex flex-col gap-1">
                <h2 className="text-lg font-semibold tracking-tight">Bring a deck into the session</h2>
                <p className="text-sm leading-6 text-muted-foreground">Open a PPTX or legacy PPT file. It stays in your browser and is rendered locally.</p>
              </div>
              <Button size="lg" onClick={() => fileInputRef.current?.click()}>
                <FileUp data-icon="inline-start" />
                Choose presentation
              </Button>
            </div>
          </div>
        ) : (
          <ReactPptxViewer
            ref={(controller) => {
              controllerRef.current = controller;
            }}
            source={source}
            mode="slide"
            initialSlide={0}
            zoom={zoom}
            fitMode="contain"
            height="100%"
            showToolbar={false}
            showThumbnails={showThumbnails}
            showSlideLabels={false}
            showDiagnostics={false}
            onLoad={(nextPresentation: ParsedPresentation) => {
              setPresentation(nextPresentation);
              setSlideCount(nextPresentation.document.slides.length);
              setWarningCount(nextPresentation.warnings.length);
            }}
            onReady={() => setLoading(false)}
            onSlideChange={setSlideIndex}
            onWarning={(warning: PresentationWarning) => {
              console.warn("PowerPoint rendering warning:", warning);
              setWarningCount((count) => count + 1);
            }}
            onError={(viewerError: PptxViewerError) => {
              setLoading(false);
              setError(viewerError.message);
            }}
          />
        )}

        {loading ? (
          <div className="absolute inset-0 grid place-items-center bg-background/80 backdrop-blur-sm">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              Rendering presentation…
            </div>
          </div>
        ) : null}
        {error ? (
          <div role="alert" className="absolute inset-0 grid place-items-center bg-background p-6">
            <div className="flex max-w-sm flex-col items-center gap-3 text-center">
              <p className="font-medium">This presentation could not be rendered.</p>
              <p className="text-sm text-muted-foreground">{error}</p>
              <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
                <RotateCcw data-icon="inline-start" />
                Try another file
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <footer className={cn("hidden h-7 items-center justify-between border-t px-3 text-[11px] text-muted-foreground sm:flex", !source && "invisible")}>
        <span>Arrow keys to navigate · Home / End to jump</span>
        <span>{source ? `${slideIndex + 1} of ${slideCount}` : ""}</span>
      </footer>
    </section>
  );
}
