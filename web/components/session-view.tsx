"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, LoaderCircle, Play, Upload as UploadIcon, Volume2, X } from "lucide-react";
import { type AgentContextUpload } from "@/lib/context-upload";
import "@livekit/components-styles";
import {
  RoomAudioRenderer,
  RoomContext,
} from "@livekit/components-react";
import {
  ParticipantKind,
  Room,
  RoomEvent,
  type RemoteParticipant,
  type TranscriptionSegment,
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
import { CandidateTile } from "@/components/session/candidate-tile";
import { SessionControlBar } from "@/components/session/session-control-bar";
import { SessionSidebar } from "@/components/session/session-sidebar";
import { LiveSubtitles } from "@/components/session/live-subtitles";
import { CodeEditor } from "@/components/session/code-editor";
import { CodeViewer } from "@/components/session/code-viewer";
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
type EndReason = "completed" | "manual" | "disconnected";
type WhiteboardAcknowledgement = { accepted: boolean; message?: string };

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
  /** Learner-facing entries: no start button, the session starts on page load. */
  autoStart?: boolean;
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
  agentPersonas = {},
  agentContextRequired = {},
  agentContextUploads = {},
  sessionCode,
  scenarioName,
  userName,
  organizationName,
  organizationLogo = null,
  introVideos = {},
  autoStart = false,
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

  const [agent, setAgent] = useState(agents[0] ?? "");
  const persona = agentPersonas[agent] ?? personas[0] ?? "";
  const [contextIds, setContextIds] = useState<string[]>([]);
  const contextId = contextIds[0] ?? "";
  const [contextList, setContextList] = useState<{ id: string; name: string; size?: number }[]>(contexts);
  const [uploadingContext, setUploadingContext] = useState(false);
  const contextInput = useRef<HTMLInputElement>(null);

  const [launched, setLaunched] = useState(false);
  const [prejoinComplete, setPrejoinComplete] = useState(!sessionCode);
  const [prejoinMedia, setPrejoinMedia] = useState<PreJoinMediaSettings>({
    microphoneEnabled: true,
    cameraEnabled: false,
  });
  const [connection, setConnection] = useState<SessionConnection | null>(null);
  const [connected, setConnected] = useState(false);
  const [agentInRoom, setAgentInRoom] = useState(false);
  const [error, setError] = useState("");
  const [ended, setEnded] = useState(false);
  const [endReason, setEndReason] = useState<EndReason>("disconnected");
  const [introDone, setIntroDone] = useState(false);
  const [introPlaybackSrc, setIntroPlaybackSrc] = useState<string | null>(null);
  const [introPrefetchDone, setIntroPrefetchDone] = useState(false);
  const [introProgress, setIntroProgress] = useState<number | null>(null);

  const [entries, setEntries] = useState<Entry[]>([]);
  const [coverage, setCoverage] = useState<Coverage>({});
  const [surface, setSurface] = useState<AgentSurface>(null);
  const [selectedChoiceId, setSelectedChoiceId] = useState<string | null>(null);
  const [choiceSubmitting, setChoiceSubmitting] = useState(false);
  const [choiceSubmitted, setChoiceSubmitted] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [subtitlesActive, setSubtitlesActive] = useState(true);
  const [latestSpokenText, setLatestSpokenText] = useState("");
  const [elapsed, setElapsed] = useState(0);

  const reduceMotion = useReducedMotion();

  const startedRef = useRef(false);
  const releasedRef = useRef(false);
  const endingRef = useRef(false);
  const entriesRef = useRef<Entry[]>([]);
  const coverageRef = useRef<Coverage>({});
  const finalizedRef = useRef(false);
  const surfaceKeyRef = useRef<string | null>(null);
  const whiteboardAcknowledgementsRef = useRef(
    new Map<string, (acknowledgement: WhiteboardAcknowledgement) => void>(),
  );

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
    setIntroPrefetchDone(false);
    setIntroProgress(0);
    downloadIntroVideo(introSrc, (p) => {
      if (typeof p.ratio === "number") setIntroProgress(p.ratio);
    })
      .then((url) => {
        setIntroPlaybackSrc(url);
        setIntroProgress(null);
        setIntroPrefetchDone(true);
      })
      .catch((err) => {
        console.error("Intro video prefetch failed:", err);
        // Fall back to direct streaming; ScenarioIntro's own safeguards apply.
        setIntroPlaybackSrc(introSrc);
        setIntroProgress(null);
        setIntroPrefetchDone(true);
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
    setAgentInRoom(false);
    setError("");
    setEndReason("disconnected");
    setIntroDone(false);
    setEntries([]);
    setCoverage({});
    surfaceKeyRef.current = null;
    setSurface(null);
    setSelectedChoiceId(null);
    setChoiceSubmitting(false);
    setChoiceSubmitted(false);
    setLatestSpokenText("");
    setElapsed(0);
  }, []);

  const handleStartSession = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    setError("");
    try {
      const launchResponse = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          sessionCode
            ? { shareCode: sessionCode, contextId: contextId || undefined, contextIds }
            : { agentSlug: agent, contextId: contextId || undefined, contextIds },
        ),
      });
      const launch = await launchResponse.json().catch(() => ({}));
      if (!launchResponse.ok || !launch.session?.id || !launch.session?.runtimeToken) {
        throw new Error(launch.error ?? "Could not create session");
      }
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
      startedRef.current = false;
      setError(e instanceof Error ? e.message : "Failed to start session");
      if (!autoStart) setLaunched(false);
    }
  }, [agent, contextId, contextIds, sessionCode, autoStart]);

  const handleRetry = useCallback(() => {
    startedRef.current = false;
    setError("");
    void handleStartSession();
  }, [handleStartSession]);

  const contextUpload = agentContextUploads[agent] ?? (
    agentContextRequired[agent]
      ? { required: true, prompt: "", label: "Context document", accept: "" }
      : null
  );
  const isContextRequired = Boolean(contextUpload?.required ?? agentContextRequired[agent]);

  /** Resolves once the intro download finishes (or falls back to streaming). */
  const awaitIntroReady = useCallback(async () => {
    if (!introSrc || introPrefetchDone) return;
    try {
      const url = await downloadIntroVideo(introSrc);
      setIntroPlaybackSrc(url);
    } catch {
      setIntroPlaybackSrc(introSrc);
    } finally {
      setIntroPrefetchDone(true);
      setIntroProgress(null);
    }
  }, [introSrc, introPrefetchDone]);

  useEffect(() => {
    if (!autoStart || !prejoinComplete || ended || !agent || !persona || launched) return;
    if (isContextRequired && contextIds.length === 0) return;
    if (introSrc && !introPrefetchDone) return;
    void Promise.resolve().then(() => {
      setLaunched(true);
      void handleStartSession();
    });
  }, [autoStart, prejoinComplete, ended, agent, persona, launched, isContextRequired, contextIds, handleStartSession, introSrc, introPrefetchDone]);

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
    if (!connected || !agentInRoom || ended) return;
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
  }, [room, connected, agentInRoom, ended, introSrc, introDone, prejoinMedia]);

  const finalizeSession = useCallback(
    (status: "completed" | "abandoned") => {
      if (finalizedRef.current || !connection) return;
      finalizedRef.current = true;
      void fetch("/api/sessions/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: connection.sessionId,
          status,
          transcript: entriesRef.current,
          evidence: coverageRef.current,
        }),
        keepalive: true,
      }).catch(() => {});
    },
    [connection],
  );

  const handleDisconnect = useCallback(
    async (reason: EndReason) => {
      endingRef.current = true;
      finalizeSession(reason === "completed" ? "completed" : "abandoned");
      await room.disconnect().catch(() => {});
      resetSessionState();
      setEndReason(reason);
      setEnded(true);
    },
    [room, finalizeSession, resetSessionState],
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

  const handleSurface = useCallback((nextSurface: AgentSurface) => {
    const nextKey = nextSurface?.key ?? null;
    if (surfaceKeyRef.current !== nextKey) {
      surfaceKeyRef.current = nextKey;
      setSelectedChoiceId(null);
      setChoiceSubmitting(false);
      setChoiceSubmitted(false);
    }
    setSurface(nextSurface);
  }, []);

  // Browser-confirmed screen state is durable session truth; the brain reads it
  // through getSessionContext instead of inferring it from LiveKit RPC history.
  useEffect(() => {
    if (!connection || ended) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/sessions/${connection.sessionId}/ui-state`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${connection.runtimeToken}`,
        },
        body: JSON.stringify(surface ? { active: surface.tool, key: surface.key } : { active: null }),
        signal: controller.signal,
      }).catch(() => {});
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [connection, ended, surface]);

  const handleChoiceSubmission = useCallback(async () => {
    if (surface?.tool !== "choice" || !selectedChoiceId || choiceSubmitting || choiceSubmitted) return;
    const option = surface.options.find(({ id }) => id === selectedChoiceId);
    if (!option) return;

    setChoiceSubmitting(true);
    try {
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
      setChoiceSubmitted(true);
    } catch (error) {
      console.error("Could not submit MCQ answer:", error);
    } finally {
      setChoiceSubmitting(false);
    }
  }, [choiceSubmitted, choiceSubmitting, room, selectedChoiceId, surface]);

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
        }
      } catch {}
    }

    function handleRoomDisconnected() {
      if (endingRef.current) return;
      finalizeSession("abandoned");
      resetSessionState();
      setEndReason("disconnected");
      setEnded(true);
    }

    room.on(RoomEvent.TranscriptionReceived, handleTranscription);
    room.on(RoomEvent.DataReceived, handleData);
    room.on(RoomEvent.Disconnected, handleRoomDisconnected);

    return () => {
      room.off(RoomEvent.TranscriptionReceived, handleTranscription);
      room.off(RoomEvent.DataReceived, handleData);
      room.off(RoomEvent.Disconnected, handleRoomDisconnected);
    };
  }, [room, connection, handleDisconnect, finalizeSession, resetSessionState]);

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

  if (sessionCode && !prejoinComplete) {
    return (
      <PreJoin
        scenarioName={scenarioName ?? agent.replaceAll("-", " ")}
        userName={userName ?? "You"}
        organizationName={organizationName ?? "TrainerTwin"}
        organizationLogo={organizationLogo}
        contexts={contextList}
        contextRequired={isContextRequired}
        contextPrompt={contextUpload?.prompt}
        contextLabel={contextUpload?.label}
        contextAccept={contextUpload?.accept}
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
      <div className="dark flex h-dvh w-dvw items-center justify-center bg-[#14161a] p-6 text-foreground">
        <Card className="w-full max-w-md border border-white/[0.06] bg-[#1c1f26] text-center shadow-2xl">
          {sessionCode && endReason !== "disconnected" ? (
            <SessionFeedback scenarioName={scenarioName} />
          ) : (
            <>
              <CardHeader>
                <CardTitle>{endReason === "completed" ? "Session complete" : "Session ended"}</CardTitle>
                <CardDescription>
                  {sessionCode
                    ? endReason === "disconnected"
                      ? "The connection closed unexpectedly. Any captured session data has been saved. You may close this tab."
                      : "Your responses have been saved. You may close this tab."
                    : endReason === "disconnected"
                      ? "The connection closed unexpectedly. Any captured session data has been saved."
                      : "Your transcript and recording are being saved in Sessions."}
                </CardDescription>
              </CardHeader>
              {!sessionCode && (
                <CardContent className="flex justify-center gap-2">
                  <Button variant="outline" nativeButton={false} render={<Link href="/sessions" />}>
                    View sessions
                  </Button>
                  <Button
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
      </div>
    );
  }

  if (sessionCode && prejoinComplete && !launched && (!isContextRequired || contextIds.length > 0)) {
    return (
      <div className="grid min-h-svh place-items-center bg-[#14161a] text-white">
        <div className="flex items-center gap-3 text-sm text-white/75">
          <LoaderCircle className="size-5 animate-spin" /> Preparing your session…
        </div>
      </div>
    );
  }

  if (!launched) {
    return (
      <div className="dark flex h-dvh w-dvw flex-col overflow-hidden bg-[#14161a] text-foreground">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/[0.035] bg-[#14161a]/85 px-6 backdrop-blur-xl">
          {sessionCode ? (
            <div className="flex items-center gap-2.5">
              <Image src="/trainertwin-mark.svg" alt="" width={22} height={17} priority />
              <span className="font-bold text-lg tracking-tight text-white">TrainerTwin</span>
            </div>
          ) : (
            <Link href="/" className="flex items-center gap-2.5">
              <Image src="/trainertwin-mark.svg" alt="" width={22} height={17} priority />
              <span className="font-bold text-lg tracking-tight text-white">TrainerTwin</span>
            </Link>
          )}
        </header>

        <main className="relative flex min-h-0 flex-1 overflow-hidden p-4 sm:p-6">
          <div className="mx-auto flex h-full w-full max-w-xl items-center">
            <Card className="w-full border border-white/[0.06] bg-[#1c1f26] shadow-2xl">
              <CardHeader>
                <CardTitle>Configure the session</CardTitle>
                <CardDescription>
                  Choose a scenario. Its trainer persona is already configured.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <label className="flex flex-col gap-1.5 text-sm">
                  <span className="font-medium">Scenario</span>
                  <Select value={agent} onValueChange={(v) => v !== null && setAgent(v)}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Scenario" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectLabel>Scenarios</SelectLabel>
                        {agents.map((a) => (
                          <SelectItem key={a} value={a}>{a}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </label>

                <label className="flex flex-col gap-1.5 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{contextUpload?.label || "Context document"}</span>
                    {isContextRequired && (
                      <span className="text-[11px] font-medium text-amber-500">
                        Required for this scenario
                      </span>
                    )}
                  </div>
                  {contextUpload?.prompt && (
                    <p className="text-xs text-muted-foreground">{contextUpload.prompt}</p>
                  )}
                  <div className="flex items-center gap-2">
                    <Select
                      value={contextId || "none"}
                      onValueChange={(v) => {
                        if (!v || v === "none") setContextIds([]);
                        else setContextIds([v]);
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select document" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectLabel>Uploaded contexts</SelectLabel>
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
                      accept={contextUpload?.accept || ".md,.txt,.pdf,.docx,.doc,.pptx,.ppt,.xlsx,.xls,.csv,.json,.png,.jpg,.jpeg,.webp"}
                      hidden
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.currentTarget.value = "";
                        if (!file) return;
                        setUploadingContext(true);
                        setError("");
                        try {
                          const form = new FormData();
                          form.append("file", file);
                          const res = await fetch("/api/upload", { method: "POST", body: form });
                          const data = await res.json().catch(() => null);
                          if (!res.ok) throw new Error(data?.error ?? "Upload failed");
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
                      aria-label="Upload context document"
                      disabled={uploadingContext}
                      onClick={() => contextInput.current?.click()}
                    >
                      {uploadingContext ? <LoaderCircle className="animate-spin" /> : <UploadIcon />}
                    </Button>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    PDF, Word, PPT, Excel, CSV, text, or images (.pdf, .docx, .pptx, etc.).
                  </span>
                </label>

                {error && (
                  <p role="alert" className="text-sm text-destructive">{error}</p>
                )}

                {introProgress !== null && (
                  <div aria-live="polite">
                    <p className="text-xs text-muted-foreground">
                      Loading your session context… {Math.round(introProgress * 100)}%
                    </p>
                    <div
                      role="progressbar"
                      aria-valuenow={Math.round(introProgress * 100)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]"
                    >
                      <div
                        className="h-full rounded-full bg-foreground transition-all duration-300"
                        style={{ width: `${Math.round(introProgress * 100)}%` }}
                      />
                    </div>
                  </div>
                )}

                <Button
                  onClick={async (event) => {
                    const button = event.currentTarget;
                    button.disabled = true;
                    await awaitIntroReady();
                    setLaunched(true);
                    void handleStartSession();
                    button.disabled = false;
                  }}
                  disabled={!persona || !agent || (isContextRequired && contextIds.length === 0)}
                  className="w-full"
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
    <div className="dark flex h-dvh w-dvw flex-col overflow-hidden bg-[#14161a] text-foreground">
      <RoomContext.Provider value={room}>
        <LiveKitWorkspaceProvider
          sessionId={connection?.sessionId}
          runtimeToken={connection?.runtimeToken}
          onSurface={handleSurface}
          onEndSession={() => void handleDisconnect("completed")}
        >
          {/* Topbar Navigation: Clean Logo Left, Live Badge Right */}
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/[0.035] bg-[#14161a]/85 px-6 backdrop-blur-xl">
            {sessionCode ? (
              <div className="flex items-center gap-2.5">
                <Image src="/trainertwin-mark.svg" alt="" width={22} height={17} priority />
                <span className="font-bold text-lg tracking-tight text-white">TrainerTwin</span>
              </div>
            ) : (
              <Link href="/" className="flex items-center gap-2.5">
                <Image src="/trainertwin-mark.svg" alt="" width={22} height={17} priority />
                <span className="font-bold text-lg tracking-tight text-white">TrainerTwin</span>
              </Link>
            )}

            <div className="flex items-center gap-2 rounded-full bg-[#e03b3b] px-3 py-1 font-semibold text-white text-xs shadow-sm">
              <span className="size-1.5 animate-pulse rounded-full bg-white" />
              <span>Live</span>
              <time className="font-mono text-xs font-semibold">{elapsedLabel}</time>
            </div>
          </header>

          {/* Main Body: Stage (Left) & Chat Sidebar (Right) — EQUAL HEIGHT */}
          <main className="flex min-h-0 flex-1 gap-4 p-4 pb-2">
            {/* Stage Section */}
            <div className="relative flex min-h-0 flex-1">
              <div className="flex min-h-0 w-full gap-4 transition-all duration-300">
                {/* Surface Presentation Mode (Left Large Workspace) */}
                {surface && (
                  <motion.section
                    key={surface.key}
                    aria-label="Session workspace"
                    initial={reduceMotion ? false : { opacity: 0, scale: 0.98 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={reduceMotion ? undefined : { opacity: 0, scale: 0.98 }}
                    transition={reduceMotion ? { duration: 0 } : { duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                    className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/[0.035] bg-[#15181f]"
                  >
                    <div className="flex h-10 shrink-0 items-center justify-between border-b border-white/[0.035] bg-white/[0.02] px-4">
                      <span className="text-xs font-semibold text-foreground/90">
                        {surface.tool === "code" && "Code Workspace"}
                        {surface.tool === "choice" && "Multiple choice"}
                        {surface.tool === "canvas" && "Whiteboard"}
                        {surface.tool === "pdf" && "PDF Document"}
                        {surface.tool === "image" && "Image Viewer"}
                        {surface.tool === "presentation" && "Presentation"}
                      </span>
                      <button
                        type="button"
                        aria-label="Close workspace panel"
                        title="Close panel"
                        onClick={() => handleSurface(null)}
                        className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                    <div className="min-h-0 flex-1">
                      {surface.tool === "code" && (
                        <CodeEditor
                          key={surface.key}
                          initialLanguage={surface.language}
                          initialCode={surface.starterCode || undefined}
                          instructions={surface.instructions}
                          highlightLines={surface.highlightLines}
                          readOnly={surface.readOnly}
                          onSubmit={surface.readOnly ? undefined : (language, code) => handleCodeSubmission(surface.questionId, language, code)}
                        />
                      )}
                      {surface.tool === "choice" && (
                        <div className="space-y-4 overflow-y-auto p-6">
                          <p className="text-sm font-medium">{surface.question}</p>
                          {surface.code ? (
                            <CodeViewer
                              language={surface.code.language}
                              code={surface.code.content}
                            />
                          ) : null}
                          <div className="space-y-2">
                            {surface.options.map((option) => (
                              <label key={option.id} className="flex items-start gap-3 rounded-xl border border-white/10 p-3 text-sm">
                                <input
                                  type="radio"
                                  name={`question-${surface.key}`}
                                  value={option.id}
                                  className="mt-0.5"
                                  checked={selectedChoiceId === option.id}
                                  disabled={choiceSubmitting || choiceSubmitted}
                                  onChange={() => setSelectedChoiceId(option.id)}
                                />
                                <span><span className="font-medium">{option.id}.</span> {option.text}</span>
                              </label>
                            ))}
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-xs text-muted-foreground">
                              {choiceSubmitted ? "Answer submitted. Waiting for the next question." : "Select one option, then submit your answer."}
                            </p>
                            <Button
                              type="button"
                              size="sm"
                              disabled={!selectedChoiceId || choiceSubmitting || choiceSubmitted}
                              onClick={() => void handleChoiceSubmission()}
                            >
                              {choiceSubmitting ? "Submitting…" : choiceSubmitted ? "Submitted" : "Submit answer"}
                            </Button>
                          </div>
                        </div>
                      )}
                      {surface.tool === "canvas" && (
                        <Whiteboard
                          key={surface.key}
                          question={surface.question}
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
                          title={contextList.find((c) => c.id === surface.fileId)?.name}
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
                          sourceUrl={surface.sourceUrl}
                          initialSlideNumber={surface.slideNumber}
                        />
                      )}
                    </div>
                  </motion.section>
                )}

                {/* Participant Tiles:
                    - Normal Mode: 2 equal side-by-side columns
                    - Presenting Mode: Stacked vertically on the right side!
                */}
                <div
                  className={cn(
                    surface ? "flex w-[280px] shrink-0 flex-col gap-3.5" : "grid flex-1 grid-cols-2 gap-4",
                    "min-h-0 transition-all duration-300",
                  )}
                >
                  <div className="min-h-0 flex-1">
                    {introSrc && !introDone ? (
                      <ScenarioIntro
                        key={agent}
                        src={introPlaybackSrc ?? introSrc}
                        personaLabel={persona}
                        onFinished={() => setIntroDone(true)}
                        className="h-full min-h-0 w-full"
                      />
                    ) : (
                      <AgentTile persona={persona} compact={surface !== null} />
                    )}
                  </div>
                  <div className="min-h-0 flex-1">
                    <CandidateTile compact={surface !== null} />
                  </div>
                </div>
              </div>

              {/* YouTube / Prime Video Style Streaming Subtitles */}
              <LiveSubtitles text={latestSpokenText} visible={subtitlesActive} />
            </div>

            {/* Chat Sidebar (Pure Chat, exact same height as stage!) */}
            <AnimatePresence initial={false}>
              {sidebarOpen && (
                <motion.div
                  initial={reduceMotion ? false : { opacity: 0, width: 0 }}
                  animate={{ opacity: 1, width: 360 }}
                  exit={reduceMotion ? undefined : { opacity: 0, width: 0 }}
                  transition={reduceMotion ? { duration: 0 } : { duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                  className="shrink-0 overflow-hidden"
                >
                  <SessionSidebar
                    entries={entries}
                    onSendMessage={handleSendMessage}
                    onClose={() => setSidebarOpen(false)}
                    disabled={!connected}
                    className="h-full"
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </main>

          {/* Common Footer across full width */}
          <footer className="flex h-16 shrink-0 items-center justify-center pb-2">
            <SessionControlBar
              room={room}
              isConnected={connected}
              subtitlesActive={subtitlesActive}
              onSubtitlesToggle={() => setSubtitlesActive((v) => !v)}
              chatOpen={sidebarOpen}
              onChatToggle={() => setSidebarOpen((v) => !v)}
              onEnd={() => void handleDisconnect("manual")}
            />
          </footer>

          {error && (
            <div className="absolute inset-0 z-50 grid place-items-center bg-[#14161a]/85 p-6 backdrop-blur-md">
              <Card className="w-full max-w-md border border-white/[0.06] bg-[#1c1f26] text-center shadow-2xl">
                <CardHeader>
                  <CardTitle>Connection problem</CardTitle>
                  <CardDescription>{error}</CardDescription>
                </CardHeader>
                <CardContent className="flex justify-center gap-2">
                  {!autoStart && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        resetSessionState();
                        setLaunched(false);
                      }}
                    >
                      Back
                    </Button>
                  )}
                  <Button onClick={handleRetry}>Try again</Button>
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

/** UI-only feedback form shown on the end screen of assigned sessions. */
function SessionFeedback({ scenarioName }: { scenarioName?: string }) {
  const [rating, setRating] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(false);

  if (sent) {
    return (
      <>
        <CardHeader>
          <span className="mx-auto grid size-12 place-items-center rounded-full bg-brand/15 text-brand">
            <Check className="size-6" aria-hidden="true" />
          </span>
          <CardTitle>Thanks for your feedback</CardTitle>
          <CardDescription>You may close this tab.</CardDescription>
        </CardHeader>
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
                      : "border-white/10 bg-white/[0.04] text-muted-foreground hover:border-white/25 hover:text-foreground",
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
          className="w-full resize-none rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-brand"
        />
        <Button disabled={rating === null} onClick={() => setSent(true)} className="w-full">
          Send feedback
        </Button>
      </CardContent>
    </>
  );
}

function ScenarioIntro({
  src,
  personaLabel,
  onFinished,
  className,
}: {
  src: string;
  personaLabel?: string;
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
    <div className={cn("relative overflow-hidden rounded-2xl border border-white/[0.035] bg-black", className)}>
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
      {personaLabel ? (
        <div className="absolute bottom-3.5 left-3.5 flex items-center gap-2 rounded-md bg-[#121419]/85 px-2.5 py-1 text-xs text-muted-foreground backdrop-blur-md">
          <span className="font-medium text-foreground">
            {personaLabel.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Trainer"}
          </span>
          <span aria-hidden="true" className="size-1 rounded-full bg-border" />
          <span>Speaking</span>
        </div>
      ) : null}
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
