"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RoomAudioRenderer, RoomContext, useLocalParticipant, useStartAudio, useTrackToggle, useVoiceAssistant } from "@livekit/components-react";
import { Room, RoomEvent, Track, type LocalAudioTrack, type RemoteAudioTrack, type TranscriptionSegment } from "livekit-client";
import { z } from "zod";
import { Bubble, TwinPortrait } from "@/components/calibration/parts";
import { CallWaves } from "@/components/calibration/call-waves";
import { Button } from "@/components/ui/button";
import { publicVisitorNameSchema } from "@/lib/public-twin-settings";
import type { Trainer, Twin } from "@/components/twin/twin-learner-flow";

const launchSchema = z.object({
  session: z.object({ id: z.string(), runtimeToken: z.string(), secondsLeft: z.number(), endsAt: z.number().optional(), serverTime: z.number().optional() }),
  participantToken: z.string(),
});
type Connection = z.infer<typeof launchSchema>["session"];
type Caption = { id: string; speaker: "you" | "twin"; text: string };
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export function PublicTwinCall(props: { twin: Twin; trainer: Trainer; onBack: () => void }) {
  const room = useMemo(() => new Room({ audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }), []);
  return <RoomContext.Provider value={room}><VisitorCall room={room} {...props} /><RoomAudioRenderer /></RoomContext.Provider>;
}

