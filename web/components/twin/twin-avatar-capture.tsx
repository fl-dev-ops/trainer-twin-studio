"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Camera, RefreshCw, RotateCcw, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { twinClient } from "@/lib/twin/client";
import { randomPassage, VOICE_PASSAGES } from "@/lib/voice-passage";
import { recordingToWav } from "@/lib/wav";
import { cn } from "@/lib/utils";

const MIN_SECONDS = 10;
const TARGET_SECONDS = 20;
const MAX_SECONDS = 30;
const PHOTO_SIZE = 720;
const VIDEO_TYPES = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];

type Stage = "photo" | "record" | "review" | "saving";
type Take = { video: Blob; audio: Blob; contentType: "video/webm" | "video/mp4"; url: string };

const fmt = (value: number) => `0:${String(Math.min(59, Math.floor(value))).padStart(2, "0")}`;

/**
 * Two steps on one camera + mic stream: (1) take a photo, the twin's avatar image; (2) read a passage on camera.
 * The take's audio clones the voice (existing /api/tts/voices); the video is stored as the AI avatar reference.
 */
export function TwinAvatarCapture({ personaName }: { personaName: string | null }) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordersRef = useRef<{ video: MediaRecorder; audio: MediaRecorder; chunks: { video: Blob[]; audio: Blob[] } } | null>(null);
  const startedAtRef = useRef(0);
  const [cameraError, setCameraError] = useState("");
  const [cameraReady, setCameraReady] = useState(false);
  const [stage, setStage] = useState<Stage>("photo");
  const [photo, setPhoto] = useState<string | null>(null);
  const [passage, setPassage] = useState(VOICE_PASSAGES[0]);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [take, setTake] = useState<Take | null>(null);
  const [progress, setProgress] = useState("");

  async function openCamera() {
    setCameraError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCameraReady(true);
    } catch {
      setCameraError("Camera or microphone access was blocked. Allow both in your browser, then try again.");
    }
  }

  useEffect(() => {
    void Promise.resolve().then(openCamera);
    return () => {
      for (const recorder of [recordersRef.current?.video, recordersRef.current?.audio]) {
        if (recorder?.state === "recording") recorder.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => () => {
    if (take) URL.revokeObjectURL(take.url);
  }, [take]);

  /** The live preview is re-mounted between steps (retake, record again): give it the stream each time. */
  function attachPreview(element: HTMLVideoElement | null) {
    videoRef.current = element;
    if (element && streamRef.current && element.srcObject !== streamRef.current) element.srcObject = streamRef.current;
  }

  function takePhoto() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const side = Math.min(video.videoWidth, video.videoHeight);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = PHOTO_SIZE;
    const context = canvas.getContext("2d");
    if (!context) return;
    // Saved as seen in the (mirrored) preview, centred square crop.
    context.translate(PHOTO_SIZE, 0);
    context.scale(-1, 1);
    context.drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
    setPhoto(canvas.toDataURL("image/jpeg", 0.9));
  }

  function startRecording() {
    const stream = streamRef.current;
    if (!stream) return;
    const mimeType = VIDEO_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
    const chunks = { video: [] as Blob[], audio: [] as Blob[] };
    const video = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 2_500_000 });
    // The voice is cloned from an audio-only recording of the same take (decodes everywhere, unlike video files).
    const audio = new MediaRecorder(new MediaStream(stream.getAudioTracks()));
    video.ondataavailable = (event) => event.data.size > 0 && chunks.video.push(event.data);
    audio.ondataavailable = (event) => event.data.size > 0 && chunks.audio.push(event.data);
    video.start(250);
    audio.start(250);
    recordersRef.current = { video, audio, chunks };
    startedAtRef.current = Date.now();
    setSeconds(0);
    setRecording(true);
  }

  async function stopRecorders(keep: boolean) {
    const current = recordersRef.current;
    recordersRef.current = null;
    setRecording(false);
    if (!current) return;
    const stopped = (recorder: MediaRecorder) =>
      new Promise<void>((resolve) => {
        if (recorder.state === "inactive") return resolve();
        recorder.onstop = () => resolve();
        recorder.stop();
      });
    await Promise.all([stopped(current.video), stopped(current.audio)]);
    if (!keep) return;
    const type = current.video.mimeType || "video/webm";
    const video = new Blob(current.chunks.video, { type });
    setTake({
      video,
      audio: new Blob(current.chunks.audio, { type: current.audio.mimeType }),
      contentType: type.startsWith("video/mp4") ? "video/mp4" : "video/webm",
      url: URL.createObjectURL(video),
    });
    setStage("review");
  }

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => {
      const elapsed = (Date.now() - startedAtRef.current) / 1000;
      setSeconds(elapsed);
      if (elapsed >= MAX_SECONDS) void stopRecorders(true);
    }, 100);
    return () => clearInterval(id);
  }, [recording]);

  async function save() {
    if (!take || !photo) return;
    setStage("saving");
    try {
      setProgress("Uploading your video\u2026");
      const upload = await twinClient.avatar.videoUploadUrl.mutate({ contentType: take.contentType });
      const put = await fetch(upload.url, { method: "PUT", headers: { "Content-Type": take.contentType }, body: take.video });
      if (!put.ok) throw new Error("The video could not be uploaded.");

      setProgress("Cloning your voice\u2026");
      const form = new FormData();
      form.set("audio", new File([await recordingToWav(take.audio)], "reference.wav", { type: "audio/wav" }));
      form.set("transcript", passage);
      if (personaName) form.set("name", `${personaName}'s voice`);
      const cloned = await fetch("/api/tts/voices", { method: "POST", body: form });
      const body = await cloned.json().catch(() => ({}));
      if (!cloned.ok || !body.voice?.id) throw new Error(body.error ?? "Your voice could not be saved.");

      setProgress("Saving\u2026");
      await twinClient.avatar.save.mutate({ photo, videoKey: upload.key, voiceId: body.voice.id });
      toast.success("Your photo, voice and video are saved.");
      router.push("/twin/brain");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save. Please try again.");
      setStage("review");
    }
  }

  const live = stage === "photo" ? !photo : stage === "record";

  return (
    <main className="min-h-svh bg-muted p-2">
      <div className="min-h-[calc(100svh-1rem)] rounded-2xl bg-background">
        <header className="flex items-center justify-between gap-4 px-5 py-5 sm:px-9 sm:py-7">
          <Button variant="ghost" size="sm" className="-ml-2 text-base font-medium" render={<Link href="/twin/brain" />} nativeButton={false}>
            <ArrowLeft data-icon="inline-start" /> Voice and avatar
          </Button>
          <p className="text-sm text-muted-foreground">Step {stage === "photo" ? 1 : 2} of 2</p>
        </header>

        <section className="mx-auto flex w-full max-w-3xl flex-col items-center gap-8 px-5 pt-[4vh] pb-12 sm:px-8">
          {!personaName ? (
            <p className="text-sm text-muted-foreground">Set up your twin first: there is no persona of your own yet.</p>
          ) : cameraError ? (
            <div role="alert" className="flex flex-col items-center gap-3 text-center">
              <p className="text-sm text-muted-foreground">{cameraError}</p>
              <Button variant="outline" className="rounded-full" onClick={() => void openCamera()}>Try again</Button>
            </div>
          ) : (
            <>
              <div className="flex flex-col items-center gap-2 text-center">
                <h1 className="text-2xl font-semibold tracking-[-0.015em]">
                  {stage === "photo" ? "Take a photo" : "Read this out aloud"}
                </h1>
                <p className="text-sm text-muted-foreground">
                  {stage === "photo"
                    ? "This becomes your twin's picture. Face the camera in good light."
                    : "Look at the camera and read the passage. We clone your voice from it and keep the video for your AI avatar."}
                </p>
              </div>

              <div
                className={cn(
                  "relative overflow-hidden rounded-3xl bg-muted",
                  stage === "photo" ? "size-[min(420px,80vw)]" : "aspect-video w-full max-w-xl",
                )}
              >
                {stage === "review" || stage === "saving" ? (
                  <video key="take" src={take?.url} controls playsInline className="size-full object-cover" />
                ) : stage === "photo" && photo ? (
                  // eslint-disable-next-line @next/next/no-img-element -- local data URL preview
                  <img src={photo} alt="Your photo" className="size-full object-cover" />
                ) : (
                  <video key="live" ref={attachPreview} autoPlay muted playsInline className="size-full -scale-x-100 object-cover" aria-label="Camera preview" />
                )}
                {live && !cameraReady ? (
                  <p className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">Starting camera…</p>
                ) : null}
                {recording ? (
                  <span className="absolute top-3 left-3 flex items-center gap-2 rounded-full bg-black/55 px-3 py-1 text-sm font-medium text-white tabular-nums">
                    <span aria-hidden className="size-2 animate-pulse rounded-full bg-red-500" />
                    {fmt(seconds)} <span className="text-white/70">/ {fmt(TARGET_SECONDS)}</span>
                  </span>
                ) : null}
              </div>

              {stage !== "photo" ? (
                <div className="w-full">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-muted-foreground">Read this out aloud</p>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="-mr-2 text-muted-foreground"
                      aria-label="Try another text"
                      title="Try another text"
                      disabled={stage !== "record" || recording}
                      onClick={() => setPassage(randomPassage(passage))}
                    >
                      <RefreshCw />
                    </Button>
                  </div>
                  <p className="mt-4 font-serif text-2xl leading-[1.2] tracking-tight sm:text-3xl">{passage}</p>
                </div>
              ) : null}

              <div className="flex flex-wrap items-center justify-center gap-3">
                {stage === "photo" ? (
                  photo ? (
                    <>
                      <Button variant="outline" className="rounded-full" onClick={() => setPhoto(null)}>
                        <RotateCcw data-icon="inline-start" /> Retake
                      </Button>
                      <Button className="rounded-full" onClick={() => setStage("record")}>Use this photo</Button>
                    </>
                  ) : (
                    <Button className="rounded-full" disabled={!cameraReady} onClick={takePhoto}>
                      <Camera data-icon="inline-start" /> Take photo
                    </Button>
                  )
                ) : stage === "record" ? (
                  recording ? (
                    <>
                      <Button variant="ghost" className="rounded-full" onClick={() => void stopRecorders(false)}>Re-record</Button>
                      <Button className="rounded-full" disabled={seconds < MIN_SECONDS} onClick={() => void stopRecorders(true)}>
                        <Square data-icon="inline-start" /> Finish
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button variant="ghost" className="rounded-full" onClick={() => { setPhoto(null); setStage("photo"); }}>Back to photo</Button>
                      <Button className="rounded-full" disabled={!cameraReady} onClick={startRecording}>Start recording</Button>
                    </>
                  )
                ) : (
                  <>
                    <Button variant="outline" className="rounded-full" disabled={stage === "saving"} onClick={() => { setTake(null); setStage("record"); }}>
                      <RotateCcw data-icon="inline-start" /> Record again
                    </Button>
                    <Button className="rounded-full" disabled={stage === "saving"} onClick={() => void save()}>
                      {stage === "saving" ? progress : "Save"}
                    </Button>
                  </>
                )}
              </div>
              {stage === "record" ? (
                <p className="text-center text-xs text-muted-foreground">
                  Quiet place · Read the whole passage · Min. {MIN_SECONDS}s, stops at {MAX_SECONDS}s
                </p>
              ) : null}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
