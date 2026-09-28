"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Clock3,
  GraduationCap,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  UserPlus,
  Video as VideoIcon,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import type { KeyMoment, SessionReport, SessionReportStatus } from "@/lib/session-report";

export type LearnerSessionItem = {
  id: string;
  title: string;
  attempt: number;
  durationMinutes: number;
  formattedDate: string;
  dateSubtitle: string;
  reportStatus: SessionReportStatus;
  summary: string;
  summaryTags: string[];
  keyMoments: KeyMoment[];
  focusNextTime: string;
  videoUrl?: string;
  report?: SessionReport;
};

const reportStatusCopy: Record<Exclude<SessionReportStatus, "completed">, { title: string; description: string }> = {
  generating: {
    title: "Evaluation in progress",
    description: "The session was saved successfully. Performance feedback is still being generated.",
  },
  failed: {
    title: "Evaluation failed",
    description: "The session was saved, but performance feedback could not be generated.",
  },
  none: {
    title: "Evaluation not available",
    description: "This session was completed before an evaluation could be started.",
  },
};

export type LearnerData = {
  id: string;
  name: string;
  email?: string;
  initials: string;
  completedSessionsCount: number;
  sessions: LearnerSessionItem[];
};

function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return "00:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function parseTimestampToSeconds(ts?: string, fallbackSeconds?: number): number {
  if (typeof fallbackSeconds === "number" && !isNaN(fallbackSeconds) && fallbackSeconds >= 0) {
    return fallbackSeconds;
  }
  if (!ts) return 0;
  const clean = ts.replace(/[^\d:]/g, "");
  const parts = clean.split(":").map(Number);
  if (parts.length === 2) {
    return (parts[0] || 0) * 60 + (parts[1] || 0);
  }
  if (parts.length === 3) {
    return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
  }
  return 0;
}

const PLAYBACK_RATES = [1, 1.25, 1.5, 1.75, 2];

