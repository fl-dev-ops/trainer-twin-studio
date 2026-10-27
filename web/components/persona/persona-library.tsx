import Link from "next/link";
import { Pencil } from "lucide-react";
import { PersonaIcon } from "@/components/icons";
import { CARD, ItemLabel, PersonaPhoto, RoleChip, Tags } from "@/components/persona/persona-parts";
import { speakingTags } from "@/lib/persona";
import type { PersonaView } from "@/lib/personas";
import { cn } from "@/lib/utils";

/** Persona Library: the characters learners practise with in role plays (photo, role, behaviour, how they talk, voice). */
export function PersonaLibrary({ personas }: { personas: PersonaView[] }) {
  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1024px] px-4 pt-5 pb-16 md:px-0">
        <header className="flex min-h-10 items-center justify-between gap-4">
          <h1 className="m-0 flex items-center gap-2 text-[16px] leading-[22px] font-semibold tracking-[-0.015em]">
            <span className="grid size-7 place-items-center rounded-[8px] text-(--text-secondary)">
              <PersonaIcon className="size-[18px]" />
            </span>
            Persona Library
          </h1>
          <Link
            href="/personas/new"
            className="inline-flex h-8 items-center gap-2 rounded-full bg-(--brand) px-3.5 text-[13px] leading-5 font-medium text-white transition-colors hover:bg-[#e04d00] dark:hover:bg-[#ff7e33]"
          >
            <svg viewBox="0 0 16 16" width={16} height={16} fill="none" aria-hidden>
              <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
            </svg>
            Create persona
          </Link>
        </header>

        <p className="mt-6 max-w-[640px] text-sm leading-6 text-(--text-secondary)">
          <b className="font-semibold text-foreground">These are the people your learners practise with.</b> The AI plays them in role plays. Pick one for a role play, or create your own.
        </p>

        {personas.length ? (
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {personas.map((item) => <PersonaCard key={item.slug} item={item} />)}
          </div>
        ) : (
          <div className={cn(CARD, "mt-6 flex flex-col items-center gap-3 px-6 py-14 text-center")}>
            <p className="m-0 text-sm font-medium">No personas yet</p>
            <p className="m-0 text-sm text-muted-foreground">Create the first person your learners will talk to.</p>
            <Link href="/personas/new" className="mt-1 inline-flex h-8 items-center rounded-full border border-(--card-border) px-4 text-[13px] font-medium hover:bg-(--tone-control)">
              Create persona
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

function PersonaCard({ item }: { item: PersonaView }) {
  const { persona } = item;
  const place = [persona.age, persona.basedIn].filter(Boolean).join(" · ");
  return (
    <article className={cn(CARD, "relative flex flex-col gap-4 p-5 transition-shadow hover:shadow-[0_2px_4px_rgb(30_28_25/0.07),0_12px_28px_rgb(30_28_25/0.11)]")}>
      {/* The whole card opens the persona; the edit button sits above this link. */}
      <Link
        href={`/personas/${encodeURIComponent(item.slug)}`}
        aria-label={`Open ${persona.name}`}
        className="absolute inset-0 rounded-[16px] outline-none focus-visible:ring-2 focus-visible:ring-(--brand)"
      />
      <div className="flex items-start justify-between gap-3">
        <PersonaPhoto name={persona.name} photoUrl={item.photoUrl} className="size-[72px] text-2xl" />
        <RoleChip>{persona.role}</RoleChip>
      </div>
      <div>
        <h2 className="m-0 text-[20px] leading-7 font-semibold tracking-[-0.01em]">{persona.name}</h2>
        {place ? <p className="m-0 text-sm text-muted-foreground">{place}</p> : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <ItemLabel>Behaviour</ItemLabel>
        <Tags items={persona.behaviours.length ? persona.behaviours : ["Not set"]} />
      </div>
      <div className="flex flex-col gap-1.5">
        <ItemLabel>How they talk</ItemLabel>
        <Tags items={speakingTags(persona)} />
      </div>
      {persona.background ? (
        <div className="flex flex-col gap-1.5">
          <ItemLabel>Background</ItemLabel>
          <p className="m-0 line-clamp-3 text-sm leading-[22px] text-(--text-secondary)">{persona.background}</p>
        </div>
      ) : null}
      <div className="mt-auto flex items-center justify-between gap-3 pt-1">
        <span className="text-xs text-muted-foreground">{item.voice ? `Voice: ${item.voice.name}` : "No voice yet"}</span>
        <Link
          href={`/personas/${encodeURIComponent(item.slug)}/edit`}
          aria-label={`Edit ${persona.name}`}
          title="Edit persona"
          className="relative z-10 grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-(--tone-control) hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-(--brand)"
        >
          <Pencil className="size-4" aria-hidden />
        </Link>
      </div>
    </article>
  );
}
