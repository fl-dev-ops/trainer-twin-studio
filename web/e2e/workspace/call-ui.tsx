import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Room } from "livekit-client";
import { RoomContext } from "@livekit/components-react";
import { SessionConversationLayout } from "@/components/session/session-conversation-layout";
import { SessionSidebar } from "@/components/session/session-sidebar";
import { SessionControlBar } from "@/components/session/session-control-bar";
import { AgentTile } from "@/components/session/agent-tile";
import { CandidateTile } from "@/components/session/candidate-tile";
import { CallComposer } from "@/components/conversation/controls";
import { ConversationWaves } from "@/components/conversation/waves";
import { LiveKitWorkspaceProvider } from "@/lib/livekit-workspaces";
import { Whiteboard } from "@/components/session/whiteboard";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import type { Entry } from "@/lib/session-transcript";

const query = new URLSearchParams(location.search);
if (query.get("theme") !== "light") document.documentElement.classList.add("dark");
function Fixture() {
  const room = useMemo(() => new Room(), []);
  const working = query.get("workspace") === "canvas";
  const isMobile = useIsMobile();
  const [transcript, setTranscript] = useState(true);
  const [mobileTranscript, setMobileTranscript] = useState(false);
  const [composer, setComposer] = useState(false);
  const [ended, setEnded] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([
    { role: "trainer", text: "Tell me about a system you designed and the problem it solved." },
    { role: "user", text: "I built a training platform that brings assessments, feedback and learner progress into one place." },
    { role: "trainer", text: working ? "Sketch the architecture on the whiteboard. Show how the components communicate." : "What was the most important trade-off you made, and why?" },
  ]);
  const send = (text: string) => setEntries(rows => [...rows, { role: "user", text }]);
  return <RoomContext.Provider value={room}><LiveKitWorkspaceProvider onSurface={() => {}}>
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between gap-4 px-6 py-5">
        <span className="text-sm font-semibold">TrainerTwin</span><h1 className="truncate text-sm font-medium">Resume Defense &amp; Cross-Examination</h1><span className="hidden text-xs text-muted-foreground sm:block">Sharing your screen</span>
      </header>
      <main className="relative flex min-h-0 flex-1 px-4 sm:px-6">
        <SessionConversationLayout name="Vasanth" time="02:16" transcriptOpen={transcript}
          portrait={<AgentTile persona="vasanth" photoUrl="/public/vasanth.png" compact={working} />} selfView={<CandidateTile name="You" compact />}
          transcript={<SessionSidebar trainerName="Vasanth" entries={entries} onClose={() => setTranscript(false)} />}
          workspace={working ? <section aria-label="Session workspace" className="dark flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border bg-night text-foreground">
            <Whiteboard question="Curriculum architecture and assessment systems" onSubmit={async () => true} />
          </section> : null} />
        {working && isMobile && <Sheet open={mobileTranscript} onOpenChange={setMobileTranscript}>
          <SheetContent side="bottom" showCloseButton={false} className="h-[70dvh]! max-h-[85dvh] gap-0 overflow-hidden px-4 pb-6">
            <SheetTitle className="sr-only">Transcript</SheetTitle><SheetDescription className="sr-only">Your conversation with Vasanth</SheetDescription>
            <SessionSidebar trainerName="Vasanth" entries={entries} onSendMessage={send} onClose={() => setMobileTranscript(false)} />
          </SheetContent>
        </Sheet>}
      </main>
      <footer className="relative isolate flex shrink-0 flex-col items-center gap-3 overflow-hidden bg-background px-4 pt-4 pb-6">
        <ConversationWaves active />
        {composer && <CallComposer autoFocus name="Vasanth" onSend={send} onClose={() => setComposer(false)} />}
        <SessionControlBar room={room} isConnected chatOpen={working && isMobile ? mobileTranscript : transcript}
          onChatToggle={() => working && isMobile ? setMobileTranscript(value => !value) : setTranscript(value => !value)}
          composerOpen={composer} onComposerToggle={() => setComposer(value => !value)} onEnd={() => setEnded(true)} onAttach={() => {}} />
        {ended && <output>Session ended</output>}
      </footer>
    </div>
  </LiveKitWorkspaceProvider></RoomContext.Provider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