export function LearnersView({ initialLearners = [] }: { initialLearners?: LearnerData[] }) {
  const learners = initialLearners;

  const [expandedLearnerIds, setExpandedLearnerIds] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const l of learners) {
      initial[l.id] = true;
    }
    return initial;
  });

  const [selectedLearnerId, setSelectedLearnerId] = useState<string>(learners[0]?.id ?? "");
  const [selectedSessionId, setSelectedSessionId] = useState<string>(
    learners[0]?.sessions[0]?.id ?? ""
  );

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [videoState, setVideoState] = useState<{ sessionId: string; status: "loading" | "ready" | "unavailable" }>(() => ({
    sessionId: learners[0]?.sessions[0]?.id ?? "",
    status: learners[0]?.sessions[0]?.videoUrl ? "loading" : "unavailable",
  }));

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerContainerRef = useRef<HTMLDivElement | null>(null);

  const selectedLearner =
    learners.find((l) => l.id === selectedLearnerId) ??
    learners.find((l) => l.sessions.some((s) => s.id === selectedSessionId)) ??
    learners[0];

  const selectedSession =
    selectedLearner?.sessions.find((s) => s.id === selectedSessionId) ??
    selectedLearner?.sessions[0];
  const hasCompletedReport = selectedSession?.reportStatus === "completed" && Boolean(selectedSession.report);

  const totalSessions = learners.reduce(
    (sum, l) => sum + (l.sessions?.length || l.completedSessionsCount || 0),
    0
  );

  const videoStatus = !selectedSession?.videoUrl
    ? "unavailable"
    : videoState.sessionId === selectedSession.id ? videoState.status : "loading";
  const isResolvingVideo = videoStatus === "loading";
  const hasVideo = videoStatus === "ready";

  const toggleLearnerExpand = (id: string) => {
    setExpandedLearnerIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleSelectSession = (learnerId: string, sessionId: string) => {
    if (sessionId === selectedSession?.id) return;
    const nextSession = learners.find((learner) => learner.id === learnerId)?.sessions.find((session) => session.id === sessionId);
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setVideoState({ sessionId, status: nextSession?.videoUrl ? "loading" : "unavailable" });
    setSelectedLearnerId(learnerId);
    setSelectedSessionId(sessionId);
  };

  const handleTogglePlayPause = () => {
    const el = videoRef.current;
    if (!el) return;

    if (isPlaying) {
      el.pause();
      setIsPlaying(false);
    } else {
      el.play()
        .then(() => setIsPlaying(true))
        .catch((err) => {
          console.warn("Could not play media:", err);
          setIsPlaying(false);
        });
    }
  };

  const handleSeek = (time: number) => {
    setCurrentTime(time);
    const el = videoRef.current;
    if (el) {
      el.currentTime = time;
    }
  };

  const handleJumpToMoment = (moment: KeyMoment) => {
    const targetSeconds = parseTimestampToSeconds(moment.timestamp, moment.seconds);
    handleSeek(targetSeconds);
    const el = videoRef.current;
    if (el) {
      el.play().then(() => setIsPlaying(true)).catch(() => {});
    }
    playerContainerRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  const handleToggleMute = () => {
    const nextMute = !isMuted;
    if (videoRef.current) videoRef.current.muted = nextMute;
    setIsMuted(nextMute);
  };

  const handleCycleRate = () => {
    const currentIndex = PLAYBACK_RATES.indexOf(playbackRate);
    const nextRate = PLAYBACK_RATES[(currentIndex + 1) % PLAYBACK_RATES.length] ?? 1;
    setPlaybackRate(nextRate);
    if (videoRef.current) videoRef.current.playbackRate = nextRate;
  };

  const handleToggleFullscreen = () => {
    if (!playerContainerRef.current) return;
    if (!document.fullscreenElement) {
      playerContainerRef.current.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  };

  if (learners.length === 0) {
    return (
      <div className="flex h-full w-full flex-1 items-center justify-center p-6">
        <Empty className="border max-w-sm p-8">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <GraduationCap className="size-5" />
            </EmptyMedia>
            <EmptyTitle className="text-sm font-semibold">No completed learner sessions yet</EmptyTitle>
            <EmptyDescription className="text-xs leading-relaxed text-muted-foreground">
              When learners accept an invitation and complete a role play session, their screen recordings,
              AI performance evaluation, and coaching briefs will appear here.
            </EmptyDescription>
          </EmptyHeader>
          <div className="flex items-center gap-2.5 mt-3">
            <Button size="sm" nativeButton={false} render={<Link href="/users" />}>
              <UserPlus className="size-4" /> Invite learners
            </Button>
            <Button size="sm" variant="outline" nativeButton={false} render={<Link href="/agents" />}>
              View scenarios
            </Button>
          </div>
        </Empty>
      </div>
    );
  }

  const effectiveDuration = duration || (selectedSession ? selectedSession.durationMinutes * 60 : 100);

  return (
    <div className="flex h-full w-full min-h-0 flex-1 overflow-hidden bg-background text-foreground">
      {/* Left Column: Learners & Completed Sessions Sidebar */}
      <aside className="w-80 sm:w-84 shrink-0 border-r flex flex-col bg-card/40 overflow-hidden">
        <div className="px-5 py-3.5 border-b text-xs font-medium text-muted-foreground tracking-tight">
          {learners.length} {learners.length === 1 ? "learner" : "learners"} / {totalSessions}{" "}
          {totalSessions === 1 ? "completed session" : "completed sessions"}
        </div>

        {/* Learners Accordion List */}
        <div className="flex-1 overflow-y-auto divide-y divide-border/40 py-2">
          {learners.map((learner) => {
            const isExpanded = expandedLearnerIds[learner.id] ?? true;
            return (
              <div key={learner.id} className="py-2">
                <button
                  type="button"
                  onClick={() => toggleLearnerExpand(learner.id)}
                  className="w-full flex items-center justify-between px-4 py-2 hover:bg-muted/40 transition-colors text-left group cursor-pointer"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="size-8 shrink-0 rounded-full bg-indigo-100 dark:bg-indigo-950/80 text-indigo-700 dark:text-indigo-300 font-semibold text-xs flex items-center justify-center">
                      {learner.initials}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold truncate text-foreground">
                        {learner.name}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {learner.completedSessionsCount}{" "}
                        {learner.completedSessionsCount === 1 ? "completed session" : "completed sessions"}
                      </div>
                    </div>
                  </div>
                  <div className="text-muted-foreground group-hover:text-foreground transition-colors pr-1">
                    {isExpanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                  </div>
                </button>

                {/* Sub-sessions List */}
                {isExpanded && learner.sessions && (
                  <div className="mt-1 space-y-1 px-3">
                    {learner.sessions.map((session) => {
                      const isSelected = selectedSession?.id === session.id;
                      return (
                        <button
                          key={session.id}
                          type="button"
                          onClick={() => handleSelectSession(learner.id, session.id)}
                          className={cn(
                            "w-full text-left py-2.5 px-3 rounded-lg transition-all relative block cursor-pointer",
                            isSelected
                              ? "bg-indigo-50/80 dark:bg-indigo-950/50 text-foreground border-l-4 border-indigo-600 pl-3.5 shadow-xs"
                              : "hover:bg-muted/50 text-muted-foreground hover:text-foreground"
                          )}
                        >
                          <div
                            className={cn(
                              "text-sm tracking-tight truncate flex items-center justify-between gap-1",
                              isSelected ? "font-semibold text-foreground" : "font-medium"
                            )}
                          >
                            <span className="truncate">{session.title}</span>
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5 truncate">
                            {session.dateSubtitle}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      {/* Right Column: Selected Session Review Pane */}
      <main className="flex-1 overflow-y-auto p-6 lg:p-8 min-w-0">
        {selectedSession ? (
          <div className="max-w-4xl flex flex-col gap-6">
            {/* Top Breadcrumb / Meta */}
            <div className="text-xs font-medium text-muted-foreground tracking-tight">
              <div>
                {selectedLearner?.name} / Attempt {selectedSession.attempt} /{" "}
                {selectedSession.durationMinutes} min / {selectedSession.formattedDate}
              </div>
            </div>

            {/* FATHOM-STYLE VIDEO / SCREEN RECORDING PLAYER */}
            <section
              ref={playerContainerRef}
              className="rounded-2xl border bg-card overflow-hidden shadow-xs flex flex-col"
            >
              {/* Player Top Bar */}
              <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/20">
                <div className="flex items-center gap-2.5">
                  <div className="size-7 rounded-lg bg-indigo-600 text-white flex items-center justify-center">
                    <VideoIcon className="size-3.5" />
                  </div>
                  <div>
                    <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
                      {isResolvingVideo ? "Checking screen recording…" : "Candidate Screen & Dialogue Recording"}
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal">
                        {isResolvingVideo ? "Loading" : "Screen + Cam + Voice"}
                      </Badge>
                    </h4>
                  </div>
                </div>

                <div className="text-xs font-mono text-muted-foreground pl-1">
                  {formatTime(currentTime)} / {formatTime(effectiveDuration)}
                </div>
              </div>

              {/* Video Screen Viewport */}
              {selectedSession.videoUrl && videoStatus !== "unavailable" ? (
                <div className="relative aspect-video w-full bg-black/95 flex items-center justify-center overflow-hidden group">
                  <video
                    key={selectedSession.id}
                    ref={videoRef}
                    src={selectedSession.videoUrl}
                    preload="metadata"
                    playsInline
                    onClick={handleTogglePlayPause}
                    onLoadedMetadata={(e) => {
                      setDuration(e.currentTarget.duration);
                      setVideoState({ sessionId: selectedSession.id, status: "ready" });
                    }}
                    onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onEnded={() => setIsPlaying(false)}
                    onError={() => {
                      console.warn("Video failed to stream.");
                      setVideoState({ sessionId: selectedSession.id, status: "unavailable" });
                    }}
                    className={cn("h-full w-full object-contain cursor-pointer", isResolvingVideo && "invisible")}
                  />

                  {isResolvingVideo && <LoaderCircle className="absolute size-8 animate-spin text-white" aria-label="Loading recording" />}
                  {/* Big Play Overlay (when paused) */}
                  {!isResolvingVideo && !isPlaying && (
                    <button
                      type="button"
                      onClick={handleTogglePlayPause}
                      className="absolute inset-0 m-auto size-16 rounded-full bg-indigo-600/90 text-white flex items-center justify-center shadow-lg hover:bg-indigo-600 hover:scale-105 transition-all cursor-pointer backdrop-blur-xs"
                      aria-label="Play recording"
                    >
                      <Play className="size-7 fill-current ml-1" />
                    </button>
                  )}
                </div>
              ) : null}

              {/* No recording fallback */}
              {videoStatus === "unavailable" && (
                <div className="p-8 text-center text-xs text-muted-foreground bg-muted/20">
                  <VolumeX className="size-6 mx-auto mb-2 opacity-50" />
                  No screen recording was captured for this session.
                </div>
              )}

              {/* Player Timeline Scrubber */}
              {!isResolvingVideo && hasVideo && (
                <div className="px-4 pt-3 pb-4 bg-card flex flex-col gap-2">
                  {/* Timeline */}
                  <div className="relative flex items-center group/timeline py-1">
                    <input
                      type="range"
                      min={0}
                      max={effectiveDuration || 100}
                      step={0.5}
                      value={currentTime}
                      onChange={(e) => handleSeek(parseFloat(e.target.value))}
                      className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer accent-indigo-600 focus:outline-hidden"
                    />
                  </div>

                  {/* Player Controls Toolbar */}
                  <div className="flex items-center justify-between gap-3 pt-1">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleTogglePlayPause}
                        className="size-8 shrink-0 rounded-full bg-indigo-600 text-white hover:bg-indigo-700 flex items-center justify-center transition-transform active:scale-95 cursor-pointer shadow-xs"
                        aria-label={isPlaying ? "Pause" : "Play"}
                      >
                        {isPlaying ? (
                          <Pause className="size-3.5 fill-current" />
                        ) : (
                          <Play className="size-3.5 fill-current ml-0.5" />
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => handleSeek(Math.max(0, currentTime - 10))}
                        className="p-1.5 text-muted-foreground hover:text-foreground transition-colors cursor-pointer rounded-md hover:bg-muted/50"
                        title="Rewind 10 seconds"
                      >
                        <RotateCcw className="size-4" />
                      </button>

                      <button
                        type="button"
                        onClick={handleToggleMute}
                        className="p-1.5 text-muted-foreground hover:text-foreground transition-colors cursor-pointer rounded-md hover:bg-muted/50"
                        aria-label={isMuted ? "Unmute" : "Mute"}
                      >
                        {isMuted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
                      </button>

                      <span className="text-xs font-mono text-muted-foreground pl-1">
                        {formatTime(currentTime)} / {formatTime(effectiveDuration)}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      {/* Playback speed selector */}
                      <button
                        type="button"
                        onClick={handleCycleRate}
                        className="px-2 py-1 text-xs font-semibold rounded-md bg-muted/60 hover:bg-muted text-foreground transition-colors cursor-pointer border border-border/50"
                        title="Change playback speed"
                      >
                        {playbackRate}x
                      </button>

                      {/* Fullscreen button */}
                      {hasVideo && (
                        <button
                          type="button"
                          onClick={handleToggleFullscreen}
                          className="p-1.5 text-muted-foreground hover:text-foreground transition-colors cursor-pointer rounded-md hover:bg-muted/50"
                          title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                        >
                          {isFullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </section>

            {!hasCompletedReport && selectedSession.reportStatus !== "completed" && (() => {
              const status = reportStatusCopy[selectedSession.reportStatus];
              const StatusIcon = selectedSession.reportStatus === "generating"
                ? LoaderCircle
                : selectedSession.reportStatus === "failed"
                  ? AlertCircle
                  : Clock3;
              return (
                <section className="rounded-2xl border bg-card p-5 sm:p-6">
                  <div className="flex items-start gap-3">
                    <StatusIcon className={cn("mt-0.5 size-5 text-muted-foreground", selectedSession.reportStatus === "generating" && "animate-spin")} />
                    <div>
                      <h3 className="text-sm font-semibold text-foreground">{status.title}</h3>
                      <p className="mt-1 text-xs sm:text-[13px] leading-relaxed text-muted-foreground">{status.description}</p>
                    </div>
                  </div>
                </section>
              );
            })()}

            {hasCompletedReport && <>
            {/* SCENARIO SUMMARY Section */}
            <section>
              <h3 className="text-sm font-semibold text-foreground tracking-tight mb-2.5">
                Scenario Summary
              </h3>
              <div className="rounded-2xl border border-indigo-100 dark:border-indigo-900/50 bg-[#F4F5FD] dark:bg-indigo-950/20 p-5 sm:p-6 relative border-l-4 border-l-indigo-600">
                <p className="text-xs sm:text-[13px] text-foreground leading-relaxed font-normal">
                  {selectedSession.summary}
                </p>

                {selectedSession.summaryTags && selectedSession.summaryTags.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-4">
                    {selectedSession.summaryTags.map((tag) => (
                      <Badge
                        key={tag}
                        variant="outline"
                        className="bg-background text-indigo-700 dark:text-indigo-300 border-indigo-200/80 dark:border-indigo-800 text-xs font-medium px-2.5 py-1 rounded shadow-2xs"
                      >
                        {tag}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            </section>

            {/* Key Moments to Review Section */}
            <section className="mt-1">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold tracking-tight text-foreground">
                    Key moments to review
                  </h3>
                  <Badge variant="outline" className="text-[10px] text-indigo-600 dark:text-indigo-400 border-indigo-200 dark:border-indigo-800">
                    <Sparkles className="size-3 mr-1" /> Click moment to jump in video
                  </Badge>
                </div>
                <span className="text-xs text-muted-foreground">
                  {selectedSession.keyMoments.length} moments selected
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {selectedSession.keyMoments.map((moment) => {
                  const momentSec = parseTimestampToSeconds(moment.timestamp, moment.seconds);
                  const isCurrentMoment =
                    currentTime >= momentSec &&
                    currentTime < momentSec + 45;

                  return (
                    <div
                      key={moment.id}
                      onClick={() => handleJumpToMoment(moment)}
                      className={cn(
                        "rounded-2xl border bg-card p-4 sm:p-5 shadow-2xs transition-all hover:shadow-xs cursor-pointer flex flex-col justify-between group",
                        isCurrentMoment
                          ? "border-indigo-500 ring-2 ring-indigo-500/20 bg-indigo-50/20 dark:bg-indigo-950/30"
                          : "hover:border-indigo-300 dark:hover:border-indigo-800"
                      )}
                    >
                      <div>
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-indigo-600 dark:text-indigo-400">
                            {moment.number}
                          </span>
                          <span className="inline-flex items-center gap-1 text-xs font-mono font-medium px-2 py-0.5 rounded-full bg-muted text-foreground group-hover:bg-indigo-100 dark:group-hover:bg-indigo-950/80 group-hover:text-indigo-600 dark:group-hover:text-indigo-300 transition-colors">
                            {moment.timestamp}
                          </span>
                        </div>

                        {/* Moment Subheading */}
                        <h4 className="font-semibold text-sm text-foreground mt-2.5 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                          {moment.title}
                        </h4>

                        {/* Quote */}
                        <p className="text-xs text-foreground italic mt-2 leading-relaxed">
                          {moment.quote}
                        </p>

                        {/* Description */}
                        <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                          {moment.description}
                        </p>
                      </div>

                      <div className="mt-4 pt-3 border-t border-border/40 flex items-center justify-between text-[11px] text-muted-foreground group-hover:text-indigo-600 dark:group-hover:text-indigo-400">
                        <span>Jump to timestamp</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
            </>}

            {/* Next Conversation Brief Section */}
            <section className="mt-1">
              <div className="mb-3">
                <h3 className="text-sm font-semibold tracking-tight text-foreground">
                  Next conversation brief
                </h3>
              </div>

              <div className="rounded-2xl border bg-card p-5 shadow-2xs">
                <div className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 uppercase tracking-wide mb-2">
                  Focus next time
                </div>
                <p className="text-xs sm:text-[13px] text-foreground leading-relaxed">
                  {selectedSession.focusNextTime}
                </p>
              </div>
            </section>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground text-xs">
            Select a session from the sidebar to review
          </div>
        )}
      </main>
    </div>
  );
}
