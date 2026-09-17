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
  Check,
  ChevronDown,
  FileUp,
  LoaderCircle,
  Mic,
  MicOff,
  RotateCcw,
  Video,
  VideoOff,
  Volume2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "../ui/button";
import { FileThumbnail } from "@/components/extend/file-thumbnail";

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
  contexts: _contexts = [],
  contextRequired = false,
  contextPrompt,
  contextLabel,
  contextAccept,
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
  contextPrompt?: string;
  contextLabel?: string;
  contextAccept?: string;
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

  const [selectedDoc, setSelectedDoc] = useState<PreJoinDocument | null>(null);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
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

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

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
      setSelectedDoc(doc);
      setUploadedFile(file);
      if (file.type.startsWith("image/")) {
        setPreviewUrl(URL.createObjectURL(file));
      }
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

      <div className="mx-auto w-full max-w-5xl px-5 pb-24 pt-6 sm:px-8">
        <h1 className="mb-8 text-center text-2xl font-bold tracking-tight text-[#202124] sm:text-3xl">
          {scenarioName}
        </h1>

        <div
          className={cn(
            "grid gap-6 items-stretch",
            contextRequired ? "lg:grid-cols-2" : "max-w-xl mx-auto"
          )}
        >
          {/* Card 1: Camera and microphone preview */}
          <section
            aria-label="Camera and microphone preview"
            className="relative flex min-h-[340px] items-center justify-center overflow-hidden rounded-2xl bg-[#202124] shadow-[0_12px_32px_rgba(32,33,36,0.12)]"
          >
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
                  <p className="text-lg font-normal text-white">Camera is off</p>
                  {permissionError ? (
                    <p className="mt-2 text-sm text-white/65">
                      {permissionError}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className="absolute inset-x-0 bottom-4 z-20 flex justify-center gap-3">
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
                  "grid size-12 place-items-center rounded-full text-white shadow-[0_4px_12px_rgba(0,0,0,0.3)] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-45",
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
                  "grid size-12 place-items-center rounded-full text-white shadow-[0_4px_12px_rgba(0,0,0,0.3)] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-45",
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
          </section>

          {/* Card 2: Context Document */}
          {contextRequired && (
            <section
              aria-label={contextLabel || "Context document"}
              className="flex min-h-[340px] flex-col justify-between rounded-2xl border border-[#e4e6e8] bg-white p-6 shadow-sm"
            >
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-base font-semibold text-[#202124]">
                    {contextLabel || "Context document"}
                  </span>
                  {contextRequired ? (
                    <span className="text-xs font-semibold text-[#b45309]">
                      Required
                    </span>
                  ) : (
                    <span className="text-xs text-[#5f6368]">Optional</span>
                  )}
                </div>
                {contextPrompt ? (
                  <p className="mt-1 text-sm text-[#5f6368]">
                    {contextPrompt}
                  </p>
                ) : null}
              </div>

              {selectedDoc ? (
                <div className="my-auto flex items-center justify-center rounded-xl border border-[#e4e6e8] bg-[#fafafa] p-4">
                  <div className="flex w-full max-w-sm items-center gap-4">
                    <FileThumbnail
                      file={
                        uploadedFile ?? {
                          name: selectedDoc.name,
                          type: selectedDoc.name.endsWith(".pdf")
                            ? "application/pdf"
                            : "application/octet-stream",
                        }
                      }
                      previewImageUrl={previewUrl}
                      previewAspectRatio={3 / 4}
                      className="w-20 shrink-0 overflow-hidden rounded-lg border border-[#dadce0] bg-white shadow-xs"
                      previewContent={
                        !previewUrl ? (
                          <div className="flex size-full flex-col items-center justify-center bg-white p-2 text-center">
                            <span className="text-[11px] font-bold uppercase tracking-wider text-brand">
                              {selectedDoc.name.split(".").pop() || "DOC"}
                            </span>
                            <div className="mt-1.5 w-full space-y-1">
                              <div className="h-1 w-full rounded-full bg-muted-foreground/20" />
                              <div className="h-1 w-3/4 rounded-full bg-muted-foreground/20" />
                              <div className="h-1 w-5/6 rounded-full bg-muted-foreground/20" />
                            </div>
                          </div>
                        ) : undefined
                      }
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-[#202124]">
                        {selectedDoc.name}
                      </p>
                      {typeof selectedDoc.size === "number" ? (
                        <p className="mt-0.5 text-xs text-[#5f6368]">
                          {formatBytes(selectedDoc.size)}
                        </p>
                      ) : null}
                      <div className="mt-2.5 flex items-center gap-3">
                        <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-600">
                          <Check className="size-3" /> Attached
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            if (previewUrl) URL.revokeObjectURL(previewUrl);
                            setSelectedDoc(null);
                            setPreviewUrl(null);
                            setUploadedFile(null);
                          }}
                          className="cursor-pointer text-xs font-medium text-red-600 hover:text-red-700 hover:underline"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  </div>
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
                    "my-auto flex flex-1 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed px-6 py-8 text-center transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
                    dragOver
                      ? "border-brand bg-brand/10"
                      : "border-[#c7c9cc] bg-[#fafafa] hover:border-brand hover:bg-brand/5",
                  )}
                >
                  {uploadingDoc ? (
                    <>
                      <LoaderCircle
                        className="size-6 animate-spin text-brand"
                        aria-hidden="true"
                      />
                      <p className="mt-2 text-sm font-medium text-[#202124]">
                        Uploading…
                      </p>
                    </>
                  ) : (
                    <>
                      <FileUp
                        className={cn(
                          "size-6",
                          dragOver ? "text-brand" : "text-[#5f6368]",
                        )}
                        aria-hidden="true"
                      />
                      <p className="mt-2 text-sm text-[#202124]">
                        <span className="font-semibold text-brand underline underline-offset-2">
                          Upload
                        </span>{" "}
                        or drag your {contextLabel ? contextLabel.toLowerCase() : "document"} here
                      </p>
                      <p className="mt-1 text-xs text-[#5f6368]">
                        {contextAccept && contextAccept.includes(".pdf") && !contextAccept.includes(".png")
                          ? "PDF, Word, or text files (.pdf preferred)"
                          : "PDF, Word, slides, images, and text files"}
                      </p>
                    </>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={contextAccept || CONTEXT_ACCEPT}
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
                <p role="alert" className="mt-2 text-xs text-[#b3261e]">
                  {docError}
                </p>
              ) : null}
            </section>
          )}
        </div>

        {/* Device selects centered below cards */}
        <section
          aria-label="Microphone and camera selection"
          className="mt-8 flex flex-wrap items-center justify-center gap-3"
        >
          {permission === "denied" || permission === "unsupported" ? (
            <button
              type="button"
              onClick={() => void startPreview()}
              className="flex items-center gap-2 rounded-full border border-[#dadce0] bg-white px-4 py-2 text-sm font-medium text-[#3c4043] transition-colors hover:bg-[#f1f3f4] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              <RotateCcw className="size-4" /> Try device check again
            </button>
          ) : (
            <>
              <DeviceSelect
                label="Microphone"
                icon={<Mic className="size-4 text-[#5f6368]" />}
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
                icon={<Volume2 className="size-4 text-[#5f6368]" />}
                value={speakerDeviceId}
                options={speakers}
                fallback="System default"
                onChange={setSpeakerDeviceId}
              />
              <DeviceSelect
                label="Camera"
                icon={<Camera className="size-4 text-[#5f6368]" />}
                value={cameraDeviceId}
                options={cameras}
                fallback="Default camera"
                onChange={(value) => {
                  setCameraDeviceId(value);
                  void startPreview(microphoneDeviceId || undefined, value);
                }}
              />
            </>
          )}
        </section>

        {/* Join button centered below device selects */}
        <section className="mt-6 flex flex-col items-center justify-center">
          <Button
            type="button"
            onClick={join}
            disabled={
              permission === "requesting" || (contextRequired && !docAttached)
            }
            className="h-12 min-w-44 cursor-pointer items-center justify-center rounded-full bg-brand px-8 text-sm font-semibold text-white shadow-[0_7px_20px_color-mix(in_srgb,var(--brand)_24%,transparent)] hover:bg-brand-strong disabled:opacity-45 disabled:cursor-not-allowed"
          >
            {permission === "requesting" ? "Checking devices…" : "Join now"}
          </Button>
          {permission === "ready" && permissionError ? (
            <p className="mt-3 max-w-sm text-center text-xs leading-5 text-amber-700">
              {permissionError}
            </p>
          ) : permission === "denied" ? (
            <p className="mt-3 max-w-sm text-center text-xs leading-5 text-[#b3261e]">
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
    <label className="relative flex min-w-0 max-w-[260px] items-center gap-2 rounded-full border border-[#dadce0] bg-white px-3.5 text-[#3c4043] shadow-[0_1px_2px_rgba(60,64,67,0.06)] transition-colors focus-within:border-brand focus-within:ring-1 focus-within:ring-brand/30 hover:bg-[#f8f9fa]">
      <span className="shrink-0 text-[#5f6368]" aria-hidden="true">
        {icon}
      </span>
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 min-w-0 flex-1 appearance-none truncate bg-transparent pr-5 text-xs font-normal outline-none cursor-pointer"
      >
        {options.length === 0 ? <option value="">{fallback}</option> : null}
        {options.map((option) => (
          <option key={option.deviceId} value={option.deviceId}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3 size-3.5 text-[#5f6368]"
        aria-hidden="true"
      />
    </label>
  );
}
