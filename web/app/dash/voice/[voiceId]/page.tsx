import { TtsPlayground } from "@/components/tts-playground";

export default async function VoicePlaygroundPage({
  params,
}: {
  params: Promise<{ voiceId: string }>;
}) {
  const { voiceId } = await params;
  return <TtsPlayground voiceId={voiceId} />;
}
