import Link from "next/link";
import { Mic } from "lucide-react";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getSessionOrg } from "@/lib/org";
import { Button } from "@/components/ui/button";
import { VoiceLibrary } from "@/components/voice-library";

export default async function VoiceLibraryPage() {
  const org = await getSessionOrg();
  if (!org) redirect("/auth/no-org");
  const voices = await db.voice.findMany({
    where: { OR: [{ orgId: org.id }, { orgId: null }] },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, kind: true, status: true, createdAt: true },
  });

  return (
    <main className="min-h-0 flex-1 overflow-auto p-5 sm:p-8">
      <div className="mx-auto max-w-4xl">
        <header className="flex items-center justify-between border-b pb-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Voices</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Use a built-in sample voice or clone your own for speech generation.
            </p>
          </div>
          <Button render={<Link href="/voice/cloning" />} nativeButton={false}>
            <Mic data-icon="inline-start" /> Clone voice
          </Button>
        </header>

        <VoiceLibrary
          mine={voices.filter((voice) => voice.kind === "cloned").map((voice) => ({ ...voice, createdAt: voice.createdAt.toISOString() }))}
          samples={voices.filter((voice) => voice.kind === "sample").map((voice) => ({ ...voice, createdAt: voice.createdAt.toISOString() }))}
        />
      </div>
    </main>
  );
}
