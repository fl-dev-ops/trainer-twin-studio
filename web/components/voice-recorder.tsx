"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { LiveWaveform } from "@/components/ui/live-waveform";
import { MicIcon, type MicIconHandle } from "@/components/ui/mic";
import { encodeWav } from "@/lib/wav";

const TARGET_SECONDS = 20;
const MIN_SECONDS = 10;
const MAX_SECONDS = 30;

type Phase = "idle" | "recording";

export function VoiceRecorder({
  onFinished,
  disabled = false,
}: {
  onFinished: (wav: Blob) => void;
  disabled?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string>();

  const recorderRef = useRef<MediaRecorder | null>(null);
  const micIconRef = useRef<MicIconHandle>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);
  const finishingRef = useRef(false);
  // LiveWaveform re-runs its mic effect whenever callback props change
  // identity, which tears down the stream every render — keep these stable.
  const finishRef = useRef<() => void>(() => {});

  const onStreamReady = useCallback((stream: MediaStream) => {
    streamRef.current = stream;
    const recorder = new MediaRecorder(stream);
    chunksRef.current = [];
    recorder.ondataavailable = (event) =>
      event.data.size > 0 && chunksRef.current.push(event.data);
    recorder.start(250);
    recorderRef.current = recorder;

    startedAtRef.current = Date.now();
    timerRef.current = setInterval(() => {
      const elapsed = (Date.now() - startedAtRef.current) / 1000;
      setSeconds(elapsed);
      if (elapsed >= MAX_SECONDS) finishRef.current();
    }, 100);
  }, []);

  const onMicError = useCallback(() => {
    setError(
      "Microphone access was blocked. Allow it in your browser and try again.",
    );
    setPhase("idle");
  }, []);

  useEffect(() => () => stopEverything(), []);

  function stopEverything() {
    if (timerRef.current) clearInterval(timerRef.current);
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  function start() {
    setError(undefined);
    finishingRef.current = false;
    setSeconds(0);
    // LiveWaveform requests the mic and hands us the stream via onStreamReady.
    setPhase("recording");
  }

  function finish() {
    const recorder = recorderRef.current;
    if (!recorder || finishingRef.current) return;
    const elapsed = (Date.now() - startedAtRef.current) / 1000;
    if (elapsed < MIN_SECONDS) {
      setError(
        `Read the whole passage — at least ${MIN_SECONDS} seconds of speech is needed.`,
      );
      return;
    }
    finishingRef.current = true;
    if (timerRef.current) clearInterval(timerRef.current);

    recorder.onstop = async () => {
      const webm = new Blob(chunksRef.current, { type: recorder.mimeType });
      stopEverything();
      const context = new AudioContext();
      try {
        const decoded = await context.decodeAudioData(await webm.arrayBuffer());
        // mix down to mono 16-bit WAV — VoxCPM needs a decodable reference
        const mono = new Float32Array(decoded.length);
        for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
          const data = decoded.getChannelData(channel);
          for (let i = 0; i < decoded.length; i++)
            mono[i] += data[i] / decoded.numberOfChannels;
        }
        onFinished(encodeWav(mono, decoded.sampleRate));
      } catch {
        toast.error(
          "That recording could not be processed. Please record again.",
        );
      } finally {
        setPhase("idle");
        void context.close();
      }
    };
    recorder.stop();
  }

  finishRef.current = finish;

  function cancel() {
    stopEverything();
    setPhase("idle");
    setSeconds(0);
  }

  const recording = phase === "recording";
  const fmt = (value: number) =>
    `0:${String(Math.min(59, Math.floor(value))).padStart(2, "0")}`;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="rounded-3xl bg-muted/40 p-7 sm:p-8">
        <div className="flex items-center justify-center overflow-hidden">
          <LiveWaveform
            mode="static"
            active={recording}
            onStreamReady={onStreamReady}
            onError={onMicError}
            barColor="var(--color-primary)"
            height={192}
            className="w-full"
          />
        </div>
        <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">Selected language · English</p>
          <div className="flex items-center justify-between gap-4 sm:justify-end">
            <span className="flex items-center gap-2 font-sans text-sm font-medium tabular-nums">
              {recording && (
                <span
                  className="size-2 animate-pulse rounded-full bg-destructive"
                  aria-hidden="true"
                />
              )}
              {fmt(seconds)}{" "}
              <span className="text-muted-foreground">
                / {fmt(TARGET_SECONDS)}
              </span>
            </span>
            {recording ? (
              <>
                <Button variant="ghost" size="sm" onClick={cancel}>
                  Re-record
                </Button>
                <Button
                  size="sm"
                  onClick={finish}
                  disabled={seconds < MIN_SECONDS}
                  className="rounded-full bg-foreground px-5 text-background hover:bg-foreground/85"
                >
                  <Square /> Finish
                </Button>
              </>
            ) : (
              <Button
                size="lg"
                onClick={start}
                onMouseEnter={() => micIconRef.current?.startAnimation()}
                onMouseLeave={() => micIconRef.current?.stopAnimation()}
                disabled={disabled}
                className="rounded-full bg-foreground px-5 text-background hover:bg-foreground/85"
              >
                <MicIcon ref={micIconRef} size={16} /> Start recording
              </Button>
            )}
          </div>
        </div>
      </div>
      <p className="mt-5 text-center text-xs text-muted-foreground">
        Read the passage clearly · Use a quiet place · Min. {MIN_SECONDS}s
        recording
      </p>
      {error && (
        <p role="alert" className="mt-2 text-center text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
