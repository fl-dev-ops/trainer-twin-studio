"use client";

import Link from "next/link";
import { ChevronDown, Play, Settings2, Share2, Sliders, Trash2, UserPlus } from "lucide-react";
import { SetupIcon } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * Twin Agents library, ported from the reference prototype
 * (`page--library page--twin-profile` + its card/quote/learners rules).
 * Static mock data for now; drills into /api/twin when the surface is wired.
 */

const LEARNER_FACES = ["/media/learner-1.png", "/media/learner-2.png", "/media/learner-3.png", "/media/learner-4.png"];

/** One learner avatar row: 28px faces overlapping by 8px, 2px surface ring, +N chip. */
function LearnerAvatars({ extra, offset = 0, className }: { extra: number; offset?: number; className?: string }) {
  return (
    <span className={cn("flex items-center", className)} aria-label="Learners who talk to your twin">
      {LEARNER_FACES.map((face, i) => (
        <img
          key={face}
          src={LEARNER_FACES[(i + offset) % LEARNER_FACES.length]}
          alt=""
          width={28}
          height={28}
          className={cn("size-7 shrink-0 rounded-full border-2 border-card object-cover", i > 0 && "-ml-2")}
        />
      ))}
      {extra > 0 && (
        <span
          className="-ml-2 grid size-7 place-items-center rounded-full border-2 border-card bg-[#e9e9e9] text-[11px] font-medium text-(--text-secondary) dark:bg-[#4a4a4a]"
        >
          +{extra}
        </span>
      )}
    </span>
  );
}

/** More-actions dots (reference 16px glyphs, three 1.15r circles). */
function DotsIcon() {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden>
      <circle cx="8" cy="3.25" r="1.15" fill="currentColor" />
      <circle cx="8" cy="8" r="1.15" fill="currentColor" />
      <circle cx="8" cy="12.75" r="1.15" fill="currentColor" />
    </svg>
  );
}

/** The "Twin for all use cases" card: video avatar + title + meta + learners. */
function TwinAllCard() {
  return (
    <article className="mt-4 flex items-center justify-between gap-4 rounded-[12px] border border-(--card-border) bg-card p-4 px-5 text-left shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)] transition-shadow hover:shadow-[0_2px_4px_rgb(30_28_25/0.07),0_8px_20px_rgb(30_28_25/0.11)]">
      <Link href="/twin/olga-twin" className="flex flex-1 items-center gap-4 min-w-0 outline-none">
        <video
          className="size-[86px] shrink-0 rounded-[20px] bg-(--tone-control) object-cover object-[center_18%]"
          src="/media/twin-listening.mp4"
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-[16px] font-semibold leading-6">Olga’s twin</h3>
          <p className="mt-0.5 flex items-center gap-1 text-sm leading-5 text-muted-foreground">
            Last updated 2 days ago
            <span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
              <ChevronDown className="size-3.5" />
            </span>
          </p>
          <LearnerAvatars extra={1} className="mt-2" />
        </div>
      </Link>

      <div className="shrink-0 ml-1">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label="More actions for Olga’s twin"
                className="grid size-8 place-items-center rounded-full bg-(--tone-control) text-(--foreground) hover:bg-(--border) transition-colors outline-none focus-visible:ring-2 focus-visible:ring-(--brand)"
              >
                <DotsIcon />
              </button>
            }
          />
          <DropdownMenuContent side="bottom" align="end" className="w-44">
            <DropdownMenuGroup>
              <DropdownMenuItem render={<Link href="/twin/olga-twin/edit" />}>
                <Settings2 className="size-4" />
                <span>Configure</span>
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/twin/olga-twin/calibration" />}>
                <Sliders className="size-4" />
                <span>Calibrate</span>
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/twin/olga-twin/assign" />}>
                <UserPlus className="size-4" />
                <span>Assign</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  if (typeof window !== "undefined") {
                    navigator.clipboard?.writeText(`${window.location.origin}/s/olga-twin`);
                  }
                }}
              >
                <Share2 className="size-4" />
                <span>Share</span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </article>
  );
}

/** Gradient banner art behind the quote bubble (reference rp-art--N palette). */
const GRADIENTS = [
  "bg-[linear-gradient(135deg,#a8c6ec_0%,#d2c3e8_50%,#f1c6d7_100%)]",
  "bg-[linear-gradient(135deg,#a8e0c9_0%,#bfe0e8_50%,#c7cdf2_100%)]",
  "bg-[linear-gradient(135deg,#f3cfa0_0%,#f0bcc7_50%,#ddb8ea_100%)]",
  "bg-[linear-gradient(135deg,#cbe3a8_0%,#bfe6cf_50%,#a8e0e0_100%)]",
  "bg-[linear-gradient(135deg,#f6d9a0_0%,#f2c2b0_50%,#ecb6cc_100%)]",
  "bg-[linear-gradient(135deg,#b8cdf0_0%,#c8c4ec_50%,#e0c0e8_100%)]",
  "bg-[linear-gradient(135deg,#f0e3a0_0%,#ecd0b0_50%,#e8bcc4_100%)]",
  "bg-[linear-gradient(135deg,#a0e4e0_0%,#b8d4ec_50%,#ccc8f0_100%)]",
  "bg-[linear-gradient(135deg,#f0c8a8_0%,#eec0d0_50%,#d8bce8_100%)]",
  "bg-[linear-gradient(135deg,#bcead0_0%,#c4e0e4_50%,#d4d0f0_100%)]",
];

type TwinBot = { title: string; quote: string; blurb: string };

