"use client";

import { useRef, useState } from "react";
import { FileUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PDFViewer } from "@/components/extend/pdf-viewer";

export function PdfViewerSurface({ sourceUrl }: { sourceUrl?: string }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<string | undefined>(sourceUrl);
  const [fileName, setFileName] = useState(
    sourceUrl ? decodeURIComponent(sourceUrl.split("/").pop()?.split("?")[0] || "Document.pdf") : "Document.pdf",
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <input
        ref={fileInput}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.currentTarget.value = "";
          if (!file) return;
          setSource(URL.createObjectURL(file));
          setFileName(file.name);
        }}
      />
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b bg-card px-3">
        <span className="truncate text-sm font-medium">{fileName}</span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => fileInput.current?.click()}
        >
          <FileUp data-icon="inline-start" />
          {source ? "Replace" : "Open"}
        </Button>
      </header>
      <div className="relative min-h-0 flex-1">
        {source ? (
          <PDFViewer src={source} fileName={fileName} className="h-full" showUpload={false} />
        ) : (
          <div className="absolute inset-0 grid place-items-center p-6">
            <div className="flex max-w-sm flex-col items-center gap-4 text-center">
              <div className="grid size-16 place-items-center rounded-2xl border bg-card shadow-sm">
                <FileUp className="size-7" />
              </div>
              <div className="flex flex-col gap-1">
                <h2 className="text-lg font-semibold tracking-tight">Open a PDF</h2>
                <p className="text-sm leading-6 text-muted-foreground">
                  Choose a document to read together. It stays in your browser.
                </p>
              </div>
              <Button size="lg" onClick={() => fileInput.current?.click()}>
                Choose PDF
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
