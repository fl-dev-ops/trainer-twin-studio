"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Camera, Check, LoaderCircle, RotateCcw, Sparkles, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { twinClient } from "@/lib/twin/client";
import { cn } from "@/lib/utils";

const PHOTO_SIZE = 720;
const VERSIONS = 4; // one per HEADSHOT_STYLES look

/** An AI version of the photo: being made, ready (stored candidate + URL to show it), or failed. */
type Version = { state: "loading" } | { state: "ready"; key: string; url: string } | { state: "failed" };

/**
 * The twin's avatar (/twin/brain/avatar): take or upload a photo, then keep it or choose one of the AI versions made
 * from it (same face; clothes, light and background change). The voice (recorded on camera) is on /twin/brain/voice.
 */
export function TwinAvatarCapture({ personaName }: { personaName: string | null }) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [cameraError, setCameraError] = useState("");
  const [cameraReady, setCameraReady] = useState(false);
  const [photo, setPhoto] = useState<string | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  /** Which picture becomes the twin's: the photo as taken/uploaded, or an AI version (index). */
  const [choice, setChoice] = useState<"original" | number>("original");
  const [saving, setSaving] = useState(false);
  /** Bumped on every new photo, so versions of an earlier photo don't land on this one. */
  const photoRun = useRef(0);

  async function openCamera() {
    setCameraError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" } });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCameraReady(true);
    } catch {
      // Uploading still works without a camera.
      setCameraError("Camera access was blocked. Allow it in your browser to take a photo, or upload one.");
    }
  }

  useEffect(() => {
    void Promise.resolve().then(openCamera);
    return () => streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  /** The live preview is re-mounted after a retake: give it the stream each time. */
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
    choosePhoto(canvas.toDataURL("image/jpeg", 0.9));
  }

  /** An uploaded picture: centre square crop at the same size and format as a camera photo. */
  async function uploadPhoto(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) return void toast.error("Choose an image file.");
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const side = Math.min(image.naturalWidth, image.naturalHeight);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = PHOTO_SIZE;
      const context = canvas.getContext("2d");
      if (!context || !side) throw new Error("empty image");
      context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
      choosePhoto(canvas.toDataURL("image/jpeg", 0.9));
    } catch {
      toast.error("That image couldn't be opened. Try a JPEG or PNG.");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** A new photo: show it, and ask for the AI versions (each look in parallel, each tile fills in when ready). */
  function choosePhoto(dataUrl: string) {
    const run = ++photoRun.current;
    setPhoto(dataUrl);
    setChoice("original");
    setVersions(Array.from({ length: VERSIONS }, () => ({ state: "loading" })));
    for (let style = 0; style < VERSIONS; style++) {
      void twinClient.avatar.headshot
        .mutate({ photo: dataUrl, style })
        .then((made): Version => ({ state: "ready", ...made }))
        .catch((): Version => ({ state: "failed" }))
        .then((version) => {
          if (photoRun.current !== run) return;
          setVersions((prev) => prev.map((v, i) => (i === style ? version : v)));
        });
    }
  }

  function clearPhoto() {
    photoRun.current++;
    setPhoto(null);
    setVersions([]);
    setChoice("original");
  }

  async function save() {
    if (!photo) return;
    setSaving(true);
    try {
      const picked = typeof choice === "number" ? versions[choice] : null;
      await twinClient.avatar.save.mutate({ photo, headshotKey: picked?.state === "ready" ? picked.key : null });
      toast.success("Your avatar is saved.");
      router.push("/twin/brain");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save. Please try again.");
      setSaving(false);
    }
  }

  const picked = typeof choice === "number" ? versions[choice] : null;
  const shown = picked?.state === "ready" ? picked.url : photo;
  const making = versions.some((v) => v.state === "loading");

  return (
    <main className="min-h-svh bg-muted p-2">
      <div className="min-h-[calc(100svh-1rem)] rounded-2xl bg-background">
        <header className="flex items-center justify-between gap-4 px-5 py-5 sm:px-9 sm:py-7">
          <Button variant="ghost" size="sm" className="-ml-2 text-base font-medium" render={<Link href="/twin/brain" />} nativeButton={false}>
            <ArrowLeft data-icon="inline-start" /> Avatar
          </Button>
        </header>

        <section className="mx-auto flex w-full max-w-3xl flex-col items-center gap-8 px-5 pt-[4vh] pb-12 sm:px-8">
          {!personaName ? (
            <p className="text-sm text-muted-foreground">Set up your twin first: there is no persona of your own yet.</p>
          ) : (
            <>
              <div className="flex flex-col items-center gap-2 text-center">
                <h1 className="text-2xl font-semibold tracking-[-0.015em]">{photo ? "Choose your twin's picture" : "Take or upload a photo"}</h1>
                <p className="text-sm text-muted-foreground">
                  {photo
                    ? "Your photo, or one of the AI versions made from it: same face, only clothes, light and background change."
                    : "This becomes your twin's picture. Face the camera in good light, or upload one."}
                </p>
              </div>

              <div className="relative size-[min(420px,80vw)] overflow-hidden rounded-3xl bg-muted">
                {photo ? (
                  // eslint-disable-next-line @next/next/no-img-element -- local data URL / presigned candidate
                  <img src={shown ?? photo} alt="Your twin's picture" className="size-full object-cover" />
                ) : cameraError ? (
                  <p role="alert" className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted-foreground">{cameraError}</p>
                ) : (
                  <>
                    <video ref={attachPreview} autoPlay muted playsInline className="size-full -scale-x-100 object-cover" aria-label="Camera preview" />
                    {!cameraReady ? <p className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">Starting camera…</p> : null}
                  </>
                )}
              </div>

              {photo ? (
                <div role="radiogroup" aria-label="Your twin's picture" className="flex flex-wrap justify-center gap-3">
                  <PictureOption label="Your photo" selected={choice === "original"} onSelect={() => setChoice("original")}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- local data URL */}
                    <img src={photo} alt="" className="size-full object-cover" />
                  </PictureOption>
                  {versions.map((version, i) => (
                    <PictureOption key={i} label={`AI version ${i + 1}`} selected={choice === i} disabled={version.state !== "ready"} onSelect={() => setChoice(i)}>
                      {version.state === "ready" ? (
                        // eslint-disable-next-line @next/next/no-img-element -- presigned candidate
                        <img src={version.url} alt="" className="size-full object-cover" />
                      ) : version.state === "loading" ? (
                        <span className="grid size-full place-items-center bg-muted text-muted-foreground"><LoaderCircle className="size-5 animate-spin" /></span>
                      ) : (
                        <span className="grid size-full place-items-center bg-muted px-2 text-center text-[11px] text-muted-foreground">Couldn&apos;t make this one</span>
                      )}
                    </PictureOption>
                  ))}
                </div>
              ) : null}
              {making ? (
                <p className="-mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Sparkles className="size-3.5" /> Making AI versions of your photo… you can pick yours meanwhile.
                </p>
              ) : null}

              <div className="flex flex-wrap items-center justify-center gap-3">
                {photo ? (
                  <>
                    <Button variant="outline" className="rounded-full" disabled={saving} onClick={clearPhoto}>
                      <RotateCcw data-icon="inline-start" /> Retake
                    </Button>
                    <Button className="rounded-full" disabled={saving} onClick={() => void save()}>
                      {saving ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
                      {saving ? "Saving\u2026" : "Save"}
                    </Button>
                  </>
                ) : (
                  <>
                    <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(event) => { void uploadPhoto(event.target.files?.[0]); event.target.value = ""; }} />
                    <Button variant="outline" className="rounded-full" onClick={() => fileRef.current?.click()}>
                      <Upload data-icon="inline-start" /> Upload photo
                    </Button>
                    <Button className="rounded-full" disabled={!cameraReady} onClick={takePhoto}>
                      <Camera data-icon="inline-start" /> Take photo
                    </Button>
                  </>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}

/** One choice in the picture strip: a square thumbnail, outlined in the brand colour when chosen. */
function PictureOption({ label, selected, disabled = false, onSelect, children }: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "relative size-20 overflow-hidden rounded-2xl outline-none ring-offset-2 ring-offset-background transition focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default",
        selected ? "ring-2 ring-(--brand)" : "ring-1 ring-border hover:ring-foreground/30",
      )}
    >
      {children}
      {selected ? (
        <span className="absolute top-1 right-1 grid size-5 place-items-center rounded-full bg-(--brand) text-white"><Check className="size-3" /></span>
      ) : null}
    </button>
  );
}
