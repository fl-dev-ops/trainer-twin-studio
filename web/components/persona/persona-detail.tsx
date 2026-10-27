import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, Pencil } from "lucide-react";
import { CARD, PersonaPhoto, RoleChip, Tags } from "@/components/persona/persona-parts";
import { ANSWER_LENGTH, BEHAVIOURS, FORMALITY, INTERRUPTS, OPENING_STYLES, PACE, meaningOf, optionLabel } from "@/lib/persona";
import type { PersonaView } from "@/lib/personas";
import { cn } from "@/lib/utils";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1.5 py-4 sm:grid-cols-[160px_minmax(0,1fr)] sm:gap-4">
      <p className="m-0 text-sm leading-[22px] font-medium text-muted-foreground">{label}</p>
      <div className="min-w-0 text-sm leading-[22px]">{children}</div>
    </div>
  );
}

/** Option label with its meaning, e.g. "Formal · Polished and businesslike…". */
function Option({ options, value }: { options: readonly { value: string; label: string; meaning: string }[]; value: string }) {
  return (
    <p className="m-0">
      <span className="font-medium">{optionLabel(options, value)}</span>
      <span className="text-(--text-secondary)"> · {meaningOf(options, value)}</span>
    </p>
  );
}

/** One role-play persona: who they are, how they talk, and their voice and avatar. */
export function PersonaDetail({ item }: { item: PersonaView }) {
  const { persona } = item;
  const place = [persona.age, persona.basedIn].filter(Boolean).join(" · ");
  const editHref = `/personas/${encodeURIComponent(item.slug)}/edit`;
  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] px-4 pt-5 pb-16 md:px-0">
        <header className="flex min-h-10 items-center justify-between gap-4">
          <Link href="/personas" className="inline-flex items-center gap-2 text-sm text-foreground transition-colors hover:text-muted-foreground">
            <ArrowLeft className="size-4" aria-hidden />
            Personas
          </Link>
          <Link
            href={editHref}
            className="inline-flex h-8 items-center gap-2 rounded-full border border-(--card-border) px-4 text-[13px] font-medium transition-colors hover:bg-(--tone-control)"
          >
            <Pencil className="size-3.5" aria-hidden />
            Edit
          </Link>
        </header>

        <article className={cn(CARD, "relative mt-6 flex flex-col items-start gap-3 p-6")}>
          <PersonaPhoto name={persona.name} photoUrl={item.photoUrl} className="size-24 text-3xl" />
          <RoleChip className="absolute top-4 right-4">{persona.role}</RoleChip>
          <div>
            <h1 className="m-0 text-[28px] leading-9 font-semibold tracking-[-0.02em]">{persona.name}</h1>
            {place ? <p className="m-0 text-sm text-muted-foreground">{place}</p> : null}
          </div>
        </article>

        <article className={cn(CARD, "mt-4 divide-y divide-(--border) px-6 py-2")}>
          {persona.background ? <Row label="Background"><p className="m-0">{persona.background}</p></Row> : null}
          <Row label="Behaviour">
            {persona.behaviours.length ? (
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {persona.behaviours.map((b) => (
                  <li key={b}><span className="font-medium">{b}</span><span className="text-(--text-secondary)"> · {meaningOf(BEHAVIOURS.map((x) => ({ ...x, label: x.value })), b)}</span></li>
                ))}
              </ul>
            ) : <span className="text-muted-foreground">Not set</span>}
          </Row>
          <Row label="Opening style"><Option options={OPENING_STYLES} value={persona.openingStyle} /></Row>
          <Row label="Formality"><Option options={FORMALITY} value={persona.formality} /></Row>
          <Row label="Answer length"><Option options={ANSWER_LENGTH} value={persona.answerLength} /></Row>
          <Row label="Interrupts"><Option options={INTERRUPTS} value={persona.interrupts} /></Row>
          <Row label="Pauses and fillers">
            <p className="m-0">{[persona.pauses ? "Takes a beat before answering" : null, persona.fillers ? "Says “um”, “well”, “you know”" : null].filter(Boolean).join(" · ") || "Neither"}</p>
          </Row>
          {persona.phrases.length ? <Row label="Signature phrases"><Tags items={persona.phrases.map((p) => `“${p}”`)} /></Row> : null}
          {persona.howTheyTalk ? <Row label="In their words"><p className="m-0">{persona.howTheyTalk}</p></Row> : null}
          <Row label="Pace"><Option options={PACE} value={persona.pace} /></Row>
          <Row label="Voice">
            {item.voice ? <p className="m-0 font-medium">{item.voice.name}</p> : <MissingMedia href={editHref} text="No voice yet" />}
          </Row>
          <Row label="Avatar">
            {item.photoUrl || item.hasVideo ? (
              <p className="m-0">{[item.photoUrl ? "Photo" : null, item.hasVideo ? "Video" : null].filter(Boolean).join(" and ")} added</p>
            ) : <MissingMedia href={editHref} text="No photo or video yet" />}
          </Row>
        </article>
      </div>
    </div>
  );
}

function MissingMedia({ href, text }: { href: string; text: string }) {
  return (
    <p className="m-0 text-muted-foreground">
      {text} · <Link href={`${href}?tab=media`} className="text-foreground underline-offset-4 hover:underline">Add</Link>
    </p>
  );
}
