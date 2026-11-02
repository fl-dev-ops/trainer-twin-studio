import Link from "next/link";
import { PersonaIcon } from "@/components/icons";
import { CARD, ItemLabel, PersonaPhoto, RoleChip, Tags } from "@/components/persona/persona-parts";
import { speakingTags } from "@/lib/persona";
import type { PersonaView } from "@/lib/personas";
import { cn } from "@/lib/utils";
import { PageContainer } from "@/components/page-container";

/**
 * Persona Library: the characters learners practise with in role plays (photo, role, behaviour, how they talk, voice).
 * The trainer's own persona comes first ("You"): a role play can use them too, e.g. as the manager.
 */
export function PersonaLibrary({ personas }: { personas: PersonaView[] }) {
  const own = personas.filter((item) => item.isOwn);
  const others = personas.filter((item) => !item.isOwn);
  return (
    <PageContainer>
      <header className="flex min-h-10 items-center justify-between gap-4">
        <h1 className="m-0 flex items-center gap-2 text-page-title leading-page-title font-semibold tracking-title">
          <span className="grid size-7 place-items-center rounded-tt-sm text-(--text-secondary)">
            <PersonaIcon className="size-[18px]" />
          </span>
          Persona Library
        </h1>
        <Link
          href="/personas/new"
          className="inline-flex h-8 items-center gap-2 rounded-full bg-(--brand) px-3.5 text-body-s leading-5 font-medium text-white transition-colors hover:bg-brand-hover"
        >
          <svg viewBox="0 0 16 16" width={16} height={16} fill="none" aria-hidden>
            <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
          </svg>
          Create persona
        </Link>
      </header>

      {own.length ? (
        <section aria-labelledby="persona-you" className="mt-8">
          <h2 id="persona-you" className="m-0 text-section-title leading-6 font-semibold tracking-title">You</h2>
          <p className="mt-1 text-sm text-muted-foreground">Your own persona. A role play can use you as the manager, mentor or senior agent, with your photo and cloned voice.</p>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {own.map((item) => <PersonaCard key={item.slug} item={item} />)}
          </div>
        </section>
      ) : null}

      {others.length ? (
        <section aria-labelledby="persona-others" className="mt-8">
          {own.length ? <h2 id="persona-others" className="m-0 mb-4 text-section-title leading-6 font-semibold tracking-title">Clients and interviewers</h2> : null}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {others.map((item) => <PersonaCard key={item.slug} item={item} />)}
          </div>
        </section>
      ) : (
        <div className={cn(CARD, "mt-6 flex flex-col items-center gap-3 px-6 py-14 text-center")}>
          <p className="m-0 text-sm font-medium">No personas yet</p>
          <p className="m-0 text-sm text-muted-foreground">Create the first person your learners will talk to.</p>
          <Link href="/personas/new" className="mt-1 inline-flex h-8 items-center rounded-full border border-(--card-border) px-4 text-body-s font-medium hover:bg-(--tone-control)">
            Create persona
          </Link>
        </div>
      )}
    </PageContainer>
  );
}

/** A persona at a glance: name, background, behaviour and how they talk. The card opens the persona. */
function PersonaCard({ item }: { item: PersonaView }) {
  const { persona } = item;
  return (
    <article className={cn(CARD, "relative flex flex-col gap-4 p-5 transition-shadow hover:shadow-elevation-2")}>
      <Link
        href={`/personas/${encodeURIComponent(item.slug)}`}
        aria-label={`Open ${persona.name}`}
        className="absolute inset-0 rounded-tt-lg outline-none focus-visible:ring-2 focus-visible:ring-(--brand)"
      />
      <div className="flex items-center gap-3">
        <PersonaPhoto name={persona.name} photoUrl={item.photoUrl} size="md" />
        <div className="min-w-0 flex-1">
          <h2 className="m-0 truncate text-page-title leading-6 font-semibold tracking-title">{persona.name}</h2>
          <RoleChip className={cn("mt-0.5 inline-block", item.isOwn && "bg-(--brand)/15 text-(--brand-strong) dark:text-(--brand)")}>{item.isOwn ? "Your persona" : persona.role}</RoleChip>
        </div>
      </div>
      {persona.background ? <p className="m-0 line-clamp-2 text-sm leading-body text-(--text-secondary)">{persona.background}</p> : null}
      <div className="flex flex-col gap-1.5">
        <ItemLabel>Behaviour</ItemLabel>
        <Tags items={persona.behaviours.length ? persona.behaviours : ["Not set"]} />
      </div>
      <div className="flex flex-col gap-1.5">
        <ItemLabel>How they talk</ItemLabel>
        <Tags items={speakingTags(persona)} />
      </div>
    </article>
  );
}
