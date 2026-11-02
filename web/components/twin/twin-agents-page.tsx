"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ChevronDown, Play, Settings2, Share2, Sliders, Trash2, UserPlus } from "lucide-react";
import { SetupIcon } from "@/components/icons";
import { SessionTime } from "@/components/sessions/session-time";
import { ShareTwinDialog } from "@/components/twin/share-twin-dialog";
import { TwinFace } from "@/components/twin/twin-face";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { seedCopilot } from "@/lib/copilot-handoff";
import { DotsIcon, GRADIENTS, LearnerAvatars } from "@/components/library-card-parts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { TwinOutputs } from "@/lib/twin/trpc";
import { cn } from "@/lib/utils";
import { PageContainer } from "@/components/page-container";
import { PageHeader, SectionHeader } from "@/components/page-header";

/**
 * Twin Agents library, ported from the reference prototype
 * (`page--library page--twin-profile` + its card/quote/learners rules), on the twin tRPC data.
 */

type TwinCard = TwinOutputs["agents"]["list"]["twins"][number];

/** The "Twin for all use cases" card: video avatar + title + meta + learners. */
function TwinAllCard({ twin }: { twin: TwinCard }) {
  const [shareOpen, setShareOpen] = useState(false);
  return (
    <Card interactive className="mt-4 flex-row items-center justify-between gap-4 px-5 py-4 text-left">
      <Link href={`/twin/${twin.slug}`} className="flex flex-1 items-center gap-4 min-w-0 outline-none">
        <TwinFace face={twin.face} size="3xl" shape="rounded" />
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-page-title leading-6 font-semibold">{twin.name}</h3>
          <p className="mt-0.5 flex items-center gap-1 text-sm leading-5 text-muted-foreground">
            Last updated <SessionTime iso={twin.updatedAt} />
            <span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
              <ChevronDown className="size-3.5" />
            </span>
          </p>
          <LearnerAvatars learners={twin.learners} className="mt-2" />
        </div>
      </Link>

      <div className="shrink-0 ml-1">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="secondary" size="icon" aria-label={`More actions for ${twin.name}`} />}>
            <DotsIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="end" className="w-44">
            <DropdownMenuGroup>
              <DropdownMenuItem render={<Link href={`/twin/${twin.slug}/edit`} />}>
                <Settings2 />
                <span>Configure</span>
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href={`/twin/${twin.slug}/calibration`} />}>
                <Sliders />
                <span>Calibrate</span>
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href={`/twin/${twin.slug}/assign`} />}>
                <UserPlus />
                <span>Assign</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShareOpen(true)}>
                <Share2 />
                <span>Share</span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ShareTwinDialog open={shareOpen} onOpenChange={setShareOpen} slug={twin.slug} name={twin.name} allSkills={twin.allSkills} />
    </Card>
  );
}

