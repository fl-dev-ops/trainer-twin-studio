"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { VoiceCreateForm } from "@/components/voice-library";

export default function VoiceCloningPage() {
  const router = useRouter();

  return (
    <main className="min-h-svh bg-muted p-2">
      <div className="min-h-[calc(100svh-1.1rem)] rounded-2xl bg-background">
        <header className="px-5 py-5 sm:px-9 sm:py-7">
          <Link href="/voice" className="-ml-2 inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-base font-medium transition-colors hover:bg-muted [&_svg]:size-4">
            <ArrowLeft data-icon="inline-start" /> Voices
          </Link>
        </header>

        <section className="mx-auto w-full max-w-3xl px-5 pt-[8vh] pb-12 sm:px-8">
          <div className="mb-6">
            <h1 className="m-0 text-2xl font-semibold tracking-title">Add my voice</h1>
            <p className="mt-2 text-sm text-muted-foreground">Name your voice, then record a short passage or upload one recording.</p>
          </div>
          <VoiceCreateForm onCancel={() => router.push("/voice")} onSaved={() => router.push("/voice")} />
        </section>
      </div>
    </main>
  );
}
