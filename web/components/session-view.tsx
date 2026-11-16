"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import { Check, LoaderCircle, Play, ScreenShare, Upload as UploadIcon, Volume2 } from "lucide-react";
import { type AgentContextUpload, BEFORE_UPLOAD_ACCEPT, beforeUploadProblem, DURING_UPLOAD_ACCEPT, duringUploadProblem } from "@/lib/context-upload";
import { attachedMessage, uploadFile } from "@/lib/upload-client";
import "@livekit/components-styles";
import {
  RoomAudioRenderer,
  RoomContext,
  useConnectionState,
} from "@livekit/components-react";
import {
  ParticipantKind,
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type TranscriptionSegment,
  DisconnectReason,
  ConnectionState,
} from "livekit-client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AgentTile } from "@/components/session/agent-tile";
import { CallComposer } from "@/components/conversation/controls";
import { ConversationWaves } from "@/components/conversation/waves";
import { SessionConversationLayout } from "@/components/session/session-conversation-layout";
import { CandidateTile } from "@/components/session/candidate-tile";
import { SessionControlBar } from "@/components/session/session-control-bar";
import { SessionSidebar } from "@/components/session/session-sidebar";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { ReportIssueButton } from "@/components/report-issue-button";
import { ChoicePanel } from "@/components/session/choice";
import { CodeEditor } from "@/components/session/code-editor";
import { Whiteboard } from "@/components/session/whiteboard";
import { PresentationViewer } from "@/components/session/presentation-viewer";
import { PreJoin, type PreJoinMediaSettings } from "@/components/session/prejoin";
import { PdfViewerSurface } from "@/components/session/pdf-viewer";
import { ImageViewerSurface } from "@/components/session/image-viewer";
import { LiveKitWorkspaceProvider } from "@/lib/livekit-workspaces";
import { downloadIntroVideo } from "@/lib/intro-video-cache";
import type { AgentSurface } from "@/lib/agent-surface-events";
import type { Entry } from "@/lib/session-transcript";
import { cn } from "@/lib/utils";

type Coverage = Record<string, string>;
type EndReason = "completed" | "manual" | "disconnected" | "time_up";
/** A call that ends this close to its time limit ran out of minutes (the agent ends it there), not lost its connection. */
const TIME_UP_MARGIN_MS = 30_000;
type WhiteboardAcknowledgement = { accepted: boolean; message?: string };

const SURFACE_STATE_PUBLISH_INTERVAL_MS = 5_000;

function screenShareSurface(room: Room) {
  const publication = [...room.localParticipant.videoTrackPublications.values()]
    .find((track) => track.source === Track.Source.ScreenShare);
  return publication?.track?.mediaStreamTrack.getSettings().displaySurface;
}

async function enableWholeScreenShare(room: Room) {
  await room.localParticipant.setScreenShareEnabled(true);
  const surface = screenShareSurface(room);
  if (surface === "monitor") return;
  await room.localParticipant.setScreenShareEnabled(false);
  throw new Error(surface
    ? "Select Entire Screen, not a browser tab or window."
    : "This browser could not verify an entire-screen share.");
}

type SessionConnection = {
  url: string;
  token: string;
  roomName: string;
  sessionId: string;
  runtimeToken: string;
};