/** "Twin agents for specific use cases" card: art + quote, body, learners + dots. */
function TwinBotCard({ bot, index }: { bot: TwinCard; index: number }) {
  const [shareOpen, setShareOpen] = useState(false);
  return (
    <Card interactive className="gap-0 overflow-visible py-0 text-left">
      {/* Top gradient banner with centered quote bubble (reference rp-art--twin + rp-quote) */}
      <Link href={`/twin/${bot.slug}`} className="block outline-none">
        <div
          className={cn(
            "relative flex min-h-[176px] items-center justify-center rounded-t-tt-md p-4",
            GRADIENTS[index % GRADIENTS.length],
          )}
        >
          <div className="relative w-full rounded-tt-md bg-card p-3.5 shadow-elevation-2">
            {/* Bottom shadow tab layer underneath bubble */}
            <span className="absolute top-full right-3 left-3 -z-10 -mt-2 h-4 rounded-b-tt-md bg-white/28 dark:bg-black/25" />
            <div className="flex items-center gap-3">
              <TwinFace face={bot.face} size="xl" />
              <span className="flex min-w-0 flex-col">
                <span
                  title={bot.quote ?? bot.description ?? bot.name}
                  className="line-clamp-2 text-body-s leading-body-s text-(--text-secondary)"
                >
                  {bot.quote ? `“${bot.quote}”` : bot.description ?? bot.name}
                </span>
              </span>
            </div>
          </div>
        </div>

        {/* Card Body */}
        <div className="flex flex-col gap-2 px-4 pt-3.5 pb-0">
          <span className="line-clamp-1 text-body leading-body font-semibold tracking-title text-foreground" title={bot.name}>
            {bot.name}
          </span>
          {bot.description ? (
            <span className="line-clamp-3 text-body-s leading-5 text-(--text-secondary)" title={bot.description}>
              {bot.description}
            </span>
          ) : null}
        </div>
      </Link>

      {/* Card Footer */}
      <div className="mt-auto flex items-center justify-between gap-2 px-4 pt-4 pb-4">
        <LearnerAvatars learners={bot.learners} />

        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="ml-auto" aria-label={`Actions for ${bot.name}`} />}>
            <DotsIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="end" className="w-44">
            <DropdownMenuGroup>
              <DropdownMenuItem render={<Link href={`/twin/${bot.slug}/edit`} />}>
                <Settings2 />
                <span>Configure</span>
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href={`/twin/${bot.slug}/calibration`} />}>
                <Sliders />
                <span>Calibrate</span>
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href={`/talk?agent=${encodeURIComponent(bot.slug)}`} />}>
                <Play />
                <span>Try as learner</span>
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href={`/twin/${bot.slug}/assign`} />}>
                <UserPlus />
                <span>Assign</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShareOpen(true)}>
                <Share2 />
                <span>Share</span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem variant="destructive">
                <Trash2 />
                <span>Remove</span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ShareTwinDialog open={shareOpen} onOpenChange={setShareOpen} slug={bot.slug} name={bot.name} allSkills={bot.allSkills} />
    </Card>
  );
}

/**
 * "Create new": a twin skill is built by the copilot from the trainer's knowledge-base sessions on request
 * (plans/twin-skill-ingest.md). The request is handed to the copilot chat, which shows the run until it publishes.
 */
function CreateSkillDialog({ personaSlug }: { personaSlug: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [what, setWhat] = useState("");
  // The copilot names its source folder after USER (lowercase letters, digits, dashes).
  const user = personaSlug?.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") ?? "";

  function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!personaSlug || !what.trim()) return;
    seedCopilot(
      `USER=${user}\nBuild a twin skill from my knowledge base: ${what.trim()}\nPublish it for persona ${personaSlug}.`,
    );
    router.push("/");
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="brand" />}>
        <svg viewBox="0 0 16 16" width={16} height={16} fill="none" aria-hidden>
          <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
        </svg>
        Create new
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create a twin skill</DialogTitle>
          <DialogDescription>
            {personaSlug
              ? "The copilot builds it from the sessions in your knowledge base, then it appears here. It takes a few minutes."
              : "Set up your own persona first (Personas), so the skill knows whose twin it belongs to."}
          </DialogDescription>
        </DialogHeader>
        {personaSlug ? (
          <form onSubmit={create} className="grid gap-3">
            <Textarea
              autoFocus
              value={what}
              onChange={(event) => setWhat(event.target.value)}
              placeholder="What should this skill cover? e.g. Handling an off-plan buyer who wants to wait for prices to drop"
              rows={4}
              maxLength={1000}
              aria-label="What should this skill cover?"
            />
            <DialogFooter>
              <Button type="submit" disabled={!what.trim()}>
                Create
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Full Twin Agents library page (beta `page--twin-profile`). */
export function TwinAgentsPage({ data, personaSlug = null }: { data: TwinOutputs["agents"]["list"]; personaSlug?: string | null }) {
  return (
    <PageContainer>
      <PageHeader icon={SetupIcon} title="Twin Agents" actions={<CreateSkillDialog personaSlug={personaSlug} />} />

      {/* Only when there's a main twin; otherwise the page starts with the skill twins. */}
      {data.twins.length ? (
        <>
          <SectionHeader title="Twin for all use cases" className="mt-10" />
          {data.twins.map((twin) => <TwinAllCard key={twin.slug} twin={twin} />)}
        </>
      ) : null}

      <SectionHeader title="Twin agents for specific use cases" className={data.twins.length ? "mt-8" : "mt-10"} />
      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data.skills.map((bot, i) => (
          <TwinBotCard key={bot.slug} bot={bot} index={i} />
        ))}
      </div>
    </PageContainer>
  );
}
