import Link from "next/link";
import { Mic } from "lucide-react";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getSessionOrg } from "@/lib/org";
import { dashLink } from "@/lib/tenant-link";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
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
      <PageContainer size="narrow">
        <PageHeader
          className="border-b pb-6"
          title="Voices"
          description="Use a built-in sample voice or clone your own for speech generation."
          actions={
            <Button render={<Link href={dashLink("/voice/cloning", org.basePath)} />} nativeButton={false}>
              <Mic data-icon="inline-start" /> Clone voice
            </Button>
          }
        />

        <VoiceLibrary
          mine={voices.filter((voice) => voice.kind === "cloned").map((voice) => ({ ...voice, createdAt: voice.createdAt.toISOString() }))}
          samples={voices.filter((voice) => voice.kind === "sample").map((voice) => ({ ...voice, createdAt: voice.createdAt.toISOString() }))}
        />
      </PageContainer>
    </main>
  );
}