function VisitorCall({ room, twin, trainer, onBack }: { room: Room; twin: Twin; trainer: Trainer; onBack: () => void }) {
  const [name, setName] = useState("");
  const [phase, setPhase] = useState<"ready" | "connecting" | "live" | "ended">("ready");
  const [error, setError] = useState("");
  const [remaining, setRemaining] = useState<number>(twin.publicAccess?.maxSeconds ?? 120);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const active = useRef<Connection | null>(null);
  const mounted = useRef(true);
  const ending = useRef(false);
  const starting = useRef(false);
  const deadline = useRef(0);
  const { enabled: micOn, pending, toggle } = useTrackToggle({ room, source: Track.Source.Microphone, onDeviceError: (failure) => setError(failure.message) });
  const { microphoneTrack } = useLocalParticipant({ room });
  const { audioTrack } = useVoiceAssistant();
  const { mergedProps: audioProps, canPlayAudio } = useStartAudio({ room, props: {} });

  const end = useCallback(async (unloading = false) => {
    if (ending.current) return;
    ending.current = true;
    const session = active.current;
    active.current = null;
    const closing = session ? fetch(`/api/public/sessions/${encodeURIComponent(session.id)}/end`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.runtimeToken}` },
      keepalive: unloading,
    }).then((response) => response.ok ? null : new Error("Could not confirm the call ended. The server will close it at its time limit."),
      (failure: unknown) => failure instanceof Error ? failure : new Error("Could not confirm the call ended.")) : Promise.resolve(null);
    await room.disconnect();
    if (mounted.current && !unloading) setPhase("ended");
    const failure = await closing;
    if (failure) {
      if (mounted.current && !unloading) setError(failure instanceof Error ? failure.message : "Could not confirm the call ended.");
      else console.error("Public call end failed", failure);
    }
  }, [room]);

  useEffect(() => {
    mounted.current = true;
    const leave = () => { void end(true); };
    window.addEventListener("pagehide", leave);
    return () => {
      mounted.current = false;
      window.removeEventListener("pagehide", leave);
      void end(true);
    };
  }, [end]);

  useEffect(() => {
    const transcription = (segments: TranscriptionSegment[], participant?: { identity?: string }) => {
      const speaker = participant?.identity === room.localParticipant.identity ? "you" : "twin";
      setCaptions((previous) => {
        const next = [...previous];
        for (const segment of segments) {
          if (!segment.text) continue;
          const id = `${participant?.identity}:${segment.id}`;
          const index = next.findIndex((caption) => caption.id === id);
          const caption: Caption = { id, speaker, text: segment.text };
          if (index < 0) next.push(caption);
          else next[index] = caption;
        }
        return next;
      });
    };
    const disconnected = () => { if (active.current) void end(); };
    const data = (payload: Uint8Array) => {
      const text = new TextDecoder().decode(payload);
      if (!text.startsWith("{")) return;
      const parsed = z.object({ type: z.string() }).safeParse((() => { try { return JSON.parse(text); } catch { return null; } })());
      if (parsed.success && parsed.data.type === "session-ended") void end();
    };
    room.on(RoomEvent.TranscriptionReceived, transcription).on(RoomEvent.Disconnected, disconnected).on(RoomEvent.DataReceived, data);
    return () => { room.off(RoomEvent.TranscriptionReceived, transcription).off(RoomEvent.Disconnected, disconnected).off(RoomEvent.DataReceived, data); };
  }, [room, end]);

  useEffect(() => {
    if (phase !== "live") return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadline.current - performance.now()) / 1000));
      setRemaining(left);
      if (!left) void end();
    };
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [phase, end]);

  async function start() {
    if (starting.current) return;
    const parsed = publicVisitorNameSchema.safeParse(name);
    if (!parsed.success) return setError(parsed.error.issues[0].message);
    starting.current = true;
    ending.current = false;
    setError("");
    setPhase("connecting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      if (!mounted.current || ending.current) return;
      const url = process.env.NEXT_PUBLIC_LIVEKIT_URL;
      if (!url) throw new Error("Voice calls are not configured.");
      const response = await fetch(`/api/public/twins/${encodeURIComponent(twin.id ?? "")}/sessions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: parsed.data }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : "Could not start the call.");
      const launch = launchSchema.parse(payload);
      active.current = launch.session;
      const allowance = launch.session.secondsLeft * 1000;
      deadline.current = performance.now() + Math.max(0, Math.min(allowance,
        launch.session.endsAt !== undefined && launch.session.serverTime !== undefined ? launch.session.endsAt - launch.session.serverTime : allowance));
      if (!mounted.current || ending.current) {
        ending.current = false;
        await end(true);
        return;
      }
      await room.connect(url, launch.participantToken);
      if (!mounted.current || ending.current) { await room.disconnect(); return; }
      await room.localParticipant.setMicrophoneEnabled(true);
      if (!mounted.current || ending.current) { await room.disconnect(); return; }
      setPhase("live");
    } catch (failure) {
      const cancelled = ending.current;
      await end(!mounted.current);
      if (mounted.current && !cancelled) {
        setError(failure instanceof Error && failure.name === "NotAllowedError" ? "Microphone access was denied. Allow it in your browser’s site settings, then try again." : failure instanceof Error ? failure.message : "Could not start the call.");
        setPhase("ready");
      }
    } finally {
      starting.current = false;
    }
  }

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-[640px] flex-col items-center gap-6 px-6 py-8">
      <TwinPortrait name={trainer.name} photoUrl={trainer.photoUrl} className="size-48 shrink-0 rounded-3xl text-6xl" />
      <h1 className="m-0 text-xl font-semibold">{twin.name}</h1>
      {phase === "ready" ? <form className="flex w-full flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void start(); }}>
        <p className="text-sm text-muted-foreground">You’re speaking with an AI twin, not {trainer.name}. This voice call is transcribed and may be recorded. The organization can review your name, transcript, any recording and call usage. No camera or screen sharing is requested.</p>
        <p className="text-sm text-muted-foreground">Up to {(twin.publicAccess?.maxSeconds ?? 120) / 60} minutes, funded by the organization. Your name is self-reported; no account is created.</p>
        <label htmlFor="visitor-name" className="text-sm font-medium">Your name</label>
        <input id="visitor-name" autoComplete="name" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} className="h-10 rounded-lg border bg-card px-3 text-sm" required />
        <Button type="submit" variant="brand" disabled={!name.trim()}>Start voice call</Button>
      </form> : phase === "ended" ? <p role="status">Call ended. Thank you for talking.</p> : <>
        <p role="status" className="text-sm text-muted-foreground">{phase === "connecting" ? "Connecting…" : `${clock(remaining)} left`}</p>
        {phase === "live" ? <CallWaves agentTrack={audioTrack?.publication.track as RemoteAudioTrack | undefined} micTrack={microphoneTrack?.track as LocalAudioTrack | undefined} /> : null}
        {!canPlayAudio && phase === "live" ? <Button {...audioProps}>Turn on sound</Button> : null}
        <div aria-live="polite" className="flex max-h-[35vh] w-full flex-col gap-3 overflow-y-auto">
          {captions.map((caption) => <Bubble key={caption.id} speaker={caption.speaker}>{caption.text}</Bubble>)}
        </div>
        <div className="flex gap-4">
          <Button variant="outline" disabled={phase !== "live" || pending} onClick={() => void toggle()}>{micOn ? "Mute" : "Unmute"}</Button>
          <Button variant="destructive" onClick={() => void end()}>End call</Button>
        </div>
      </>}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {phase === "ready" || phase === "ended" ? <Button variant="ghost" onClick={onBack}>Back to profile</Button> : null}
    </main>
  );
}
