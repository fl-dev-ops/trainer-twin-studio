"use client";

import Link from "next/link";
import { Mic } from "lucide-react";
import { api, useApi } from "@/lib/api";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { VoiceLibrary } from "@/components/voice-library";

export default function VoiceLibraryPage() {
  const { mine, samples } = useApi(["page.voices"], () => api.page.voices.query());

  return (
    <PageContainer>
      <PageHeader
        className="border-b pb-6"
        title="Voices"
        description="Use a built-in sample voice or clone your own for speech generation."
        actions={
          <Button render={<Link href="/voice/cloning" />} nativeButton={false}>
            <Mic data-icon="inline-start" /> Clone voice
          </Button>
        }
      />

      <VoiceLibrary mine={mine} samples={samples} />
    </PageContainer>
  );
}
