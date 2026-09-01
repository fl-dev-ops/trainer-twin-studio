"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { dashLink, getClientBasePath } from "@/lib/tenant-link";
import { randomPassage } from "@/lib/voice-passage";
import { apiUrl } from "@/lib/api-url";
import { VoiceRecorder } from "@/components/voice-recorder";
export default function VoiceCloningPage() {
  const router = useRouter();
  const [passage, setPassage] = useState(randomPassage);
  const [uploading, setUploading] = useState(false);

  async function upload(wav: Blob) {
    setUploading(true);

    try {
      const form = new FormData();
      form.set("audio", new File([wav], "reference.wav", { type: "audio/wav" }));
      form.set("transcript", passage);
      const response = await fetch(apiUrl("/api/tts/voices"), { method: "POST", body: form });
      if (!response.ok) return toast.error((await response.json()).error ?? "Upload failed");
      const { voice } = await response.json();
      toast.success(`Voice "${voice.name}" created`);
      router.push(dashLink(`/voice/${voice.id}`, getClientBasePath()));
    } catch {
      toast.error("Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <main className="min-h-svh bg-muted p-2">
      <div className="min-h-[calc(100svh-1rem)] rounded-2xl bg-background">
        <header className="px-5 py-5 sm:px-9 sm:py-7">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 text-base font-medium"
            render={<Link href={dashLink("/voice", getClientBasePath())} />}
            nativeButton={false}
          >
            <ArrowLeft data-icon="inline-start" /> Voice cloning
          </Button>
        </header>

        <section className="mx-auto w-full max-w-3xl px-5 pt-[8vh] pb-12 sm:px-8">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">Read this out aloud</p>
            <Button
              variant="ghost"
              size="icon-sm"
              className="-mr-2 text-muted-foreground"
              aria-label="Try another text"
              title="Try another text"
              onClick={() => setPassage(randomPassage(passage))}
            >
              <RefreshCw />
            </Button>
          </div>
          <p className="mt-7 font-serif text-3xl leading-[1.16] tracking-tight sm:text-4xl">
            {passage}
          </p>

          <div className="mt-20">
            {uploading ? (
              <div className="grid min-h-72 place-items-center rounded-3xl bg-muted/40">
                <p className="text-sm text-muted-foreground">Saving your voice…</p>
              </div>
            ) : (
              <VoiceRecorder onFinished={upload} />
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