/** "Twin agents for specific use cases" card: art + quote, body, learners + dots. */
function TwinBotCard({ bot, index }: { bot: TwinBot; index: number }) {
  return (
    <article className="flex flex-col overflow-visible rounded-[12px] border border-(--card-border) bg-card text-left shadow-[0_1px_2px_rgb(30_28_25/0.04)] transition-shadow hover:shadow-[0_2px_4px_rgb(30_28_25/0.07),0_8px_20px_rgb(30_28_25/0.11)]">
      {/* Top gradient banner with centered quote bubble (reference rp-art--twin + rp-quote) */}
      <Link href="/twin/offplan-process" className="block outline-none">
        <div
          className={cn(
            "relative flex min-h-[176px] items-center justify-center p-4 rounded-t-[12px]",
            GRADIENTS[index % GRADIENTS.length],
          )}
        >
          <div className="relative w-full rounded-[12px] bg-card p-3.5 shadow-[0_2px_8px_rgb(0_0_0/0.08)]">
            {/* Bottom shadow tab layer underneath bubble */}
            <span className="absolute left-3 right-3 top-full -mt-2 h-4 rounded-b-[12px] bg-[rgb(255_255_255/0.28)] dark:bg-[rgb(0_0_0/0.25)] -z-10" />
            <div className="flex items-center gap-3">
              <video
                className="size-10 shrink-0 rounded-full bg-(--tone-control) object-cover object-[center_22%]"
                src="/media/twin-listening.mp4"
                autoPlay
                muted
                loop
                playsInline
                preload="auto"
              />
              <span className="flex min-w-0 flex-col">
                <span className="text-[13px] leading-[18px] text-(--text-secondary) dark:text-[#c4c4c4]">
                  “{bot.quote}”
                </span>
              </span>
            </div>
          </div>
        </div>

        {/* Card Body */}
        <div className="flex flex-col gap-2 px-4 pt-3.5 pb-0">
          <span className="text-[15px] font-semibold leading-[22px] tracking-[-0.015em] text-(--foreground)">
            {bot.title}
          </span>
          <span className="text-[13px] leading-5 text-(--text-secondary)">{bot.blurb}</span>
        </div>
      </Link>

      {/* Card Footer */}
      <div className="mt-auto flex items-center justify-between gap-2 px-4 pt-4 pb-4">
        <LearnerAvatars extra={1} offset={index} />

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label={`Actions for ${bot.title}`}
                className="ml-auto grid size-8 place-items-center rounded-full text-(--foreground) hover:bg-(--tone-control) transition-colors outline-none focus-visible:ring-2 focus-visible:ring-(--brand)"
              >
                <DotsIcon />
              </button>
            }
          />
          <DropdownMenuContent side="bottom" align="end" className="w-44">
            <DropdownMenuGroup>
              <DropdownMenuItem render={<Link href="/twin/offplan-process/edit" />}>
                <Settings2 className="size-4" />
                <span>Configure</span>
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/twin/offplan-process/calibration" />}>
                <Sliders className="size-4" />
                <span>Calibrate</span>
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/dash/talk" />}>
                <Play className="size-4" />
                <span>Try as learner</span>
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/twin/offplan-process/assign" />}>
                <UserPlus className="size-4" />
                <span>Assign</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  if (typeof window !== "undefined") {
                    navigator.clipboard?.writeText(`${window.location.origin}/s/offplan-process`);
                  }
                }}
              >
                <Share2 className="size-4" />
                <span>Share</span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem className="text-destructive focus:text-destructive">
                <Trash2 className="size-4" />
                <span>Remove</span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </article>
  );
}

const MOCK_BOTS: TwinBot[] = [
  {
    title: "The off-plan sales process",
    quote: "I need a structure, step by step.",
    blurb: "First call, educational Zoom and presentation meeting. Every stage books the next one.",
  },
];

/** Full Twin Agents library page (beta `page--twin-profile`). */
export function TwinAgentsPage() {
  return (
    <div className="h-full w-full overflow-y-auto">
      {/* Reference .page.page--library: max-width 1024px centered, padding 20px top, 32px bottom. */}
      <div className="mx-auto w-full max-w-[1024px] px-4 md:px-0 pt-5 pb-16">
        <header className="flex min-h-10 items-center justify-between gap-4">
          <h1 className="m-0 flex items-center gap-2 text-[16px] font-semibold leading-[22px] tracking-[-0.015em]">
            <span className="grid size-7 place-items-center rounded-[8px] text-(--text-secondary)">
              <SetupIcon className="size-[18px]" />
            </span>
            Twin Agents
          </h1>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-2 rounded-full bg-(--brand) px-3.5 text-[13px] leading-5 font-medium text-white shadow-none transition-colors hover:bg-[#e04d00] dark:hover:bg-[#ff7e33]"
          >
            <svg viewBox="0 0 16 16" width={16} height={16} fill="none" aria-hidden>
              <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
            </svg>
            Create new
          </button>
        </header>

        <h2 className="mt-10 max-w-none text-[18px] font-semibold leading-6 tracking-[-0.015em]">Twin for all use cases</h2>
        <TwinAllCard />

        <h2 className="mt-8 max-w-none text-[18px] font-semibold leading-6 tracking-[-0.015em]">
          Twin agents for specific use cases
        </h2>
        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {MOCK_BOTS.map((bot, i) => (
            <TwinBotCard key={bot.title} bot={bot} index={i} />
          ))}
        </div>
      </div>
    </div>
  );
}
