"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, Pencil, Play } from "lucide-react";
import { RoleplayMenu } from "@/components/roleplay/roleplay-library-page";
import { UserAvatar } from "@/components/user-avatar";
import type { RoleplayOutputs } from "@/lib/roleplay/trpc";
import { PageContainer } from "@/components/page-container";
import { dashRoute } from "@/lib/routes";

type Detail = RoleplayOutputs["scenarios"]["get"];

const heading = "m-0 text-overline font-semibold tracking-overline uppercase text-muted-foreground";
const pill = "ml-2 inline-flex items-center rounded-full border border-(--border) px-2.5 py-0.5 align-middle text-xs font-medium text-(--text-secondary) transition-colors hover:bg-(--sidebar)";
/** How many faces show before "+n". */
const FACES = 9;
const MEMBERS = 3;

/** Text cut at a character cap, with an inline "Show more" / "Show less" pill after the last word. */
function Expandable({ text, cap, className }: { text: string; cap: number; className?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > cap;
  const shown = !long || open ? text : `${text.slice(0, text.lastIndexOf(" ", cap) > cap * 0.6 ? text.lastIndexOf(" ", cap) : cap).trimEnd()}…`;
  return (
    <p className={className}>
      {shown}
      {long ? <button type="button" className={pill} onClick={() => setOpen(!open)}>{open ? "Show less" : "Show more"}</button> : null}
    </p>
  );
}

/** One fact row: a label on the left, top-aligned with its value. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-(--border) py-3.5 sm:flex-row sm:gap-6">
      <dt className="w-32 shrink-0 text-sm leading-6 text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0 flex-1 text-sm leading-6">{children}</dd>
    </div>
  );
}

const MEMBER_STATUS: Record<string, string> = { pending: "Not started", expired: "Expired", cancelled: "Removed" };

/** One role play: what it is (brief, learner, personas, goal), who it's assigned to, and its sessions. */
export function RoleplayDetailPage({ roleplay }: { roleplay: Detail }) {
  const [allFaces, setAllFaces] = useState(false);
  const [allMembers, setAllMembers] = useState(false);
  const personas = roleplay.personas.length ? roleplay.personas : [roleplay.client];
  const faces = allFaces ? personas : personas.slice(0, FACES);
  const goals = roleplay.goals.map((goal, i) => (roleplay.goals.length > 1 ? `${i + 1}. ${goal}` : goal)).join("\n");
  const members = allMembers ? roleplay.members : roleplay.members.slice(0, MEMBERS);

  return (
    <PageContainer>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-16">
        <section className="flex flex-col gap-6">
          <header className="flex min-h-10 items-center justify-between gap-4">
            <Link href={dashRoute("/roleplay")} className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-(--foreground)">
              <ArrowLeft className="size-4" />
              <span>Scenarios</span>
            </Link>
            <div className="flex items-center gap-2">
              <Link
                href={dashRoute(`/talk?agent=${encodeURIComponent(roleplay.slug)}`)}
                className="inline-flex h-8 items-center gap-2 rounded-full border border-(--border) px-4 text-body-s font-medium transition-colors hover:bg-(--sidebar)"
              >
                <Play className="size-3.5 fill-current" />
                <span>Try it</span>
              </Link>
              <Link
                href={dashRoute(`/roleplay/${roleplay.slug}/edit`)}
                className="inline-flex h-8 items-center gap-2 rounded-full bg-(--brand) px-4 text-body-s font-medium text-white transition-colors hover:bg-brand-hover"
              >
                <Pencil className="size-3.5" />
                <span>Edit</span>
              </Link>
              <RoleplayMenu slug={roleplay.slug} name={roleplay.name} trigger="header" />
            </div>
          </header>

          <h1 className="m-0 text-3xl leading-tight font-semibold tracking-title text-balance">{roleplay.name}</h1>
          {roleplay.learnerBrief ? (
            <Expandable text={roleplay.learnerBrief} cap={280} className="m-0 text-base leading-7 text-(--text-secondary)" />
          ) : null}

          <dl className="m-0 flex flex-col border-t border-(--border)">
            {roleplay.learnerRole ? <Fact label="Learner plays">{roleplay.learnerRole}</Fact> : null}
            <Fact label="Personas">
              {personas.length === 1 ? (
                <span className="flex items-center gap-3">
                  <UserAvatar user={{ name: personas[0].name, image: personas[0].photoUrl }} size="sm" />
                  <span>{personas[0].name}{personas[0].role ? <span className="text-muted-foreground"> · {personas[0].role}</span> : null}</span>
                </span>
              ) : (
                <span className="flex flex-wrap items-center gap-1.5">
                  {faces.map((persona) => (
                    <span key={persona.persona} title={persona.role ? `${persona.name} · ${persona.role}` : persona.name}>
                      <UserAvatar user={{ name: persona.name, image: persona.photoUrl }} size="sm" />
                    </span>
                  ))}
                  {personas.length > FACES ? (
                    <button type="button" className={pill} onClick={() => setAllFaces(!allFaces)}>{allFaces ? "Show less" : `+${personas.length - FACES}`}</button>
                  ) : null}
                </span>
              )}
            </Fact>
            {goals ? (
              <Fact label={roleplay.goals.length > 1 ? "Goals" : "Goal"}>
                <Expandable text={goals} cap={160} className="m-0 whitespace-pre-line" />
              </Fact>
            ) : null}
          </dl>
        </section>

        <section className="flex flex-col gap-4">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className={heading}>Members{roleplay.members.length ? ` · ${roleplay.members.length}` : ""}</h2>
            <Link href={dashRoute(`/roleplay/${roleplay.slug}/assign`)} className="text-sm font-medium text-(--brand) hover:underline">
              Assign learners
            </Link>
          </div>
          {roleplay.members.length ? (
            <ul className="m-0 flex list-none flex-col border-t border-(--border) p-0">
              {members.map((member) => (
                <li key={member.id} className="flex items-center gap-3 border-b border-(--border) py-3.5">
                  <UserAvatar user={{ name: member.name, image: member.image }} size="md" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium">{member.name}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {member.sessions ? `${member.sessions} ${member.sessions === 1 ? "session" : "sessions"}` : MEMBER_STATUS[member.status] ?? "Not started"}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 border-t border-(--border) pt-4 text-sm text-muted-foreground">Nobody is assigned yet.</p>
          )}
          {roleplay.members.length > MEMBERS ? (
            <button type="button" className="self-start text-sm text-muted-foreground hover:text-(--foreground)" onClick={() => setAllMembers(!allMembers)}>
              {allMembers ? "Show less" : `Show all ${roleplay.members.length}`}
            </button>
          ) : null}
        </section>

        <section className="flex flex-col gap-4">
          <h2 className={heading}>Sessions</h2>
          {roleplay.sessions.length ? (
            <ul className="m-0 flex list-none flex-col border-t border-(--border) p-0">
              {roleplay.sessions.map((session) => (
                <li key={session.id} className="border-b border-(--border)">
                  <Link href={session.href} className="flex flex-col gap-2 py-4 transition-colors hover:bg-(--sidebar)">
                    <span className="flex items-center gap-3">
                      <UserAvatar user={{ name: session.learner.name, image: session.learner.image }} size="md" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-medium">{session.learner.name}</span>
                        {session.persona ? <span className="truncate text-xs text-muted-foreground">with {session.persona}</span> : null}
                      </span>
                      <span className="shrink-0 text-sm font-semibold tabular-nums text-muted-foreground">{session.score ?? "—"}</span>
                    </span>
                    {session.summary ? <span className="line-clamp-2 pl-12 text-sm leading-6 text-(--text-secondary)">{session.summary}</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 border-t border-(--border) pt-4 text-sm text-muted-foreground">No sessions yet. Assign learners, or try it yourself.</p>
          )}
        </section>
      </div>
    </PageContainer>
  );
}
