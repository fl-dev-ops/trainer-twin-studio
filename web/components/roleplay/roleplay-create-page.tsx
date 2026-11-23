"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, Sparkles } from "lucide-react";
import { PersonaPicker } from "@/components/roleplay/roleplay-builder-page";
import { PageContainer } from "@/components/page-container";
import { Button } from "@/components/ui/button";
import { seedCopilot } from "@/lib/copilot-handoff";
import { encodeCopilotMessage } from "@/lib/copilot-message";
import type { RoleplayOutputs } from "@/lib/roleplay/trpc";
import { cn } from "@/lib/utils";

type Persona = RoleplayOutputs["builder"]["personas"][number];

const EXAMPLE = "e.g. A buyer who filled in a form after an Instagram ad. Skeptical, busy, a bit annoyed by agents. My agents have 4 minutes to find out what he needs and book a viewing.";

/** The copilot's request: the trainer's words, and the persona when one was picked. */
export function createRequest(what: string, persona: string | null) {
  return [
    "Write a role play from this, and publish it once I approve.",
    persona ? `Played by persona ${persona}.` : "Pick the persona that fits best.",
    "",
    what.trim(),
  ].join("\n");
}

/**
 * A new role play from one box (plans/roleplay-creator.md): the trainer describes it or pastes their requirements, the
 * copilot writes every part (client, learner, situation, the call, reactions, ending) and asks only for what's missing.
 */
export function RoleplayCreatePage({ personas }: { personas: Persona[] }) {
  const router = useRouter();
  const [what, setWhat] = useState("");
  const [persona, setPersona] = useState<string | null>(null);
  const [pickPersona, setPickPersona] = useState(false);
  const choices = personas.filter((p) => !p.isOwn);

  function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!what.trim()) return;
    seedCopilot(encodeCopilotMessage({ skill: "roleplay-creator", files: [], text: createRequest(what, persona) }));
    router.push("/");
  }

  return (
    <PageContainer>
      <header className="flex min-h-10 items-center">
        <Link href="/roleplay" className="inline-flex items-center gap-2 text-sm text-(--foreground) transition-colors hover:text-muted-foreground">
          <ArrowLeft className="size-4" />
          <span>Back</span>
        </Link>
      </header>

      <form onSubmit={create} className="mx-auto mt-10 flex w-full max-w-2xl flex-col gap-4">
        <div className="text-center">
          <h1 className="m-0 text-title-m leading-7 font-semibold tracking-title">New role play</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Describe the conversation your learners should practise, or paste your requirements. The copilot writes the rest and shows it to you before publishing.
          </p>
        </div>

        <div className="rounded-tt-lg border border-(--card-border) bg-card p-2 shadow-card focus-within:border-(--brand) focus-within:ring-1 focus-within:ring-(--brand)">
          <textarea
            aria-label="Describe the role play"
            autoFocus
            rows={7}
            value={what}
            placeholder={EXAMPLE}
            onChange={(e) => setWhat(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
            }}
            className="w-full resize-y bg-transparent p-3 text-sm leading-6 text-(--foreground) outline-none"
          />
          <div className="flex items-center justify-between gap-3 px-2 pb-1">
            <button
              type="button"
              onClick={() => setPickPersona((v) => !v)}
              className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              {persona ? `Played by ${choices.find((p) => p.slug === persona)?.name ?? persona}` : "Choose who plays it (optional)"}
            </button>
            <Button type="submit" variant="brand" disabled={!what.trim()}>
              <Sparkles data-icon="inline-start" /> Create
            </Button>
          </div>
        </div>

        {pickPersona ? (
          <div className={cn("flex flex-col gap-2")}>
            <PersonaPicker personas={choices} value={persona ?? ""} onChange={(slug) => setPersona(slug === persona ? null : slug)} />
            <p className="m-0 text-xs text-muted-foreground">Leave it empty and the copilot picks the persona that fits.</p>
          </div>
        ) : null}
      </form>
    </PageContainer>
  );
}
