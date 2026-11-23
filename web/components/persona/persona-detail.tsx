import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, Pencil } from "lucide-react";
import { CARD, PersonaPhoto, RoleChip } from "@/components/persona/persona-parts";
import type { PersonaView } from "@/lib/personas";
import { cn } from "@/lib/utils";
import { PageContainer } from "@/components/page-container";
import { dashRoute } from "@/lib/routes";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1.5 py-4 sm:grid-cols-[160px_minmax(0,1fr)] sm:gap-4">
      <p className="m-0 text-sm leading-body font-medium text-muted-foreground">{label}</p>
      <div className="min-w-0 text-sm leading-body">{children}</div>
    </div>
  );
}

/** One persona: who they are, their voice and photo, and the agents that use it. */
export function PersonaDetail({ item }: { item: PersonaView }) {
  const { persona } = item;
  const editHref = dashRoute(`/personas/${encodeURIComponent(item.slug)}/edit`);
  return (
    <PageContainer>
      <header className="flex min-h-10 items-center justify-between gap-4">
        <Link href={dashRoute("/personas")} className="inline-flex items-center gap-2 text-sm text-foreground transition-colors hover:text-muted-foreground">
          <ArrowLeft className="size-4" aria-hidden />
          Personas
        </Link>
        <Link
          href={editHref}
          className="inline-flex h-8 items-center gap-2 rounded-full border border-(--card-border) px-4 text-body-s font-medium transition-colors hover:bg-(--tone-control)"
        >
          <Pencil className="size-3.5" aria-hidden />
          Edit
        </Link>
      </header>

      <article className={cn(CARD, "relative mt-6 flex flex-col items-start gap-3 p-6")}>
        <PersonaPhoto name={persona.name} photoUrl={item.photoUrl} size="xl" />
        <div className="absolute top-4 right-4 flex gap-2">
          {item.isOwn ? <RoleChip className="bg-(--brand)/15 text-(--brand-strong) dark:text-(--brand)">Your persona</RoleChip> : null}
          {persona.role ? <RoleChip>{persona.role}</RoleChip> : null}
        </div>
        <h1 className="m-0 text-2xl leading-9 font-semibold tracking-title">{persona.name}</h1>
      </article>

      <article className={cn(CARD, "mt-4 divide-y divide-(--border) px-6 py-2")}>
        <Row label="Role">{persona.role ? <p className="m-0">{persona.role}</p> : <span className="text-muted-foreground">Not set · <Link href={editHref} className="text-foreground underline-offset-4 hover:underline">Add</Link></span>}</Row>
        <Row label="About">{persona.about ? <p className="m-0 whitespace-pre-line">{persona.about}</p> : <span className="text-muted-foreground">Not set</span>}</Row>
        <Row label="Voice">
          {item.voice ? <p className="m-0 font-medium">{item.voice.name}</p> : <MissingMedia href={editHref} text="No voice yet" />}
        </Row>
        <Row label="Photo">
          {item.photoUrl ? <p className="m-0">Photo added{item.hasVideo ? " · avatar video kept" : ""}</p>
            : <MissingMedia href={item.isOwn ? null : editHref} text="No photo yet" />}
        </Row>
        <Row label="Used by">
          {item.usedBy.length ? (
            <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Agents using this persona">
              {item.usedBy.map((agent) => <li key={agent.slug}>{agent.name} <span className="text-muted-foreground">· {agent.kind === "TWIN" ? "Twin" : "Role play"}</span></li>)}
            </ul>
          ) : <span className="text-muted-foreground">No agents yet</span>}
        </Row>
        {item.traits.length ? (
          <Row label="Earlier settings">
            <p className="m-0 mb-2 text-xs text-muted-foreground">Kept from the earlier editor and still used in sessions. The short form does not change them.</p>
            <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1">
              {item.traits.map((trait) => (
                <div key={trait.label} className="contents">
                  <dt className="text-muted-foreground">{trait.label}</dt>
                  <dd className="m-0">{trait.value}</dd>
                </div>
              ))}
            </dl>
          </Row>
        ) : null}
        {item.isOwn ? (
          <Row label="Recorded style">
            <p className="m-0">
              Built from your recordings.{" "}
              <Link href={dashRoute(`/personas/${encodeURIComponent(item.slug)}?view=spec`)} className="font-medium underline-offset-4 hover:underline">Recordings and style</Link>
            </p>
          </Row>
        ) : null}
      </article>
    </PageContainer>
  );
}

/** Missing media with where to add it: the editor, or Twin's brain for the trainer's own photo. */
function MissingMedia({ href, text }: { href: Route | null; text: string }) {
  return (
    <p className="m-0 text-muted-foreground">
      {text} · <Link href={href ?? dashRoute("/twin/brain")} className="text-foreground underline-offset-4 hover:underline">{href ? "Add" : "Set up on Twin’s brain"}</Link>
    </p>
  );
}
