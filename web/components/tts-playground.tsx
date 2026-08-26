"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Mic } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { generateSpeech } from "@/lib/audio-playback";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Voice = { id: string; name: string; kind: "sample" | "cloned"; status: string };

const SAMPLE_PROMPTS: Array<[string, string]> = [
  ["Project", "Tell me about a project you're really proud of, and walk me through the impact it had on your team or users."],
  ["Conflict", "Describe a time you disagreed with a teammate. How did you handle it, and what was the final outcome?"],
  ["Weakness", "What is your biggest weakness, and what concrete steps have you been taking to improve on it recently?"],
  ["Concept", "Pick one technical concept you know well and explain it to me in simple terms, as if I were new to it."],
];

export function TtsPlayground({ voiceId }: { voiceId: string }) {
  const [voices, setVoices] = useState<Voice[]>([]);
  const [selected, setSelected] = useState(voiceId);
  const [text, setText] = useState("");
  const [generating, setGenerating] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string>();
  const myVoices = voices.filter((voice) => voice.kind === "cloned");
  const sampleVoices = voices.filter((voice) => voice.kind === "sample");

  useEffect(() => () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  useEffect(() => {
    fetch("/api/tts/voices")
      .then((r) => r.json())
      .then((d) => setVoices(d.voices ?? []))
      .catch(() => toast.error("Could not load voices"));
  }, []);

  async function generateAudio() {
    if (!selected || !text.trim()) return;
    setGenerating(true);

    try {
      const response = await generateSpeech(selected, text, false);
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        throw new Error(detail?.error ?? `TTS failed (${response.status})`);
      }
      setAudioUrl(URL.createObjectURL(await response.blob()));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <main className="flex min-h-0 flex-1">
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b px-4 py-3 sm:px-6">
          <h1 className="text-sm font-semibold">
            {voices.find((voice) => voice.id === selected)?.name ?? "Text to Speech"}
          </h1>
          <Button variant="ghost" size="xs" render={<Link href="/voice" />} nativeButton={false}>
            All voices
          </Button>
        </header>
        <textarea
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
          placeholder="Enter your text here..."
          aria-label="Text to synthesize"
          className="min-h-0 flex-1 resize-none bg-background p-6 text-lg leading-relaxed outline-none placeholder:text-muted-foreground/60 sm:p-10"
        />
        <div className="px-4 pb-3 sm:px-6">
          <p className="mb-2 text-xs text-muted-foreground">Try out some examples</p>
          <div className="flex flex-wrap gap-2" aria-label="Sample prompts">
            {SAMPLE_PROMPTS.map(([label, prompt]) => (
              <button
                key={label}
                type="button"
                onClick={() => setText(prompt)}
                className="rounded-full border bg-muted/40 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-4 border-t px-4 py-3 sm:px-6">
          {audioUrl && <audio controls preload="metadata" src={audioUrl} className="h-10 min-w-0 flex-1" />}
          <Button onClick={generateAudio} disabled={!selected || generating || !text.trim()}>
            {generating ? "Generating…" : "Generate audio"}
          </Button>
        </div>
      </section>

      <aside className="hidden w-72 shrink-0 border-l p-5 lg:block">
        <div className="grid gap-5">
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="voice-picker">Voice</Label>
              <Button variant="ghost" size="xs" render={<Link href="/voice/cloning" />} nativeButton={false}>
                <Mic /> Clone new
              </Button>
            </div>
            <Select
              items={voices.map((voice) => ({ label: voice.name, value: voice.id }))}
              value={selected}
              onValueChange={(value) => value && setSelected(value)}
            >
              <SelectTrigger id="voice-picker" className="w-full">
                <SelectValue placeholder={voices.length ? "Pick a voice" : "No voices yet"} />
              </SelectTrigger>
              <SelectContent>
                {myVoices.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>My voices</SelectLabel>
                    {myVoices.map((voice) => (
                      <SelectItem key={voice.id} value={voice.id} className="capitalize">{voice.name}</SelectItem>
                    ))}
                  </SelectGroup>
                )}
                {myVoices.length > 0 && sampleVoices.length > 0 && <SelectSeparator />}
                {sampleVoices.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Sample voices</SelectLabel>
                    {sampleVoices.map((voice) => (
                      <SelectItem key={voice.id} value={voice.id} className="capitalize">{voice.name}</SelectItem>
                    ))}
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            Voices are cloned from a live recording of a fixed passage. Clone a new voice to hear
            your own text in it.
          </p>
        </div>
      </aside>
    </main>
  );
}
