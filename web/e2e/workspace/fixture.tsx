import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { loader } from "@monaco-editor/react";
import { LiveKitWorkspaceProvider } from "@/lib/livekit-workspaces";
import type { AgentSurface } from "@/lib/agent-surface-events";
import { CodeEditor } from "@/components/session/code-editor";
import { Whiteboard } from "@/components/session/whiteboard";
import { ChoicePanel } from "@/components/session/choice";
import { PdfViewerSurface } from "@/components/session/pdf-viewer";
import { ImageViewerSurface } from "@/components/session/image-viewer";
import { PresentationViewer } from "@/components/session/presentation-viewer";

loader.config({ paths: { vs: "/monaco/vs" } });
const query = new URLSearchParams(location.search);
function Fixture() {
  const [surface, setSurface] = useState<AgentSurface>(null);
  const [ended, setEnded] = useState(false);
  const [active, setActive] = useState(true);
  const [opens, setOpens] = useState(0);
  const pending = useRef<((value: { status: string }) => void) | null>(null);
  const open = (next: AgentSurface) => {
    setOpens((value) => value + 1);
    setSurface(next);
    if (next?.tool === "pdf" && next.exactHighlight) return new Promise<{ status: string }>((resolve) => { pending.current = resolve; });
  };
  return <LiveKitWorkspaceProvider sessionId={query.get("session")!} runtimeToken={query.get("token")!} active={active}
    onSurface={open} onEndSession={() => setEnded(true)}>
    <output data-testid="surface">{surface?.tool ?? "none"}</output>
    <output data-testid="ended">{String(ended)}</output>
    <output data-testid="opens">{opens}</output>
    <button onClick={() => setActive((value) => !value)}>Toggle connection</button>
    <main style={{ height: 650, width: 1000 }} key={surface?.key}>
      {surface?.tool === "code" && <CodeEditor initialLanguage={surface.language} initialCode={surface.starterCode} instructions={surface.instructions} readOnly={surface.readOnly} />}
      {surface?.tool === "canvas" && <Whiteboard question={surface.question} onSubmit={async () => true} />}
      {surface?.tool === "choice" && <ChoicePanel questionId={surface.questionId} question={surface.question} options={surface.options} onSubmit={async () => {}} />}
      {surface?.tool === "pdf" && <PdfViewerSurface sourceUrl={surface.sourceUrl} initialPage={surface.page} highlightQuery={surface.highlightQuery}
        exactHighlight={surface.exactHighlight} resumeDocument={surface.resumeDocument} searchRequestId={surface.searchRequestId}
        onHighlightResult={(_id, status) => { pending.current?.({ status }); pending.current = null; }} />}
      {surface?.tool === "image" && <ImageViewerSurface sourceUrl={surface.sourceUrl} />}
      {surface?.tool === "presentation" && <PresentationViewer sourceUrl={surface.sourceUrl} initialSlideNumber={surface.slideNumber} />}
    </main>
  </LiveKitWorkspaceProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
