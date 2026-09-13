"use client";

import { useState } from "react";
import { ZoomIn, ZoomOut, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ImageViewerSurface({ sourceUrl, title }: { sourceUrl?: string; title?: string }) {
  const [scale, setScale] = useState(1);
  const fileName = title || (sourceUrl ? decodeURIComponent(sourceUrl.split("/").pop()?.split("?")[0] || "Image") : "Image");

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-muted/20">
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b bg-card px-3">
        <span className="truncate text-sm font-medium">{fileName}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={() => setScale((s) => Math.max(0.25, s - 0.25))}
            aria-label="Zoom out"
          >
            <ZoomOut className="size-4" />
          </Button>
          <span className="min-w-10 text-center text-xs text-muted-foreground">{Math.round(scale * 100)}%</span>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={() => setScale((s) => Math.min(3, s + 0.25))}
            aria-label="Zoom in"
          >
            <ZoomIn className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={() => setScale(1)}
            aria-label="Reset zoom"
          >
            <RotateCcw className="size-4" />
          </Button>
        </div>
      </header>
      <div className="relative flex flex-1 min-h-0 items-center justify-center overflow-auto p-4">
        {sourceUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={sourceUrl}
            alt={fileName}
            style={{ transform: `scale(${scale})`, transformOrigin: "center center", transition: "transform 0.15s ease-out" }}
            className="max-h-full max-w-full rounded-lg object-contain shadow-sm"
          />
        ) : (
          <div className="text-sm text-muted-foreground">No image available</div>
        )}
      </div>
    </div>
  );
}
