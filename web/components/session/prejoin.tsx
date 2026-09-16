"use client";

import Image from "next/image";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Camera,
  ChevronDown,
  FileUp,
  LoaderCircle,
  Mic,
  MicOff,
  RotateCcw,
  Trash,
  Video,
  VideoOff,
  Volume2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "../ui/button";

export type PreJoinMediaSettings = {
  microphoneEnabled: boolean;
  cameraEnabled: boolean;
  microphoneDeviceId?: string;
  cameraDeviceId?: string;
  speakerDeviceId?: string;
};

export type PreJoinDocument = { id: string; name: string; size?: number };

type DeviceOption = { deviceId: string; label: string };
type PermissionState = "requesting" | "ready" | "denied" | "unsupported";

const CONTEXT_ACCEPT =
  ".md,.txt,.pdf,.docx,.doc,.pptx,.ppt,.xlsx,.xls,.csv,.json,.png,.jpg,.jpeg,.webp";

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function PreJoin({
  scenarioName,
  userName,
  organizationName,
  organizationLogo,
  contexts = [],
  contextRequired = false,
  onJoin,
}: {
  scenarioName: string;
  userName: string;
  organizationName: string;
  organizationLogo: string | null;
  /** The learner's previously uploaded context documents. */
  contexts?: PreJoinDocument[];
  /** Scenario cannot run without an attached document. */
  contextRequired?: boolean;
  onJoin: (settings: PreJoinMediaSettings, contextId?: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const previewRequestRef = useRef(0);
  const micEnabledRef = useRef(true);
  const cameraEnabledRef = useRef(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);

  const [permission, setPermission] = useState<PermissionState>("requesting");
  const [permissionError, setPermissionError] = useState("");
  const [microphoneAvailable, setMicrophoneAvailable] = useState(false);
  const [cameraAvailable, setCameraAvailable] = useState(false);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [microphones, setMicrophones] = useState<DeviceOption[]>([]);
  const [cameras, setCameras] = useState<DeviceOption[]>([]);
  const [speakers, setSpeakers] = useState<DeviceOption[]>([]);
  const [microphoneDeviceId, setMicrophoneDeviceId] = useState("");
  const [cameraDeviceId, setCameraDeviceId] = useState("");
  const [speakerDeviceId, setSpeakerDeviceId] = useState("");

  const [availableDocs, setAvailableDocs] =
    useState<PreJoinDocument[]>(contexts);
  const [selectedDoc, setSelectedDoc] = useState<PreJoinDocument | null>(
    contexts[0] ?? null,
  );
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [docError, setDocError] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const docAttached = Boolean(selectedDoc);

  const releasePreview = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const stopPreview = useCallback(() => {
    previewRequestRef.current += 1;
    releasePreview();
  }, [releasePreview]);

  const loadDevices = useCallback(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const options = (kind: MediaDeviceKind) =>
      devices
        .filter((device) => device.kind === kind)
        .map((device, index) => ({
          deviceId: device.deviceId,
          label:
            device.label ||
            `${kind === "audioinput" ? "Microphone" : kind === "videoinput" ? "Camera" : "Speaker"} ${index + 1}`,
        }));
    const nextMicrophones = options("audioinput");
    const nextCameras = options("videoinput");
    const nextSpeakers = options("audiooutput");
    setMicrophones(nextMicrophones);
    setCameras(nextCameras);
    setSpeakers(nextSpeakers);
    setMicrophoneDeviceId(
      (current) => current || nextMicrophones[0]?.deviceId || "",
    );
    setCameraDeviceId((current) => current || nextCameras[0]?.deviceId || "");
    setSpeakerDeviceId((current) => current || nextSpeakers[0]?.deviceId || "");
  }, []);

  const startPreview = useCallback(
    async (audioId?: string, videoId?: string) => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setPermission("unsupported");
        setPermissionError(
          "This browser does not support camera and microphone access.",
        );
        setMicrophoneAvailable(false);
        setCameraAvailable(false);
        setMicrophoneEnabled(false);
        setCameraEnabled(false);
        micEnabledRef.current = false;
        cameraEnabledRef.current = false;
        return;
      }

      const requestId = ++previewRequestRef.current;
      setPermission("requesting");
      setPermissionError("");
      releasePreview();
      const [audioResult, videoResult] = await Promise.allSettled([
        navigator.mediaDevices.getUserMedia({
          audio: audioId ? { deviceId: { exact: audioId } } : true,
          video: false,
        }),
        navigator.mediaDevices.getUserMedia({
          audio: false,
          video: videoId ? { deviceId: { exact: videoId } } : true,
        }),
      ]);
      const streams = [audioResult, videoResult]
        .filter(
          (result): result is PromiseFulfilledResult<MediaStream> =>
            result.status === "fulfilled",
        )
        .map((result) => result.value);

      if (requestId !== previewRequestRef.current) {
        streams.forEach((stream) =>
          stream.getTracks().forEach((track) => track.stop()),
        );
        return;
      }

      const hasMicrophone = audioResult.status === "fulfilled";
      const hasCamera = videoResult.status === "fulfilled";
      setMicrophoneAvailable(hasMicrophone);
      setCameraAvailable(hasCamera);
      setMicrophoneEnabled(hasMicrophone && micEnabledRef.current);
      setCameraEnabled(hasCamera && cameraEnabledRef.current);

      if (!hasMicrophone) micEnabledRef.current = false;
      if (!hasCamera) cameraEnabledRef.current = false;
      if (!hasMicrophone && !hasCamera) {
        setPermission("denied");
        setPermissionError(
          "Allow camera and microphone access in your browser, then try again.",
        );
        return;
      }

      const stream = new MediaStream(
        streams.flatMap((source) => source.getTracks()),
      );
      stream.getAudioTracks().forEach((track) => {
        track.enabled = micEnabledRef.current;
      });
      stream.getVideoTracks().forEach((track) => {
        track.enabled = cameraEnabledRef.current;
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      await loadDevices().catch((error) =>
        console.warn("Could not list media devices:", error),
      );
      setPermissionError(
        !hasMicrophone
          ? "Microphone access is blocked. Camera is ready."
          : !hasCamera
            ? "Camera access is blocked. Microphone is ready."
            : "",
      );
      setPermission("ready");
    },
    [loadDevices, releasePreview],
  );

  useEffect(() => {
    void Promise.resolve().then(() => startPreview());
    return stopPreview;
  }, [startPreview, stopPreview]);

  function toggleMicrophone() {
    const enabled = !microphoneEnabled;
    setMicrophoneEnabled(enabled);
    micEnabledRef.current = enabled;
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = enabled;
    });
  }

  function toggleCamera() {
    const enabled = !cameraEnabled;
    setCameraEnabled(enabled);
    cameraEnabledRef.current = enabled;
    streamRef.current?.getVideoTracks().forEach((track) => {
      track.enabled = enabled;
    });
  }

  async function uploadFile(file: File) {
    setUploadingDoc(true);
    setDocError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Upload failed");
      const doc: PreJoinDocument = {
        id: data.id,
        name: data.name,
        size: file.size,
      };
      setAvailableDocs((prev) => [...prev, doc]);
      setSelectedDoc(doc);
    } catch (error) {
      setDocError(
        error instanceof Error ? error.message : "Upload failed. Try again.",
      );
    } finally {
      setUploadingDoc(false);
    }
  }

  function join() {
    stopPreview();
    onJoin(
      {
        microphoneEnabled,
        cameraEnabled,
        microphoneDeviceId: microphoneDeviceId || undefined,
        cameraDeviceId: cameraDeviceId || undefined,
        speakerDeviceId: speakerDeviceId || undefined,
      },
      selectedDoc?.id,
    );
  }

  const permissionReady = permission === "ready";
  const userInitials =
    userName
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "U";

  return (
    <main className="min-h-svh bg-[#fafafa] text-[#202124]">
      <header className="flex h-20 items-center justify-between px-5 sm:px-8 lg:px-10">
        <div className="flex min-w-0 items-center gap-3">
          {organizationLogo ? (
            <Image
              src={organizationLogo}
              alt={`${organizationName} logo`}
              width={40}
              height={40}
              className="size-10 rounded-lg object-contain"
              unoptimized
              priority
            />
          ) : (
            <span className="grid size-10 place-items-center rounded-lg bg-white">
              <Image
                src="/trainertwin-mark.svg"
                alt="TrainerTwin"
                width={25}
                height={19}
                priority
              />
            </span>
          )}
          <span className="truncate text-lg font-semibold tracking-[-0.02em] text-[#303134]">
            {organizationLogo ? organizationName : "TrainerTwin"}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <div className="hidden min-w-0 text-right sm:block">
            <p className="max-w-56 truncate text-sm font-medium text-[#303134]">
              {userName}
            </p>
            <p className="text-xs text-[#5f6368]">Signed in</p>
          </div>
          <Avatar size="lg" className="after:border-brand/15">
            <AvatarFallback className="bg-brand font-semibold text-white">
              {userInitials}
            </AvatarFallback>
          </Avatar>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-[1240px] gap-5 px-5 pb-24 pt-8 sm:px-8 lg:h-[calc(100vh-5rem)] lg:content-center lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)] lg:grid-rows-[auto_auto] lg:items-start lg:gap-x-16 lg:gap-y-5 lg:py-0">
        <section
          className={cn(
            "flex flex-col items-center text-center lg:col-start-2 lg:row-start-1 lg:self-start lg:items-start lg:text-left",
            contextRequired ? "lg:mt-8" : "lg:translate-y-20",
          )}
        >
          <h1 className="max-w-md text-balance text-3xl font-semibold leading-[1.12] tracking-[-0.035em] text-[#202124] sm:text-4xl lg:text-[2.5rem]">
            {scenarioName}
          </h1>
          <p className="mt-5 max-w-sm text-pretty text-base leading-7 text-[#5f6368]">
            Check your camera and microphone, then join when you’re ready.
          </p>
        </section>

        <section
          aria-label="Camera and microphone preview"
          className="min-w-0 lg:col-start-1 lg:row-start-1"
        >
          <div className="relative aspect-video overflow-hidden rounded-[1.25rem] bg-[#202124] shadow-[0_18px_48px_rgba(32,33,36,0.18)]">
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className={cn(
                "absolute inset-0 size-full scale-x-[-1] object-cover transition-opacity duration-200",
                cameraEnabled && permissionReady ? "opacity-100" : "opacity-0",
              )}
            />

            {permission === "requesting" ? (
              <div className="absolute inset-0 grid place-items-center text-white">
                <div className="flex items-center gap-2 text-sm">
                  <LoaderCircle className="size-5 animate-spin" /> Checking
                  camera and microphone…
                </div>
              </div>
            ) : !cameraEnabled || !permissionReady ? (
              <div className="absolute inset-0 grid place-items-center px-8 text-center text-white">
                <div>
                  <VideoOff
                    className="mx-auto mb-3 size-7 text-white/70"
                    aria-hidden="true"
                  />
                  <p className="text-xl font-normal">Camera is off</p>
                  {permissionError ? (
                    <p className="mt-2 text-sm text-white/65">
                      {permissionError}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className="absolute inset-x-0 bottom-5 z-20 flex justify-center gap-3">
              <button
                type="button"
                onClick={toggleMicrophone}
                disabled={!permissionReady || !microphoneAvailable}
                aria-label={
                  microphoneEnabled
                    ? "Turn off microphone"
                    : "Turn on microphone"
                }
                aria-pressed={microphoneEnabled}
                className={cn(
                  "grid size-14 place-items-center rounded-full text-white shadow-[0_5px_16px_rgba(0,0,0,0.3)] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-45",
                  microphoneEnabled
                    ? "bg-[#3c4043] hover:bg-[#4b4f52]"
                    : "bg-[#d93025] hover:bg-[#c5221f]",
                )}
              >
                {microphoneEnabled ? (
                  <Mic className="size-5" />
                ) : (
                  <MicOff className="size-5" />
                )}
              </button>
              <button
                type="button"
                onClick={toggleCamera}
                disabled={!permissionReady || !cameraAvailable}
                aria-label={
                  cameraEnabled ? "Turn off camera" : "Turn on camera"
                }
                aria-pressed={cameraEnabled}
                className={cn(
                  "grid size-14 place-items-center rounded-full text-white shadow-[0_5px_16px_rgba(0,0,0,0.3)] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-45",
                  cameraEnabled
                    ? "bg-[#3c4043] hover:bg-[#4b4f52]"
                    : "bg-[#d93025] hover:bg-[#c5221f]",
                )}
              >
                {cameraEnabled ? (
                  <Video className="size-5" />
                ) : (
                  <VideoOff className="size-5" />
                )}
              </button>
            </div>
          </div>
        </section>

        <section
          aria-label="Microphone and camera selection"
          className="min-w-0 lg:col-start-1 lg:row-start-2"
        >
          {permission === "denied" || permission === "unsupported" ? (
            <button
              type="button"
              onClick={() => void startPreview()}
              className="mx-auto mt-4 flex items-center gap-2 rounded-full border border-[#dadce0] bg-white px-4 py-2 text-sm font-medium text-[#3c4043] transition-colors hover:bg-[#f1f3f4] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              <RotateCcw className="size-4" /> Try device check again
            </button>
          ) : (
            <div className="grid gap-2 sm:grid-cols-3">
              <DeviceSelect
                label="Microphone"
                icon={<Mic className="size-4" />}
                value={microphoneDeviceId}
                options={microphones}
                fallback="Default microphone"
                onChange={(value) => {
                  setMicrophoneDeviceId(value);
                  void startPreview(value, cameraDeviceId || undefined);
                }}
              />
              <DeviceSelect
                label="Speaker"
                icon={<Volume2 className="size-4" />}
                value={speakerDeviceId}
                options={speakers}
                fallback="System default"
                onChange={setSpeakerDeviceId}
              />
              <DeviceSelect
                label="Camera"
                icon={<Camera className="size-4" />}
                value={cameraDeviceId}
                options={cameras}
                fallback="Default camera"
                onChange={(value) => {
                  setCameraDeviceId(value);
                  void startPreview(microphoneDeviceId || undefined, value);
                }}
              />
            </div>
          )}
        </section>

        {contextRequired && (
          <section
            aria-label="Context document"
            className="min-w-0 rounded-xl border border-[#e4e6e8] bg-white p-4 shadow-[0_8px_24px_rgba(32,33,36,0.08)] lg:col-start-2 lg:row-start-1 lg:mt-56 lg:self-start"
          >
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-sm font-medium text-[#202124]">
                Context document
              </span>
              {contextRequired ? (
                <span className="text-xs font-medium text-amber-700">
                  Required
                </span>
              ) : (
                <span className="text-xs text-[#5f6368]">Optional</span>
              )}
            </div>
            {selectedDoc ? (
              <div className="flex items-center gap-3 rounded-xl border-2 border-gray-100 bg-white px-4 py-3 text-left">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand">
                  <FileUp className="size-4.5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-[#202124]">
                    {selectedDoc.name}
                  </p>
                  {typeof selectedDoc.size === "number" ? (
                    <p className="text-xs text-[#5f6368]">
                      {formatBytes(selectedDoc.size)}
                    </p>
                  ) : null}
                </div>

                <button
                  type="button"
                  onClick={() => setSelectedDoc(null)}
                  aria-label={`Remove ${selectedDoc.name}`}
                  className="cursor-pointer grid size-7 shrink-0 place-items-center rounded-full text-[#5f6368] transition-colors hover:bg-red-100 hover:text-[#202124] focus-visible:outline-2 focus-visible:outline-offset-2 "
                >
                  <Trash className="size-4 text-red-500" aria-hidden="true" />
                </button>
              </div>
            ) : (
              <div
                onDragEnter={(event) => {
                  event.preventDefault();
                  dragCounterRef.current += 1;
                  setDragOver(true);
                }}
                onDragLeave={(event) => {
                  event.preventDefault();
                  dragCounterRef.current -= 1;
                  if (dragCounterRef.current === 0) setDragOver(false);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  dragCounterRef.current = 0;
                  setDragOver(false);
                  const file = event.dataTransfer.files?.[0];
                  if (file) void uploadFile(file);
                }}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                role="button"
                tabIndex={0}
                aria-label="Upload context document"
                className={cn(
                  "flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed px-5 py-4 text-center transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
                  dragOver
                    ? "border-brand bg-brand/10"
                    : "border-[#c7c9cc] bg-[#fafafa] hover:border-brand hover:bg-brand/5",
                )}
              >
                {uploadingDoc ? (
                  <>
                    <LoaderCircle
                      className="size-5 animate-spin text-brand"
                      aria-hidden="true"
                    />
                    <p className="text-sm font-medium text-[#202124]">
                      Uploading…
                    </p>
                  </>
                ) : (
                  <>
                    <FileUp
                      className={cn(
                        "size-5",
                        dragOver ? "text-brand" : "text-[#5f6368]",
                      )}
                      aria-hidden="true"
                    />
                    <p className="text-sm font-medium text-[#202124]">
                      <span className="text-brand underline-offset-2">
                        Upload
                      </span>{" "}
                      or drag your document here
                    </p>
                    <p className="text-xs text-[#5f6368]">
                      PDF, Word, slides, images, and text files
                    </p>
                  </>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={CONTEXT_ACCEPT}
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.currentTarget.value = "";
                    if (file) void uploadFile(file);
                  }}
                />
              </div>
            )}

            {docError ? (
              <p role="alert" className="mt-2 text-sm text-[#b3261e]">
                {docError}
              </p>
            ) : null}

            {!selectedDoc && availableDocs.length > 0 ? (
              <div className="relative mt-2.5">
                <span
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[#5f6368]"
                  aria-hidden="true"
                >
                  <FileUp className="size-4" />
                </span>
                <select
                  value=""
                  onChange={(event) => {
                    const doc = availableDocs.find(
                      (candidate) => candidate.id === event.target.value,
                    );
                    setSelectedDoc(doc ?? null);
                  }}
                  aria-label="Choose a previously uploaded document"
                  className="h-10 w-full appearance-none truncate rounded-full border border-[#dadce0] bg-white pl-10 pr-9 text-sm text-[#3c4043] shadow-[0_1px_2px_rgba(60,64,67,0.08)] outline-none transition-colors focus:border-brand focus:ring-1 focus:ring-brand/30"
                >
                  <option value="">Or choose a past upload</option>
                  {availableDocs.map((doc) => (
                    <option key={doc.id} value={doc.id}>
                      {doc.name}
                      {typeof doc.size === "number"
                        ? ` · ${formatBytes(doc.size)}`
                        : ""}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  className="pointer-events-none absolute right-3.5 top-1/2 size-3.5 -translate-y-1/2 text-[#5f6368]"
                  aria-hidden="true"
                />
              </div>
            ) : null}
          </section>
        )}

        <section
          className={cn(
            "flex flex-col items-center text-center lg:col-start-2 lg:items-start lg:text-left",
            contextRequired
              ? "lg:row-start-2"
              : "lg:row-start-1 lg:mb-10 lg:-translate-y-4 lg:self-end",
          )}
        >
          <Button
            type="button"
            onClick={join}
            disabled={
              permission === "requesting" || (contextRequired && !docAttached)
            }
            className="h-13 min-w-44 cursor-pointer items-center justify-center rounded-full bg-brand px-7 text-sm font-semibold text-white shadow-[0_7px_20px_color-mix(in_srgb,var(--brand)_24%,transparent)] hover:bg-brand-strong"
          >
            {permission === "requesting" ? "Checking devices…" : "Join now"}
          </Button>
          {permission === "ready" && permissionError ? (
            <p className="mt-4 max-w-xs text-sm leading-6 text-amber-700">
              {permissionError}
            </p>
          ) : permission === "denied" ? (
            <p className="mt-4 max-w-xs text-sm leading-6 text-[#b3261e]">
              You can still join with devices off, or update browser permissions
              and retry.
            </p>
          ) : null}
        </section>
      </div>

      <div className="fixed bottom-5 right-5 flex items-center gap-2 text-[11px] font-medium text-[#777b80] sm:bottom-7 sm:right-8">
        <span>Powered by</span>
        <Image src="/trainertwin-mark.svg" alt="" width={16} height={12} />
        <span className="text-[#4b4f52]">TrainerTwin</span>
      </div>
    </main>
  );
}

function DeviceSelect({
  label,
  icon,
  value,
  options,
  fallback,
  onChange,
}: {
  label: string;
  icon: ReactNode;
  value: string;
  options: DeviceOption[];
  fallback: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="relative flex min-w-0 items-center gap-2 rounded-full border border-[#dadce0] bg-white px-3 text-[#3c4043] shadow-[0_1px_2px_rgba(60,64,67,0.08)] transition-colors focus-within:border-brand focus-within:ring-1 focus-within:ring-brand/30 hover:bg-[#f8f9fa]">
      <span className="shrink-0" aria-hidden="true">
        {icon}
      </span>
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 min-w-0 flex-1 appearance-none truncate bg-transparent pr-5 text-sm outline-none"
      >
        {options.length === 0 ? <option value="">{fallback}</option> : null}
        {options.map((option) => (
          <option key={option.deviceId} value={option.deviceId}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3 size-3.5"
        aria-hidden="true"
      />
    </label>
  );
}
