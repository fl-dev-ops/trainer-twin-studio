"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ChevronDown,
  ChevronUp,
  GraduationCap,
  Pause,
  Play,
  UserPlus,
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
import type { KeyMoment, SessionReport } from "@/lib/session-report";

export type LearnerSessionItem = {
  id: string;
  title: string;
  attempt: number;
  durationMinutes: number;
  formattedDate: string;
  dateSubtitle: string;
  summary: string;
  summaryTags: string[];
  keyMoments: KeyMoment[];
  focusNextTime: string;
  audioUrl?: string;
  report?: SessionReport;
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

  const [playingMomentId, setPlayingMomentId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  const selectedLearner =
    learners.find((l) => l.id === selectedLearnerId) ??
    learners.find((l) => l.sessions.some((s) => s.id === selectedSessionId)) ??
    learners[0];

  const selectedSession =
    selectedLearner?.sessions.find((s) => s.id === selectedSessionId) ??
    selectedLearner?.sessions[0];

  const totalSessions = learners.reduce(
    (sum, l) => sum + (l.sessions?.length || l.completedSessionsCount || 0),
    0
  );

  useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    setPlayingMomentId(null);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  }, [selectedSessionId]);

  const toggleLearnerExpand = (id: string) => {
    setExpandedLearnerIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleSelectSession = (learnerId: string, sessionId: string) => {
    setSelectedLearnerId(learnerId);
    setSelectedSessionId(sessionId);
    setPlayingMomentId(null);
  };

  const handleTogglePlayPause = () => {
    if (!audioRef.current || !selectedSession?.audioUrl) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
      setPlayingMomentId(null);
    } else {
      audioRef.current.play().then(() => {
        setIsPlaying(true);
      }).catch((err) => {
        console.warn("Could not play session audio:", err);
        setIsPlaying(false);
      });
    }
  };

  const handlePlayMoment = (moment: KeyMoment) => {
    if (!audioRef.current || !selectedSession?.audioUrl) return;

    const targetSeconds = moment.seconds ?? 0;
    audioRef.current.currentTime = targetSeconds;
    audioRef.current.play().then(() => {
      setIsPlaying(true);
      setPlayingMomentId(moment.id);
    }).catch((err) => {
      console.warn("Could not play moment audio:", err);
      setIsPlaying(false);
    });
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedSession?.audioUrl) return;
    const time = parseFloat(e.target.value);
    setCurrentTime(time);
    if (audioRef.current) {
      audioRef.current.currentTime = time;
    }
  };

  const handleToggleMute = () => {
    if (!audioRef.current) return;
    const nextMute = !isMuted;
    audioRef.current.muted = nextMute;
    setIsMuted(nextMute);
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
              When learners accept an invitation and complete a role play session, their AI performance
              evaluation, audio recording, and coaching briefs will appear here.
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

  return (
    <div className="flex h-full w-full min-h-0 flex-1 overflow-hidden bg-background text-foreground">
      {/* Left Column: Learners & Completed Sessions Sidebar */}
      <aside className="w-80 sm:w-84 shrink-0 border-r flex flex-col bg-card/40 overflow-hidden">
        {/* Header Count: 12px */}
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
                {/* Learner Item Header: 14px Name, 12px Subtitle */}
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

                {/* Sub-sessions List: 14px Title, 12px Subtitle */}
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
                              "text-sm tracking-tight truncate",
                              isSelected ? "font-semibold text-foreground" : "font-medium"
                            )}
                          >
                            {session.title}
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
            {/* Top Breadcrumb / Meta: 12px */}
            <div className="text-xs font-medium text-muted-foreground tracking-tight">
              {selectedLearner?.name} / Attempt {selectedSession.attempt} /{" "}
              {selectedSession.durationMinutes} min / {selectedSession.formattedDate}
            </div>

            {/* AUDIO PLAYER: 14px Subheading, 12px Meta */}
            <section className="rounded-2xl border bg-card p-4 sm:p-5 shadow-2xs">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2.5">
                  <div className="size-8 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
                    <Volume2 className="size-4" />
                  </div>
                  <div>
                    <h4 className="text-sm font-semibold text-foreground">Session Audio</h4>
                    <p className="text-xs text-muted-foreground">
                      {selectedSession.audioUrl
                        ? "Full dialogue recording · Select \"Play moment\" below to scrub to specific turns"
                        : "Recording unavailable for this session"}
                    </p>
                  </div>
                </div>

                {selectedSession.audioUrl && (
                  <div className="text-xs font-mono text-muted-foreground">
                    {formatTime(currentTime)} / {formatTime(duration || selectedSession.durationMinutes * 60)}
                  </div>
                )}
              </div>

              {selectedSession.audioUrl ? (
                <>
                  {/* Audio Controls */}
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={handleTogglePlayPause}
                      className="size-8 shrink-0 rounded-full bg-indigo-600 text-white hover:bg-indigo-700 flex items-center justify-center transition-transform active:scale-95 cursor-pointer shadow-xs"
                      aria-label={isPlaying ? "Pause audio" : "Play audio"}
                    >
                      {isPlaying ? (
                        <Pause className="size-3.5 fill-current" />
                      ) : (
                        <Play className="size-3.5 fill-current ml-0.5" />
                      )}
                    </button>

                    {/* Scrubber Range Bar */}
                    <div className="relative flex-1 flex items-center">
                      <input
                        type="range"
                        min={0}
                        max={duration || selectedSession.durationMinutes * 60 || 100}
                        step={1}
                        value={currentTime}
                        onChange={handleSeek}
                        className="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-indigo-600 focus:outline-hidden"
                      />
                    </div>

                    <button
                      type="button"
                      onClick={handleToggleMute}
                      className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer p-1"
                      aria-label={isMuted ? "Unmute audio" : "Mute audio"}
                    >
                      {isMuted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
                    </button>
                  </div>

                  {/* Audio Element */}
                  <audio
                    ref={audioRef}
                    src={selectedSession.audioUrl}
                    preload="metadata"
                    onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
                    onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onEnded={() => {
                      setIsPlaying(false);
                      setPlayingMomentId(null);
                    }}
                    className="hidden"
                  />
                </>
              ) : (
                <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/30 py-2.5 px-3 rounded-lg border border-border/40">
                  <VolumeX className="size-3.5 shrink-0 text-muted-foreground/70" />
                  <span>No audio recording was captured for this session.</span>
                </div>
              )}
            </section>

            {/* SCENARIO SUMMARY Section: 14px Subheading, 12px Body */}
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

            {/* Key Moments to Review Section: 14px Subheading, 12px Body */}
            <section className="mt-1">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold tracking-tight text-foreground">
                  Key moments to review
                </h3>
                <span className="text-xs text-muted-foreground">
                  {selectedSession.keyMoments.length} moments selected from conversation
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {selectedSession.keyMoments.map((moment) => {
                  const isCurrentMoment = playingMomentId === moment.id;
                  return (
                    <div
                      key={moment.id}
                      className={cn(
                        "rounded-2xl border p-4 sm:p-5 flex flex-col justify-between shadow-2xs transition-all",
                        isCurrentMoment
                          ? "border-indigo-500 bg-indigo-50/20 dark:bg-indigo-950/30 ring-2 ring-indigo-500/20"
                          : "bg-card hover:shadow-xs"
                      )}
                    >
                      <div>
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-indigo-600 dark:text-indigo-400">
                            {moment.number}
                          </span>
                          <span className="text-xs font-mono text-muted-foreground">
                            {moment.timestamp}
                          </span>
                        </div>

                        {/* Moment Subheading: 14px */}
                        <h4 className="font-semibold text-sm text-foreground mt-2.5">
                          {moment.title}
                        </h4>

                        {/* Quote: 12px */}
                        <p className="text-xs text-foreground italic mt-2 leading-relaxed">
                          {moment.quote}
                        </p>

                        {/* Description: 12px */}
                        <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                          {moment.description}
                        </p>
                      </div>

                      {selectedSession.audioUrl ? (
                        <div className="mt-4 pt-2.5 border-t border-border/40">
                          <button
                            type="button"
                            onClick={() => handlePlayMoment(moment)}
                            className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline transition-colors cursor-pointer"
                          >
                            {isCurrentMoment && isPlaying ? (
                              <>
                                <Volume2 className="size-3.5 animate-pulse text-indigo-600 dark:text-indigo-400" />
                                <span>Playing at {moment.timestamp}...</span>
                              </>
                            ) : (
                              <>
                                <Play className="size-3 fill-current text-indigo-600 dark:text-indigo-400" />
                                <span>Play moment</span>
                              </>
                            )}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Next Conversation Brief Section: 14px Subheading, 12px Body */}
            <section className="mt-1">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold tracking-tight text-foreground">
                  Next conversation brief
                </h3>
                <span className="text-xs text-muted-foreground">
                  Derived from unresolved scenario evidence
                </span>
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