type Props = {
  personas: string[];
  agents: string[];
  contexts: { id: string; name: string; size?: number }[];
  agentNames?: Record<string, string>;
  initialAgent?: string;
  agentPersonas?: Record<string, string>;
  agentContextRequired?: Record<string, boolean>;
  agentContextUploads?: Record<string, AgentContextUpload>;
  sessionCode?: string;
  scenarioName?: string;
  userName?: string;
  organizationName?: string;
  organizationLogo?: string | null;
  /** Playable intro video per scenario slug. */
  introVideos?: Record<string, string | null>;
  /** Each agent's persona photo (presigned), shown on the trainer's tile. */
  agentPhotos?: Record<string, string | null>;
  /** Learner-facing entries: no start button, the session starts on page load. */
  autoStart?: boolean;
  /** The learner's practice minutes left, shown before joining (null: not metered). */
  minutesLeft?: number | null;
};

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function SessionView({
  personas,
  agents,
  contexts,
  agentNames = {},
  initialAgent,
  agentPersonas = {},
  agentContextRequired = {},
  agentContextUploads = {},
  sessionCode,
  scenarioName,
  userName,
  organizationName,
  organizationLogo = null,
  introVideos = {},
  agentPhotos = {},
  autoStart = false,
  minutesLeft = null,
}: Props) {
  // One stable Room instance for the whole mount
  const room = useMemo(
    () =>
      new Room({
        adaptiveStream: true,
        audioCaptureDefaults: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
      }),
    [],
  );

  const roomState = useConnectionState(room);
  const workspaceConnected = roomState === ConnectionState.Connected;
  const [agent, setAgent] = useState(initialAgent ?? agents[0] ?? "");
  const persona = agentPersonas[agent] ?? personas[0] ?? "";
  const [contextIds, setContextIds] = useState<string[]>([]);
  const contextId = contextIds[0] ?? "";
  // Earlier uploads that fit the before-the-call rule (a PDF or an image, up to 10 MB); the session start checks again.
  const [contextList, setContextList] = useState<{ id: string; name: string; size?: number }[]>(() => contexts.filter((c) => !beforeUploadProblem(c)));
  const [uploadingContext, setUploadingContext] = useState(false);
  const contextInput = useRef<HTMLInputElement>(null);

  const [launched, setLaunched] = useState(false);
  /** Seconds left on the "Get ready" screen before the session starts; null when not counting down. */
  const [countdown, setCountdown] = useState<number | null>(null);
  const [prejoinComplete, setPrejoinComplete] = useState(!sessionCode);
  const [prejoinMedia, setPrejoinMedia] = useState<PreJoinMediaSettings>({
    microphoneEnabled: true,
    cameraEnabled: false,
    screenShareEnabled: true,
  });
  const [connection, setConnection] = useState<SessionConnection | null>(null);
  const [connected, setConnected] = useState(false);
  const [agentInRoom, setAgentInRoom] = useState(false);
  const [error, setError] = useState("");
  const [saveFailed, setSaveFailed] = useState(false);
  const [ended, setEnded] = useState(false);
  const [completedSessionId, setCompletedSessionId] = useState<string | null>(null);
  const [endReason, setEndReason] = useState<EndReason>("disconnected");
  const [introDone, setIntroDone] = useState(false);
  const [introPlaybackSrc, setIntroPlaybackSrc] = useState<string | null>(null);

  const [entries, setEntries] = useState<Entry[]>([]);
  const [coverage, setCoverage] = useState<Coverage>({});
  const [surface, setSurface] = useState<AgentSurface>(null);
  const [surfaceRevision, setSurfaceRevision] = useState(0);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isScreenSharePending, setIsScreenSharePending] = useState(false);
  const [screenShareAttempted, setScreenShareAttempted] = useState(false);
  const [screenShareError, setScreenShareError] = useState("");
  const screenShareAutoPromptedRef = useRef(false);
  const screenShareValidationPendingRef = useRef(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileTranscriptOpen, setMobileTranscriptOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const isMobile = useIsMobile();
  const [latestSpokenText, setLatestSpokenText] = useState("");
  const [elapsed, setElapsed] = useState(0);

  const reduceMotion = useReducedMotion();

  const startedRef = useRef(false);
  const releasedRef = useRef(false);
  const endingRef = useRef(false);
  const pendingEndReasonRef = useRef<EndReason>("disconnected");
  /** When the call's minutes run out (ms since epoch), from the start's secondsLeft; null when not metered. */
  const deadlineRef = useRef<number | null>(null);
  const entriesRef = useRef<Entry[]>([]);
  const coverageRef = useRef<Coverage>({});
  const finalizedRef = useRef(false);
  const surfaceKeyRef = useRef<string | null>(null);
  const uiReportRevisionRef = useRef(0);
  const surfaceRevisionRef = useRef(0);
  const lastSurfaceStatePublishedAtRef = useRef(0);
  const whiteboardAcknowledgementsRef = useRef(
    new Map<string, (acknowledgement: WhiteboardAcknowledgement) => void>(),
  );
  const pendingResumeHighlightRef = useRef(new Map<string, {
    resolve: (result: { status: string }) => void;
    timer: ReturnType<typeof setTimeout>;
  }>());

  useEffect(() => {
    entriesRef.current = entries;
    coverageRef.current = coverage;
  }, [entries, coverage]);

  const introSrc = introVideos[agent] ?? null;

  // Kick the intro download off on the pre-join screen, before the session exists.
  // That way a 100 MB clip never has to race the agent's held greeting mid-session.
  const prefetchRef = useRef<string | null>(null);
  useEffect(() => {
    if (!introSrc || prefetchRef.current === introSrc) return;
    prefetchRef.current = introSrc;
    downloadIntroVideo(introSrc)
      .then((url) => {
        setIntroPlaybackSrc(url);
      })
      .catch((err) => {
        console.error("Intro video prefetch failed:", err);
        // Fall back to direct streaming; ScenarioIntro's own safeguards apply.
        setIntroPlaybackSrc(introSrc);
      });
  }, [introSrc]);

  const resetSessionState = useCallback(() => {
    startedRef.current = false;
    releasedRef.current = false;
    endingRef.current = false;
    finalizedRef.current = false;
    setConnection(null);
    setConnected(false);
    setLaunched(false);
    setCountdown(null);
    setAgentInRoom(false);
    setError("");
    setSaveFailed(false);
    setEndReason("disconnected");
    setIntroDone(false);
    setEntries([]);
    setCoverage({});
    surfaceKeyRef.current = null;
    surfaceRevisionRef.current = 0;
    lastSurfaceStatePublishedAtRef.current = 0;
    setSurface(null);
    setSurfaceRevision(0);
    setIsScreenSharing(false);
    setIsScreenSharePending(false);
    setScreenShareAttempted(false);
    setScreenShareError("");
    screenShareAutoPromptedRef.current = false;
    screenShareValidationPendingRef.current = false;
    setLatestSpokenText("");
    setElapsed(0);
  }, []);

  const contextUpload = agentContextUploads[agent] ?? (
    agentContextRequired[agent]
      ? { required: true, prompt: "", label: "Documents", offered: true }
      : null
  );
  const isContextRequired = Boolean(contextUpload?.required ?? agentContextRequired[agent]);
  const documentLabel = contextUpload?.label || "Documents";
  // Role-play defaults when the agent has no resolved settings: whole screen shared, documents accepted, no mid-call attach.
  const screenShareRequired = contextUpload?.screenShare ?? true;
  const documentsAllowed = contextUpload?.allowed ?? true;
  const attachDuringSession = contextUpload?.duringSession ?? false;

  const handleStartSession = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    setError("");
    // A document picked for another scenario is not sent to an agent that takes none.
    const ids = documentsAllowed ? contextIds : [];
    try {
      const launchResponse = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          sessionCode
            ? { shareCode: sessionCode, contextId: ids[0] || undefined, contextIds: ids, holdOpening: true }
            : { agentSlug: agent, contextId: ids[0] || undefined, contextIds: ids, holdOpening: true },
        ),
      });
      const launch = await launchResponse.json().catch(() => ({}));
      if (!launchResponse.ok || !launch.session?.id || !launch.session?.runtimeToken) {
        throw new Error(launch.error ?? "Could not create session");
      }
      deadlineRef.current = typeof launch.session.secondsLeft === "number" ? Date.now() + launch.session.secondsLeft * 1000 : null;
      const livekitUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;
      if (!launch.participantToken || !livekitUrl) {
        throw new Error("Voice session credentials were not returned");
      }

      setConnection({
        url: livekitUrl,
        token: launch.participantToken,
        roomName: launch.room ?? launch.session.id,
        sessionId: launch.session.id,
        runtimeToken: launch.session.runtimeToken,
      });
    } catch (e) {
      // startedRef stays set: the get-ready countdown calls this every second, and a refused start must not be
      // re-sent on each tick. "Try again" (handleRetry) clears it.
      setError(e instanceof Error ? e.message : "Failed to start session");
      if (!autoStart) setLaunched(false);
    }
  }, [agent, contextIds, documentsAllowed, sessionCode, autoStart]);

  const handleRetry = useCallback(() => {
    startedRef.current = false;
    setError("");
    void handleStartSession();
  }, [handleStartSession]);

  useEffect(() => {
    if (!autoStart || !prejoinComplete || ended || !agent || !persona || launched || countdown !== null) return;
    if (isContextRequired && contextIds.length === 0) return;
    // Deliberately NOT waiting on the intro download: a ~100 MB clip would otherwise
    // sit between "Join now" and the session. ScenarioIntro streams the presigned
    // URL (S3 serves 206 range requests) and the prefetch blob is used if it lands first.
    void Promise.resolve().then(() => setCountdown(GET_READY_SECONDS));
  }, [autoStart, prejoinComplete, ended, agent, persona, launched, countdown, isContextRequired, contextIds]);

  // "Get ready": a short pause so the learner isn't talked at the moment the page opens. The session (room,
  // agent dispatch, join) starts with the countdown; the agent holds its opening until "begin-opening", which is
  // sent only once the countdown is over, so the trainer can't start speaking underneath it.
  useEffect(() => {
    if (countdown === null) return;
    void Promise.resolve().then(handleStartSession); // once: startedRef guards repeat calls
    const id = setTimeout(() => {
      if (countdown > 1) return setCountdown(countdown - 1);
      setCountdown(null);
      setLaunched(true);
    }, 1000);
    return () => clearTimeout(id);
  }, [countdown, handleStartSession]);

  useEffect(() => {
    if (!connection || connected) return;
    let cancelled = false;
    room
      .connect(connection.url, connection.token)
      .then(() => {
        if (!cancelled) setConnected(true);
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("LiveKit connect failed:", e);
        setError("Could not connect to the session. Check your connection and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [room, connection, connected]);

  useEffect(() => {
    if (!connected || !prejoinMedia.speakerDeviceId) return;
    void room
      .switchActiveDevice("audiooutput", prejoinMedia.speakerDeviceId)
      .catch((speakerError) => console.error("Could not apply speaker choice:", speakerError));
  }, [room, connected, prejoinMedia.speakerDeviceId]);

  useEffect(() => {
    const syncScreenShareState = () => {
      if (!room.localParticipant.isScreenShareEnabled) {
        setIsScreenSharing(false);
        return;
      }
      const surface = screenShareSurface(room);
      if (surface !== "monitor") {
        setIsScreenSharing(false);
        setScreenShareError(surface
          ? "Select Entire Screen, not a browser tab or window."
          : "This browser could not verify an entire-screen share.");
        if (!screenShareValidationPendingRef.current) {
          void room.localParticipant.setScreenShareEnabled(false).catch((error) => {
            console.error("Could not stop a non-screen share:", error);
          });
        }
        return;
      }
      setScreenShareError("");
      setIsScreenSharing(true);
    };
    syncScreenShareState();
    room.on(RoomEvent.LocalTrackPublished, syncScreenShareState);
    room.on(RoomEvent.LocalTrackUnpublished, syncScreenShareState);
    const checkSurface = window.setInterval(syncScreenShareState, 1000);
    return () => {
      room.off(RoomEvent.LocalTrackPublished, syncScreenShareState);
      room.off(RoomEvent.LocalTrackUnpublished, syncScreenShareState);
      window.clearInterval(checkSurface);
    };
  }, [room]);

  // Prompt for screen share immediately as soon as the room connects on entry (when the agent asks for it)
  useEffect(() => {
    if (!screenShareRequired || !connected || screenShareAutoPromptedRef.current || ended) return;
    screenShareAutoPromptedRef.current = true;
    screenShareValidationPendingRef.current = true;
    setIsScreenSharePending(true);
    void (async () => {
      try {
        await enableWholeScreenShare(room);
      } catch (shareErr) {
        console.info("Whole-screen sharing was not started on join:", shareErr);
        setScreenShareError(shareErr instanceof Error ? shareErr.message : "Select Entire Screen to continue.");
      } finally {
        screenShareValidationPendingRef.current = false;
        setIsScreenSharePending(false);
        setScreenShareAttempted(true);
      }
    })();
  }, [connected, room, ended, screenShareRequired]);

  useEffect(() => {
    if (!connected) return;
    const markAgent = () => setAgentInRoom(true);
    if (room.remoteParticipants.size > 0) {
      markAgent();
      return;
    }
    room.on(RoomEvent.ParticipantConnected, markAgent);
    return () => {
      room.off(RoomEvent.ParticipantConnected, markAgent);
    };
  }, [room, connected]);

  useEffect(() => {
    if (!connected || !agentInRoom || ended || !launched) return;
    if (introSrc && !introDone) return;
    if (releasedRef.current) return;
    releasedRef.current = true;
    void (async () => {
      try {
        await room.localParticipant.setMicrophoneEnabled(
          prejoinMedia.microphoneEnabled,
          prejoinMedia.microphoneDeviceId ? { deviceId: prejoinMedia.microphoneDeviceId } : undefined,
        );
      } catch (micError) {
        console.error("Could not apply microphone choice:", micError);
      }
      try {
        await room.localParticipant.setCameraEnabled(
          prejoinMedia.cameraEnabled,
          prejoinMedia.cameraDeviceId ? { deviceId: prejoinMedia.cameraDeviceId } : undefined,
        );
      } catch (cameraError) {
        console.error("Could not apply camera choice:", cameraError);
      }
      try {
        await room.localParticipant.publishData(
          new TextEncoder().encode(JSON.stringify({ type: "begin-opening" })),
          { reliable: true },
        );
      } catch (dataError) {
        console.error("Could not release agent opening:", dataError);
      }
    })();
  }, [room, connected, agentInRoom, ended, launched, introSrc, introDone, prejoinMedia]);

  const finalizeSession = useCallback(
    async (status: "completed" | "abandoned") => {
      if (!connection) throw new Error("Session connection is unavailable");
      if (finalizedRef.current) return;
      finalizedRef.current = true;
      try {
        // The browser's transcript only (evidence is the agent's and the server's: specs/practice.md rule 22).
        const body = JSON.stringify({ sessionId: connection.sessionId, status, transcript: entriesRef.current });
        const response = await fetch("/api/sessions/finalize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          // keepalive survives the page closing, but browsers refuse it over 64 KB: a long call's end is a normal request.
          keepalive: body.length < 60_000,
        });
        if (!response.ok) throw new Error(`Session save failed (${response.status})`);
      } catch (saveError) {
        finalizedRef.current = false;
        throw saveError;
      }
    },
    [connection],
  );

  const handleDisconnect = useCallback(
    async (ended: EndReason) => {
      if (endingRef.current) return;
      endingRef.current = true;
      // Ended at its time limit (the agent cuts the call there): the minutes ran out, the practice is complete.
      const timeUp = ended !== "manual" && deadlineRef.current !== null && Date.now() >= deadlineRef.current - TIME_UP_MARGIN_MS;
      const reason: EndReason = timeUp ? "time_up" : ended;
      pendingEndReasonRef.current = reason;
      try {
        await finalizeSession(reason === "completed" || reason === "time_up" ? "completed" : "abandoned");
      } catch (saveError) {
        console.error("Could not save session", saveError);
        setSaveFailed(true);
        setError("Your session could not be saved. Please try again before closing this tab.");
        endingRef.current = false;
        return;
      }
      setCompletedSessionId(connection?.sessionId ?? null);
      await room.disconnect().catch(() => {});
      resetSessionState();
      setEndReason(reason);
      setEnded(true);
    },
    [connection, room, finalizeSession, resetSessionState],
  );

  const handleSendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setEntries((prev) => [...prev, { role: "user" as const, text: trimmed }]);
      try {
        // RoomIO listens on lk.chat: interrupt STT wait, then generate_reply.
        await room.localParticipant.sendText(trimmed, { topic: "lk.chat" });
      } catch (err) {
        console.error("Could not send chat message:", err);
      }
    },
    [room],
  );

  const [attaching, setAttaching] = useState(false);
  const attachInput = useRef<HTMLInputElement>(null);
  /** Mid-call file: upload it, link it to this session, then tell the twin which file to read (it reads by ID). */
  const handleAttach = useCallback(
    async (file: File) => {
      if (!connection) return;
      const problem = duringUploadProblem(file);
      if (problem) return void toast.error(problem);
      setAttaching(true);
      try {
        const doc = await uploadFile(file, { purpose: "during", shareCode: sessionCode });
        const linked = await fetch(`/api/sessions/${encodeURIComponent(connection.sessionId)}/documents`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ documentId: doc.id }),
        });
        const result = await linked.json().catch(() => null);
        if (!linked.ok) throw new Error(result?.error ?? "Could not attach the file");
        // The bridge turns the marker into the file itself for the agent (chat/agent/channels/openai-compat.ts).
        await handleSendMessage(attachedMessage(doc));
        toast.success(`${doc.name} attached`);
      } catch (attachError) {
        toast.error(attachError instanceof Error ? attachError.message : "Could not attach the file");
      } finally {
        setAttaching(false);
      }
    },
    [connection, sessionCode, handleSendMessage],
  );

  const handleSurface = useCallback((nextSurface: AgentSurface) => {
    const nextKey = nextSurface?.key ?? null;
    if (surfaceKeyRef.current !== nextKey) {
      surfaceKeyRef.current = nextKey;
      surfaceRevisionRef.current = 0;
      setSurfaceRevision(0);
    }
    setSurface(nextSurface);
    if (nextSurface?.tool === "pdf" && nextSurface.exactHighlight && nextSurface.searchRequestId) {
      return new Promise<{ status: string }>((resolve) => {
        const requestId = nextSurface.searchRequestId!;
        const timer = setTimeout(() => {
          pendingResumeHighlightRef.current.delete(requestId);
          resolve({ status: "viewer_unavailable" });
        }, 12_000);
        pendingResumeHighlightRef.current.set(requestId, { resolve, timer });
      });
    }
  }, []);

  const handleResumeHighlightResult = useCallback((requestId: string, status: string) => {
    const pending = pendingResumeHighlightRef.current.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingResumeHighlightRef.current.delete(requestId);
    pending.resolve({ status });
  }, []);

  const handleSurfaceContentChange = useCallback(() => {
    surfaceRevisionRef.current += 1;
    setSurfaceRevision(surfaceRevisionRef.current);
  }, []);

  useEffect(() => {
    if (!connected) return;
    const elapsed = Date.now() - lastSurfaceStatePublishedAtRef.current;
    const delay = surfaceRevision === 0
      ? 0
      : Math.max(0, SURFACE_STATE_PUBLISH_INTERVAL_MS - elapsed);
    const timeout = window.setTimeout(() => {
      const visible = surface?.tool === "code" || surface?.tool === "canvas";
      const question = surface?.tool === "code"
        ? surface.instructions ?? "Complete the coding task shown in the editor."
        : surface?.tool === "canvas"
          ? surface.question
          : "";
      const payload = new TextEncoder().encode(JSON.stringify({
        type: "candidate_surface_state",
        visible,
        surface: surface?.tool === "canvas" ? "whiteboard" : surface?.tool === "code" ? "code" : null,
        question_id: visible ? surface.questionId : null,
        question,
        question_type: surface?.tool === "canvas" ? "system-design" : surface?.tool === "code" ? "coding" : null,
        content_revision: surfaceRevision,
      }));
      lastSurfaceStatePublishedAtRef.current = Date.now();
      room.localParticipant.publishData(payload, {
        reliable: true,
        topic: "candidate.surface_state",
      }).catch((publishError) => {
        lastSurfaceStatePublishedAtRef.current = 0;
        console.error("Could not publish candidate surface state:", publishError);
      });
    }, delay);
    return () => window.clearTimeout(timeout);
  }, [connected, room, surface, surfaceRevision]);

  const handleEnableScreenShare = useCallback(async () => {
    if (isScreenSharePending) return;
    screenShareValidationPendingRef.current = true;
    setIsScreenSharePending(true);
    try {
      await enableWholeScreenShare(room);
    } catch (shareError) {
      console.error("Could not start screen sharing:", shareError);
      setScreenShareError(shareError instanceof Error ? shareError.message : "Select Entire Screen to continue.");
      toast.error(
        shareError instanceof DOMException && shareError.name === "NotAllowedError"
          ? "Screen sharing was cancelled or denied."
          : shareError instanceof Error ? shareError.message : "Could not start screen sharing on this device.",
      );
    } finally {
      screenShareValidationPendingRef.current = false;
      setIsScreenSharePending(false);
    }
  }, [isScreenSharePending, room]);

  // Browser-confirmed screen state is durable session truth; the brain reads it
  // through getSessionContext instead of inferring it from LiveKit RPC history.
  useEffect(() => {
    if (!connection || ended || !workspaceConnected) return;
    const controller = new AbortController();
    uiReportRevisionRef.current = Math.max(Date.now(), uiReportRevisionRef.current + 1);
    const revision = uiReportRevisionRef.current;
    const timer = setTimeout(() => {
      void (async () => {
        for (let attempt = 0; attempt < 3 && !controller.signal.aborted; attempt++) {
          const response = await fetch(`/api/sessions/${connection.sessionId}/ui-state`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${connection.runtimeToken}`,
        },
        body: JSON.stringify({ active: surface?.tool ?? null, key: surface?.key ?? null, revision }),
        signal: controller.signal,
          }).catch(() => null);
          if (response?.ok) return;
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        }
      })();
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [connection, ended, surface, workspaceConnected]);

  const handleChoiceSubmission = useCallback(async (option: { id: string; text: string }) => {
    if (surface?.tool !== "choice") return;
    await room.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify({
        type: "mcq-submission",
        questionId: surface.questionId,
        optionId: option.id,
        optionText: option.text,
        submitted: true,
      })),
      { reliable: true },
    );
  }, [room, surface]);

  const handleCodeSubmission = useCallback(async (questionId: string, language: string, code: string) => {
    const submissionId = crypto.randomUUID();
    const chunks = code.match(/[\s\S]{1,10000}/g) ?? [];
    if (!chunks.length) throw new Error("Enter code before submitting.");
    for (const [index, chunk] of chunks.entries()) {
      await room.localParticipant.publishData(
        new TextEncoder().encode(JSON.stringify({
          type: "code-submission",
          submissionId,
          questionId,
          language,
          index,
          total: chunks.length,
          chunk,
          submitted: true,
        })),
        { reliable: true },
      );
    }
  }, [room]);

  const handleWhiteboardSubmission = useCallback(async (
    questionId: string,
    question: string,
    submission: { blob: Blob; imageSha256: string },
  ): Promise<boolean> => {
    if (!connection || !room.localParticipant.identity) return false;
    const revision = 0;
    const acknowledgementKey = `${questionId}:${revision}`;
    let acknowledgementTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const authorization = { Authorization: `Bearer ${connection.token}` };
      const uploadResponse = await fetch("/api/whiteboard-upload", {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json" },
        body: JSON.stringify({
          roomName: connection.roomName,
          participantIdentity: room.localParticipant.identity,
          questionId,
          revision,
          imageSha256: submission.imageSha256,
          imageBytes: submission.blob.size,
        }),
      });
      if (!uploadResponse.ok) throw new Error(`Whiteboard upload setup failed with ${uploadResponse.status}`);
      const upload = await uploadResponse.json() as {
        uploadUrl?: unknown;
        s3Key?: unknown;
        headers?: unknown;
      };
      if (
        typeof upload.uploadUrl !== "string" ||
        typeof upload.s3Key !== "string" ||
        !upload.headers ||
        typeof upload.headers !== "object"
      ) {
        throw new Error("Whiteboard upload setup returned an invalid response");
      }

      const uploadStartedAt = Date.now();
      console.info(`[EXT-API:s3-whiteboard] upload_started question_id=${questionId} bytes=${submission.blob.size}`);
      const s3Response = await fetch(upload.uploadUrl, {
        method: "PUT",
        headers: upload.headers as Record<string, string>,
        body: submission.blob,
      });
      if (!s3Response.ok) throw new Error(`Whiteboard S3 upload failed with ${s3Response.status}`);
      console.info(
        `[EXT-API:s3-whiteboard] upload_completed question_id=${questionId} bytes=${submission.blob.size} elapsed_ms=${Date.now() - uploadStartedAt}`,
      );

      const evaluationResponse = await fetch("/api/evaluate", {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          roomName: connection.roomName,
          participantIdentity: room.localParticipant.identity,
          questionId,
          revision,
          imageSha256: submission.imageSha256,
          imageBytes: submission.blob.size,
          s3Key: upload.s3Key,
        }),
      });
      if (!evaluationResponse.ok) throw new Error(`Whiteboard evaluation failed with ${evaluationResponse.status}`);
      const signedAssessment = await evaluationResponse.json() as { payload?: unknown; signature?: unknown };
      if (typeof signedAssessment.payload !== "string" || typeof signedAssessment.signature !== "string") {
        throw new Error("Whiteboard evaluation returned an invalid response");
      }

      const acknowledgement = new Promise<WhiteboardAcknowledgement>((resolve) => {
        whiteboardAcknowledgementsRef.current.set(acknowledgementKey, resolve);
      });
      acknowledgementTimeout = setTimeout(() => {
        const resolve = whiteboardAcknowledgementsRef.current.get(acknowledgementKey);
        if (resolve) {
          whiteboardAcknowledgementsRef.current.delete(acknowledgementKey);
          resolve({ accepted: false, message: "The interviewer did not acknowledge the drawing." });
        }
      }, 15_000);
      await room.localParticipant.publishData(
        new TextEncoder().encode(JSON.stringify({
          type: "whiteboard-evaluation",
          payload: signedAssessment.payload,
          signature: signedAssessment.signature,
        })),
        { reliable: true },
      );
      const accepted = await acknowledgement;
      if (!accepted.accepted) throw new Error(accepted.message ?? "The whiteboard was rejected");
      return true;
    } catch (error) {
      whiteboardAcknowledgementsRef.current.delete(acknowledgementKey);
      console.error("Could not submit whiteboard:", error);
      return false;
    } finally {
      if (acknowledgementTimeout) clearTimeout(acknowledgementTimeout);
    }
  }, [connection, room]);

  useEffect(() => {
    if (!connection) return;
    const activeConnection = connection;

    function handleTranscription(segments: TranscriptionSegment[], participant: { identity?: string } | undefined) {
      const isUser = participant?.identity === room.localParticipant.identity;
      for (const seg of segments) {
        if (isUser && seg.text) {
          // Clear trainer subtitle text when candidate starts speaking
          setLatestSpokenText("");
        } else if (!isUser && seg.text) {
          // Update trainer subtitles immediately with active streaming or final text
          setLatestSpokenText(seg.text);
        }

        if (!seg.final) continue;
        const role = isUser ? ("user" as const) : ("trainer" as const);
        setEntries((prev) => {
          const last = prev[prev.length - 1];
          if (role === "trainer" && last?.role === "trainer" && (last.text === seg.text || seg.text.startsWith(last.text))) {
            const next = [...prev.slice(0, -1), { role, text: seg.text }];
            entriesRef.current = next;
            return next;
          }
          const next = [...prev, { role, text: seg.text }];
          entriesRef.current = next;
          return next;
        });

        if (!isUser && activeConnection.sessionId) {
          void fetch(`/api/sessions/${activeConnection.sessionId}`, {
            headers: activeConnection.runtimeToken
              ? { Authorization: `Bearer ${activeConnection.runtimeToken}` }
              : {},
          })
            .then((res) => (res.ok ? res.json() : null))
            .then((snap) => {
              if (snap?.coverage) {
                setCoverage(snap.coverage);
                coverageRef.current = snap.coverage;
              }
            })
            .catch(() => {});
        }
      }
    }

    function handleData(payload: Uint8Array, participant?: RemoteParticipant) {
      try {
        const text = new TextDecoder().decode(payload);
        const data = JSON.parse(text) as Record<string, unknown>;
        if (data.type === "session-ended" && data.status === "completed") {
          void handleDisconnect("completed");
        } else if (data.type === "interview_question_started") {
          const metadata = data.metadata as { question?: { spokenText?: string } } | undefined;
          if (metadata?.question?.spokenText) {
            const spoken = metadata.question.spokenText;
            setLatestSpokenText(spoken);
            setEntries((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "trainer" && last.text === spoken) return prev;
              const next = [...prev, { role: "trainer" as const, text: spoken }];
              entriesRef.current = next;
              return next;
            });
          }
        } else if (data.type === "whiteboard_answer_status") {
          if (participant?.kind !== ParticipantKind.AGENT) return;
          const questionId = typeof data.questionId === "string" ? data.questionId : "";
          const revision = typeof data.revision === "number" ? data.revision : -1;
          const resolve = whiteboardAcknowledgementsRef.current.get(`${questionId}:${revision}`);
          if (resolve) {
            whiteboardAcknowledgementsRef.current.delete(`${questionId}:${revision}`);
            resolve({
              accepted: data.status === "accepted",
              message: typeof data.message === "string" ? data.message : undefined,
            });
          }
        } else if (data.type === "screen_feedback_highlight") {
          if (participant?.kind !== ParticipantKind.AGENT) return;
          const questionId = typeof data.questionId === "string" ? data.questionId : "";
          const fromLine = Number(data.fromLine);
          const toLine = Number(data.toLine);
          if (
            Number.isInteger(fromLine) &&
            Number.isInteger(toLine) &&
            fromLine >= 1 &&
            toLine >= fromLine
          ) {
            setSurface((current) => current?.tool === "code" && current.questionId === questionId
              ? { ...current, highlightLines: [fromLine, toLine] as [number, number] }
              : current);
          }
        }
      } catch {}
    }

    function handleRoomDisconnected(reason?: DisconnectReason) {
      if (endingRef.current) return;
      // The same person joined this call from another tab (a resume): the call goes on there, so don't end it here
      // (specs/practice.md rule 18).
      if (reason === DisconnectReason.DUPLICATE_IDENTITY) return;
      void handleDisconnect("disconnected");
    }

    room.on(RoomEvent.TranscriptionReceived, handleTranscription);
    room.on(RoomEvent.DataReceived, handleData);
    room.on(RoomEvent.Disconnected, handleRoomDisconnected);

    return () => {
      room.off(RoomEvent.TranscriptionReceived, handleTranscription);
      room.off(RoomEvent.DataReceived, handleData);
      room.off(RoomEvent.Disconnected, handleRoomDisconnected);
    };
  }, [room, connection, handleDisconnect, resetSessionState]);

  useEffect(() => {
    if (!launched || ended) return;
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [launched, ended]);

  useEffect(() => {
    return () => {
      void room.disconnect().catch(() => {});
    };
  }, [room]);

  const title = scenarioName ?? agentNames[agent] ?? agent.replaceAll("-", " ");
  const trainerName = persona.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Trainer";

  if (sessionCode && !prejoinComplete) {
    return (
      <PreJoin
        scenarioName={title}
        userName={userName ?? "You"}
        organizationName={organizationName ?? "TrainerTwin"}
        organizationLogo={organizationLogo}
        contexts={contextList}
        contextRequired={isContextRequired}
        contextOffered={Boolean(contextUpload?.offered)}
        screenShare={screenShareRequired}
        contextPrompt={contextUpload?.prompt}
        contextLabel={contextUpload?.label}
        sessionCode={sessionCode}
        minutesLeft={minutesLeft}
        onJoin={(settings, contextId) => {
          setPrejoinMedia(settings);
          setContextIds(contextId ? [contextId] : []);
          setPrejoinComplete(true);
        }}
      />
    );
  }

  if (ended) {
    return (
      <div className="flex h-dvh w-dvw flex-col bg-panel text-foreground">
        <SessionHeader title={title} linkHome={!sessionCode} />
        <main className="grid min-h-0 flex-1 place-items-center overflow-y-auto p-6">
        <Card size="lg" raised className="w-full max-w-md text-center">
          {sessionCode && completedSessionId && endReason !== "disconnected" ? (
            <>
              {endReason === "time_up" ? (
                <p className="m-0 px-6 pt-6 text-sm text-muted-foreground">Time&apos;s up: this call used the last of your practice minutes. Ask your trainer for more to practise again.</p>
              ) : null}
              <SessionFeedback scenarioName={scenarioName} sessionId={completedSessionId} />
            </>
          ) : (
            <>
              <CardHeader>
                <CardTitle>{endReason === "completed" ? "Session complete" : endReason === "time_up" ? "Time's up" : "Session ended"}</CardTitle>
                <CardDescription>
                  {endReason === "time_up"
                    ? sessionCode
                      ? "This call used the last of your practice minutes; it has been saved. Ask your trainer for more to practise again."
                      : "This call reached its time limit and has been saved. You can start another call if your organization has enough credits."
                    : sessionCode
                    ? endReason === "disconnected"
                      ? "The connection closed unexpectedly. Any captured session data has been saved. You may close this tab."
                      : "Your responses have been saved. You may close this tab."
                    : endReason === "disconnected"
                      ? "The connection closed unexpectedly. Any captured session data has been saved."
                      : "Your transcript and recording are being saved in Sessions."}
                </CardDescription>
              </CardHeader>
              {sessionCode ? <PractiseAgainActions /> : null}
              {!sessionCode && (
                <CardContent className="flex justify-center gap-2">
                  <Button variant="outline" className="h-10" nativeButton={false} render={<Link href="/sessions" />}>
                    View sessions
                  </Button>
                  <Button
                    className="h-10"
                    onClick={() => {
                      resetSessionState();
                      setEnded(false);
                    }}
                  >
                    <Play data-icon="inline-start" /> New session
                  </Button>
                </CardContent>
              )}
            </>
          )}
        </Card>
        </main>
      </div>
    );
  }

  if (countdown !== null) {
    return (
      <div className="flex h-dvh w-dvw flex-col overflow-hidden bg-panel text-foreground">
        <SessionHeader title={title} linkHome={!sessionCode} />
        <main className="flex min-h-0 flex-1 px-4 pb-20 sm:px-6">
          <div className="flex min-h-0 flex-1">
            <div role="status" className="relative flex size-full flex-col items-center justify-center gap-5 p-6 text-center">
              <span className="relative grid size-24 place-items-center rounded-full bg-card shadow-elevation-2">
                <span aria-hidden className="absolute inset-0 animate-spin rounded-full border-2 border-foreground/10 border-t-foreground/60 motion-reduce:animate-none" />
                <span className="text-4xl font-semibold tabular-nums">{countdown}</span>
              </span>
              <div className="flex max-w-sm flex-col gap-1.5">
                <h2 className="text-xl font-semibold tracking-title">Get ready</h2>
                <p className="text-sm text-muted-foreground">
                  {trainerName} will start the conversation in a moment. Find a quiet spot and check your mic.
                </p>
              </div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (sessionCode && prejoinComplete && !launched && (!isContextRequired || contextIds.length > 0)) {
    return (
      <div className="grid min-h-svh place-items-center bg-panel text-foreground">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <LoaderCircle className="size-5 animate-spin" /> Preparing your session…
        </div>
      </div>
    );
  }

  if (!launched) {
    return (
      <div className="flex h-dvh w-dvw flex-col overflow-hidden bg-panel text-foreground">
        <SessionHeader title={title} linkHome={!sessionCode} />

        <main className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4 sm:p-6">
          <div className="w-full max-w-md">
            <Card size="lg" raised className="w-full">
              <CardHeader>
                <CardTitle className="text-xl font-semibold tracking-title">Start a practice session</CardTitle>
                <CardDescription>
                  You’ll join as a learner. {trainerName} is already set up for this scenario.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <label className="flex flex-col gap-1.5 text-sm">
                  <span className="font-medium">Scenario</span>
                  <Select
                    value={agent}
                    items={Object.fromEntries(agents.map((a) => [a, agentNames[a] ?? a.replaceAll("-", " ")]))}
                    onValueChange={(v) => v !== null && setAgent(v)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Scenario" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectLabel>Scenarios</SelectLabel>
                        {agents.map((a) => (
                          <SelectItem key={a} value={a}>{agentNames[a] ?? a.replaceAll("-", " ")}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </label>

                {documentsAllowed ? (
                <label className="flex flex-col gap-1.5 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{documentLabel}</span>
                    {isContextRequired && (
                      <span className="text-overline font-medium text-caution">
                        Required
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Select
                      value={contextId || "none"}
                      items={{ none: "None", ...Object.fromEntries(contextList.map((c) => [c.id, c.name])) }}
                      onValueChange={(v) => {
                        if (!v || v === "none") setContextIds([]);
                        else setContextIds([v]);
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select a document" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectLabel>Uploaded documents</SelectLabel>
                          <SelectItem value="none">None</SelectItem>
                          {contextList.map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              {c.name} · {formatBytes(c.size ?? 0)}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <input
                      ref={contextInput}
                      type="file"
                      accept={BEFORE_UPLOAD_ACCEPT}
                      hidden
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.currentTarget.value = "";
                        if (!file) return;
                        const problem = beforeUploadProblem(file);
                        if (problem) return setError(problem);
                        setUploadingContext(true);
                        setError("");
                        try {
                          const data = await uploadFile(file, { purpose: "before", shareCode: sessionCode });
                          setContextList((prev) => [
                            ...prev,
                            { id: data.id, name: data.name, size: file.size },
                          ]);
                          // Single-selection: newly uploaded file becomes the selected document
                          setContextIds([data.id]);
                        } catch (uploadError) {
                          setError(uploadError instanceof Error ? uploadError.message : "Upload failed");
                        } finally {
                          setUploadingContext(false);
                        }
                      }}
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      className="shrink-0"
                      aria-label="Upload document"
                      disabled={uploadingContext}
                      onClick={() => contextInput.current?.click()}
                    >
                      {uploadingContext ? <LoaderCircle className="animate-spin" /> : <UploadIcon />}
                    </Button>
                  </div>
                </label>
                ) : null}

                {error && (
                  <p role="alert" className="text-sm text-destructive">{error}</p>
                )}

                <Button size="xl"
                  onClick={() => setCountdown(GET_READY_SECONDS)}
                  disabled={!persona || !agent || (isContextRequired && contextIds.length === 0)}
                  className="mt-2 w-full"
                >
                  <Play data-icon="inline-start" /> Start session
                </Button>
              </CardContent>
            </Card>
          </div>
        </main>
      </div>
    );
  }

  const elapsedLabel = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;

  return (
    <div className="flex h-dvh w-dvw flex-col overflow-hidden bg-background text-foreground">
      <RoomContext.Provider value={room}>
        <LiveKitWorkspaceProvider
          sessionId={connection?.sessionId}
          runtimeToken={connection?.runtimeToken}
          onSurface={handleSurface}
          onEndSession={() => void handleDisconnect("completed")}
          active={workspaceConnected && (introSrc ? introDone : true)}
        >
          <SessionHeader title={title} linkHome={!sessionCode}>
            {isScreenSharing && (
              <span className="hidden items-center gap-1.5 rounded-full bg-success-subtle px-3 py-1 text-xs font-medium text-success sm:flex">
                <span aria-hidden className="size-2 animate-pulse rounded-full bg-success" />
                Sharing your screen
              </span>
            )}
            {sessionCode ? <ReportIssueButton /> : null}
          </SessionHeader>

          <main className="relative flex min-h-0 flex-1 px-4 sm:px-6">
            {/* Blocking overlay when screen sharing is stopped */}
            {screenShareRequired && connected && !isScreenSharing && screenShareAttempted && !isScreenSharePending && (
              <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/30 p-6 backdrop-blur-sm">
                <div className={cn("flex w-full max-w-md flex-col items-center rounded-tt-lg border border-card-border bg-card p-7 text-center shadow-elevation-2 duration-200 animate-in fade-in zoom-in-95")}>
                  <div className="mb-4 grid size-14 place-items-center rounded-2xl bg-primary/10 text-primary">
                    <ScreenShare className="size-7" />
                  </div>
                  <h3 className="text-xl font-semibold tracking-title">Share your entire screen</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {screenShareError || "Choose Entire Screen in the browser picker so your trainer can review your work throughout the session. Tabs and windows are not accepted."}
                  </p>
                  <div className="mt-6 w-full flex flex-col gap-2.5">
                    <Button
                      type="button"
                      size="xl"
                      disabled={isScreenSharePending}
                      onClick={() => void handleEnableScreenShare()}
                      className="w-full"
                    >
                      <ScreenShare data-icon="inline-start" />
                      {isScreenSharePending ? "Connecting screen share…" : "Share entire screen to continue"}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            <SessionConversationLayout
              workspace={surface && (
                  <motion.section
                    key={surface.key}
                    aria-label="Session workspace"
                    initial={reduceMotion ? false : { opacity: 0, scale: 0.98 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={reduceMotion ? undefined : { opacity: 0, scale: 0.98 }}
                    transition={reduceMotion ? { duration: 0 } : { duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                    // Workspaces are dark-themed tools (code editor, whiteboard), so they keep a dark scope.
                    className="dark flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border bg-night text-foreground"
                  >
                    <div className="min-h-0 flex-1">
                      {surface.tool === "code" && (
                        <CodeEditor
                          key={surface.key}
                          initialLanguage={surface.language}
                          initialCode={surface.starterCode || undefined}
                          instructions={surface.instructions}
                          highlightLines={surface.highlightLines}
                          readOnly={surface.readOnly}
                          onContentChange={handleSurfaceContentChange}
                          onSubmit={surface.readOnly ? undefined : (language, code) => handleCodeSubmission(surface.questionId, language, code)}
                        />
                      )}
                      {surface.tool === "choice" && (
                        <ChoicePanel
                          key={surface.key}
                          questionId={surface.questionId}
                          question={surface.question}
                          options={surface.options}
                          code={surface.code}
                          onSubmit={handleChoiceSubmission}
                        />
                      )}
                      {surface.tool === "canvas" && (
                        <Whiteboard
                          key={surface.key}
                          question={surface.question}
                          onContentChange={handleSurfaceContentChange}
                          onSubmit={(submission) => handleWhiteboardSubmission(
                            surface.questionId,
                            surface.question,
                            submission,
                          )}
                        />
                      )}
                      {surface.tool === "pdf" && (
                        <PdfViewerSurface
                          key={surface.key}
                          sourceUrl={
                            surface.sourceUrl
                              ? surface.sourceUrl.includes("sessionId=")
                                ? surface.sourceUrl
                                : `${surface.sourceUrl}${surface.sourceUrl.includes("?") ? "&" : "?"}sessionId=${connection?.sessionId ?? ""}`
                              : undefined
                          }
                          initialPage={surface.page}
                          highlightQuery={surface.highlightQuery}
                          exactHighlight={surface.exactHighlight}
                          resumeDocument={surface.resumeDocument}
                          searchRequestId={surface.searchRequestId}
                          onHighlightResult={handleResumeHighlightResult}
                          title={surface.fileName ?? contextList.find((c) => c.id === surface.fileId)?.name}
                        />
                      )}
                      {surface.tool === "image" && (
                        <ImageViewerSurface
                          key={surface.key}
                          sourceUrl={
                            surface.sourceUrl
                              ? surface.sourceUrl.includes("sessionId=")
                                ? surface.sourceUrl
                                : `${surface.sourceUrl}${surface.sourceUrl.includes("?") ? "&" : "?"}sessionId=${connection?.sessionId ?? ""}`
                              : undefined
                          }
                          title={contextList.find((c) => c.id === surface.fileId)?.name}
                        />
                      )}
                      {surface.tool === "presentation" && (
                        <PresentationViewer
                          key={surface.key}
                          sourceUrl={
                            surface.sourceUrl?.startsWith("/api/documents/") && !surface.sourceUrl.includes("sessionId=")
                              ? `${surface.sourceUrl}${surface.sourceUrl.includes("?") ? "&" : "?"}sessionId=${connection?.sessionId ?? ""}`
                              : surface.sourceUrl
                          }
                          initialSlideNumber={surface.slideNumber}
                        />
                      )}
                    </div>
                  </motion.section>
              )}
              portrait={introSrc && !introDone ? <ScenarioIntro key={agent} src={introPlaybackSrc ?? introSrc} onFinished={() => setIntroDone(true)} className="h-full min-h-0 w-full" />
                : <AgentTile persona={persona} photoUrl={agentPhotos[agent] ?? null} compact={Boolean(surface)} />}
              selfView={<CandidateTile name={userName} compact />}
              transcript={<SessionSidebar entries={entries} liveText={latestSpokenText} trainerName={trainerName}
                onClose={() => setSidebarOpen(false)} files={new Map(contextList.map(file => [file.id, { name: file.name, mediaType: null }]))} />}
              transcriptOpen={sidebarOpen} name={trainerName} time={elapsedLabel}
            />
            {isMobile && surface && <Sheet open={mobileTranscriptOpen} onOpenChange={setMobileTranscriptOpen}>
              <SheetContent side="bottom" showCloseButton={false} className="h-[70dvh]! max-h-[85dvh] gap-0 overflow-hidden px-4 pb-6">
                <SheetTitle className="sr-only">Transcript</SheetTitle>
                <SheetDescription className="sr-only">Your conversation with {trainerName}. Close to return to your workspace.</SheetDescription>
                <SessionSidebar entries={entries} liveText={latestSpokenText} trainerName={trainerName} onSendMessage={handleSendMessage}
                  onClose={() => setMobileTranscriptOpen(false)} disabled={!connected}
                  files={new Map(contextList.map(file => [file.id, { name: file.name, mediaType: null }]))} />
              </SheetContent>
            </Sheet>}
          </main>

          <footer className="relative isolate flex shrink-0 flex-col items-center gap-3 overflow-hidden bg-background px-4 pt-4 pb-6">
            <ConversationWaves active={workspaceConnected} />
            {composerOpen && <CallComposer autoFocus name={trainerName} onSend={handleSendMessage} disabled={!connected} onClose={() => setComposerOpen(false)} />}
            <SessionControlBar
              room={room}
              isConnected={connected}
              chatOpen={isMobile && surface ? mobileTranscriptOpen : sidebarOpen}
              onChatToggle={() => isMobile && surface ? setMobileTranscriptOpen(v => !v) : setSidebarOpen(v => !v)}
              composerOpen={composerOpen}
              onComposerToggle={() => setComposerOpen(v => !v)}
              onEnd={() => void handleDisconnect("manual")}
              onAttach={attachDuringSession ? () => attachInput.current?.click() : undefined}
              attaching={attaching}
            />
            {attachDuringSession ? (
              <input
                ref={attachInput}
                type="file"
                hidden
                accept={DURING_UPLOAD_ACCEPT}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void handleAttach(file);
                }}
              />
            ) : null}
          </footer>

          {error && (
            <div className="absolute inset-0 z-50 grid place-items-center bg-black/30 p-6 backdrop-blur-sm">
              <Card size="lg" raised className="w-full max-w-md text-center">
                <CardHeader>
                  <CardTitle>{saveFailed ? "Could not save session" : "Session problem"}</CardTitle>
                  <CardDescription>{error}</CardDescription>
                </CardHeader>
                <CardContent className="flex justify-center gap-2">
                  {!autoStart && (
                    <Button
                      variant="outline"
                      className="h-10"
                      onClick={() => {
                        resetSessionState();
                        setLaunched(false);
                      }}
                    >
                      Back
                    </Button>
                  )}
                  <Button className="h-10" onClick={saveFailed ? () => void handleDisconnect(pendingEndReasonRef.current) : handleRetry}>Try again</Button>
                </CardContent>
              </Card>
            </div>
          )}
        </LiveKitWorkspaceProvider>
        <RoomAudioRenderer />
      </RoomContext.Provider>
    </div>
  );
}

const GET_READY_SECONDS = 5;
/** Session top bar (V2 prototype): logo, the scenario in the middle, actions on the right. */
function SessionHeader({ title, linkHome, children }: { title: string; linkHome: boolean; children?: React.ReactNode }) {
  const logo = (
    <>
      <Image src="/trainertwin-mark.svg" alt="" width={20} height={16} priority />
      <span className="text-body font-semibold tracking-tight">TrainerTwin</span>
    </>
  );
  return (
    <header className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3 md:h-[72px] md:grid-cols-[1fr_auto_1fr] md:gap-4 md:px-6 md:py-0">
      {linkHome ? (
        <Link href="/" className="flex w-fit items-center gap-2">{logo}</Link>
      ) : (
        <div className="flex items-center gap-2">{logo}</div>
      )}
      <h1 className="col-span-2 row-start-2 min-w-0 truncate text-body font-medium md:col-span-1 md:col-start-2 md:row-start-1 md:max-w-[40vw] md:text-center">{title}</h1>
      <div className="col-start-2 row-start-1 flex items-center justify-end gap-3 md:col-start-3">{children}</div>
    </header>
  );
}

/**
 * After a role play: go home, or practise it again. The link starts a new call each time (limited only by the learner's
 * minutes); reloading it shows the minutes left, or that they've run out.
 */
function PractiseAgainActions() {
  return (
    <CardContent className="flex justify-center gap-2">
      <Button variant="outline" className="h-10" nativeButton={false} render={<Link href="/" />}>
        Back to home
      </Button>
      <Button className="h-10" onClick={() => window.location.reload()}>
        <Play data-icon="inline-start" /> Practise again
      </Button>
    </CardContent>
  );
}

function SessionFeedback({ scenarioName, sessionId }: { scenarioName?: string; sessionId: string }) {
  const [rating, setRating] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [feedbackError, setFeedbackError] = useState("");

  async function sendFeedback() {
    if (rating === null || sending) return;
    setSending(true);
    setFeedbackError("");
    try {
      const response = await fetch(`/api/sessions/${sessionId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating, note }),
      });
      if (!response.ok) throw new Error("Feedback could not be saved. Please try again.");
      setSent(true);
    } catch (error) {
      setFeedbackError(error instanceof Error ? error.message : "Feedback could not be saved.");
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <>
        <CardHeader>
          <span className="mx-auto grid size-12 place-items-center rounded-full bg-brand/15 text-brand">
            <Check className="size-6" aria-hidden="true" />
          </span>
          <CardTitle>Thanks for your feedback</CardTitle>
          <CardDescription>Want another go? Practise again as long as you have minutes.</CardDescription>
        </CardHeader>
        <PractiseAgainActions />
      </>
    );
  }

  return (
    <>
      <CardHeader>
        <CardTitle>{scenarioName ? `${scenarioName} ended` : "Session ended"}</CardTitle>
        <CardDescription>Your responses have been saved. You may close this tab.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-foreground">How was this session?</legend>
          <div className="flex justify-center gap-2">
            {[
              "Frustrating",
              "Struggled",
              "Okay",
              "Good",
              "Great",
            ].map((label, index) => {
              const value = index + 1;
              const selected = rating === value;
              return (
                <button
                  key={label}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setRating(value)}
                  className={cn(
                    "h-10 w-10 rounded-full border text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
                    selected
                      ? "border-brand bg-brand text-white"
                      : "bg-card text-muted-foreground hover:border-foreground/25 hover:text-foreground",
                  )}
                >
                  {value}
                </button>
              );
            })}
          </div>
          {rating ? (
            <p aria-live="polite" className="mt-2 text-center text-xs text-muted-foreground">
              {rating <= 2
                ? "Rough one — what tripped you up?"
                : rating === 3
                  ? "Fair enough — anything to improve?"
                  : "Great to hear!"}
            </p>
          ) : null}
        </fieldset>
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={3}
          maxLength={500}
          placeholder="Anything else you'd like to share? (optional)"
          className="w-full resize-none rounded-xl border bg-card px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-brand"
        />
        {feedbackError && <p role="alert" className="text-sm text-destructive">{feedbackError}</p>}
        <Button disabled={rating === null || sending} onClick={() => void sendFeedback()} className="w-full">
          {sending ? "Sending…" : "Send feedback"}
        </Button>
        <Button variant="ghost" className="w-full" onClick={() => window.location.reload()}>
          <Play data-icon="inline-start" /> Skip and practise again
        </Button>
      </CardContent>
    </>
  );
}

function ScenarioIntro({
  src,
  onFinished,
  className,
}: {
  src: string;
  onFinished?: () => void;
  className?: string;
}) {
  const video = useRef<HTMLVideoElement>(null);
  // Latch the first src: swapping the <video> source mid-playback would restart the clip.
  const [latchedSrc] = useState(src);
  const [muted, setMuted] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);
  const [releaseDeadline, setReleaseDeadline] = useState<number | null>(null);

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    el.play().catch(() => {
      el.muted = true;
      setMuted(true);
      el.play().catch(() => setNeedsTap(true));
    });
  }, [latchedSrc]);

  useEffect(() => {
    if (releaseDeadline === null) return;
    const timer = window.setTimeout(() => onFinished?.(), Math.max(0, releaseDeadline - Date.now()));
    return () => clearTimeout(timer);
  }, [releaseDeadline, onFinished]);

  function armReleaseDeadline() {
    const el = video.current;
    if (!el) return;
    const remaining = Number.isFinite(el.duration) && el.duration > 0 ? el.duration - el.currentTime : 0;
    setReleaseDeadline(Date.now() + remaining * 1000 + 2000);
  }

  function playWithSound() {
    const el = video.current;
    if (!el) return;
    el.muted = false;
    setMuted(false);
    setNeedsTap(false);
    void el.play().catch(() => undefined);
  }

  return (
    <div className={cn("relative overflow-hidden rounded-2xl bg-black shadow-elevation-2", className)}>
      <video
        ref={video}
        src={latchedSrc}
        playsInline
        muted={muted}
        className="size-full object-contain"
        onEnded={onFinished}
        onError={() => onFinished?.()}
        onLoadedMetadata={armReleaseDeadline}
      />
      {/* No overlay pills: intro videos carry their own name card and branding. */}
      {needsTap ? (
        <button
          type="button"
          onClick={playWithSound}
          className="absolute inset-0 grid place-items-center bg-black/70"
        >
          <span className="flex items-center gap-2 rounded-full bg-background/90 px-4 py-2 text-sm font-medium text-foreground">
            <Play className="size-4" /> Tap to play the introduction
          </span>
        </button>
      ) : muted ? (
        <button
          type="button"
          onClick={playWithSound}
          className="absolute right-3.5 bottom-3.5 flex items-center gap-2 rounded-full bg-background/90 px-3 py-1.5 text-xs font-medium text-foreground"
        >
          <Volume2 className="size-3.5" /> Unmute
        </button>
      ) : null}
    </div>
  );
}
