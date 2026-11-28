"use client";

import Link from "next/link";
import { useState } from "react";
import { z } from "zod";
import { SessionTime } from "@/components/sessions/session-time";
import { scoreTone } from "@/components/roleplay/roleplay-session-item";
import { helpfulTone } from "@/components/twin/twin-session-item";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Progress, ProgressLabel } from "@/components/ui/progress";
import { UserAvatar } from "@/components/user-avatar";
import { dashRoute } from "@/lib/routes";
import { LibraryCards, PersonaCard, RoleplayCard, SessionCard, TwinCard } from "@/components/copilot/cards";

/**
 * What the copilot read, shown with the studio's own pieces (phase 3.1, plans/copilot-everywhere.md): under a finished
 * read step, the sessions, the usage or the team it looked at, each linking to its page. The copilot's answer stays
 * the words; these are the things it's talking about, one click from their pages.
 *
 * Outputs come from web/lib/copilot-reads.ts (already stripped of private fields there); each is checked against its
 * shape here and shows nothing when it doesn't match, so a changed or failed read falls back to the plain step line.
 */

const kind = z.enum(["twin", "roleplay", "bot"]);
const session = z.object({
  id: z.string(),
  kind,
  agent: z.object({ name: z.string(), slug: z.string() }),
  learner: z.string(),
  mode: z.enum(["chat", "voice"]).optional(),
  startedAt: z.string().nullable(),
  minutes: z.number().nullable(),
  // A list row says where the report is; a full read (session_read) carries the report itself in its place.
  report: z.union([z.enum(["ready", "generating", "none"]), z.record(z.string(), z.unknown())]),
  score: z.number().optional(),
  tags: z.array(z.string()).optional(),
  learnerRating: z.number().optional(),
});
type Session = z.infer<typeof session>;

const libraryItem = z.object({
  slug: z.string(),
  name: z.string(),
  kind: z.string(),
  version: z.number().optional(),
  description: z.string().nullable().optional(),
  archived: z.boolean().optional(),
});
const library = z.object({ items: z.array(libraryItem) });

const persona = z.object({ slug: z.string(), name: z.string(), own: z.boolean().optional() });

const SCHEMAS = {
  persona_list: z.object({ personas: z.array(persona) }),
  twin_list: library,
  roleplay_list: library,
  twin_read: libraryItem,
  roleplay_read: libraryItem,
  session_list: z.object({ days: z.number(), sessions: z.array(session), nextOffset: z.number().optional() }),
  session_read: session.extend({
    hasRecording: z.boolean().optional(),
    learnerFeedback: z.string().optional(),
    transcript: z.object({
      totalTurns: z.number(),
      fromTurn: z.number(),
      turns: z.array(z.object({ n: z.number(), speaker: z.string(), text: z.string() })),
    }).optional(),
  }),
  usage_read: z.object({
    days: z.number(),
    byAgent: z.array(z.object({ name: z.string(), kind: z.string(), minutes: z.number() })),
    byPerson: z.array(z.object({ name: z.string(), as: z.enum(["learner", "team", "visitor"]), minutes: z.number() })),
  }),
  calibration_list: z.object({
    calibrations: z.array(z.object({
      id: z.string(),
      sessionId: z.string(),
      twin: z.object({ name: z.string(), slug: z.string() }),
      by: z.string(),
      at: z.string().nullable(),
      answers: z.number(),
      offAnswers: z.number(),
      scored: z.boolean(),
    })),
    nextOffset: z.number().optional(),
  }),
  team_list: z.object({
    team: z.array(z.object({ name: z.string().nullable(), role: z.string(), disabled: z.boolean(), since: z.string().nullable() })),
  }),
};
type ViewName = keyof typeof SCHEMAS;

const hasView = (name: string): name is ViewName => name in SCHEMAS;

/** The view for a finished read, or null (no view for this tool, an error, or an answer of another shape). */
export function CopilotReadView({ name, output }: { name: string; output: unknown }) {
  if (!hasView(name)) return null;
  const parsed = SCHEMAS[name].safeParse(output);
  if (!parsed.success) return null;
  const data = parsed.data;
  switch (name) {
    case "session_list": {
      const list = data as z.infer<typeof SCHEMAS.session_list>;
      return list.sessions.length ? <SessionList sessions={list.sessions} more={list.nextOffset !== undefined} /> : null;
    }
    case "session_read":
      return <Frameless><SessionCard session={data as z.infer<typeof SCHEMAS.session_read>} /></Frameless>;
    case "twin_list":
    case "roleplay_list": {
      // The main twin first, as on Twin agents; then the rest in the studio's order.
      const items = (data as z.infer<typeof library>).items
        .filter((item) => !item.archived)
        .sort((a, b) => Number(b.kind === "main-twin") - Number(a.kind === "main-twin"));
      return items.length ? <Frameless><LibraryList items={items} kind={name === "twin_list" ? "twin" : "roleplay"} /></Frameless> : null;
    }
    case "persona_list": {
      const personas = (data as z.infer<typeof SCHEMAS.persona_list>).personas;
      return personas.length ? <Frameless><PersonaList personas={personas} /></Frameless> : null;
    }
    case "twin_read":
      return <Frameless><TwinCard item={data as z.infer<typeof libraryItem>} /></Frameless>;
    case "roleplay_read":
      return <Frameless><RoleplayCard item={data as z.infer<typeof libraryItem>} /></Frameless>;
    case "usage_read":
      return <UsageView usage={data as z.infer<typeof SCHEMAS.usage_read>} />;
    case "calibration_list": {
      const list = data as z.infer<typeof SCHEMAS.calibration_list>;
      return list.calibrations.length ? <CalibrationList calibrations={list.calibrations} /> : null;
    }
    case "team_list": {
      const list = data as z.infer<typeof SCHEMAS.team_list>;
      return list.team.length ? <TeamList team={list.team} /> : null;
    }
  }
}

/** Cards bring their own surface: they only need setting in under the step line, like the framed views. */
function Frameless({ children }: { children: React.ReactNode }) {
  return <div className="animate-copilot-chip mt-1 mb-2 ml-6">{children}</div>;
}

/** Twins or role plays the copilot listed: the first three as cards, the rest on request. */
function LibraryList({ items, kind }: { items: z.infer<typeof libraryItem>[]; kind: "twin" | "roleplay" }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 3);
  return <LibraryCards items={shown} kind={kind} more={items.length - shown.length} onMore={() => setAll(true)} />;
}

function PersonaList({ personas }: { personas: z.infer<typeof persona>[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? personas : personas.slice(0, 3);
  return (
    <div className="flex flex-col gap-2">
      {shown.map((p) => <PersonaCard key={p.slug} slug={p.slug} name={p.name} />)}
      {personas.length > shown.length ? (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="self-start rounded-full px-2 py-1 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          Show {personas.length - shown.length} more
        </button>
      ) : null}
    </div>
  );
}

/**
 * After an approved change: the thing that changed, as it is now (the page refresh after a write reloads the cards'
 * data too, components/copilot-chat.tsx). Keyed by the slug the tool was given, or the one a create returned.
 */
const TWIN_WRITES = new Set(["twin_update", "twin_settings_update"]);
const ROLEPLAY_WRITES = new Set(["roleplay_update", "roleplay_settings_update", "roleplay_tools_update", "roleplay_character_set", "roleplay_personas_set"]);
const PERSONA_WRITES = new Set(["persona_create", "persona_update"]);
const written = z.object({ slug: z.string().min(1), label: z.string().optional(), name: z.string().optional() });

export function CopilotChangeView({ name, input, output }: { name: string; input: unknown; output: unknown }) {
  if (!TWIN_WRITES.has(name) && !ROLEPLAY_WRITES.has(name) && !PERSONA_WRITES.has(name)) return null;
  // A refused or failed change shows no card: the step line already says what happened.
  if (!output || typeof output !== "object" || "error" in output || (output as { ok?: unknown }).ok === false) return null;
  const target = written.safeParse({ ...(input as object), ...(name === "persona_create" ? output : {}) });
  if (!target.success) return null;
  const { slug, label } = target.data;
  const title = label ?? target.data.name ?? slug;
  if (PERSONA_WRITES.has(name)) return <Frameless><PersonaCard slug={slug} name={title} /></Frameless>;
  const item = { slug, name: title, kind: TWIN_WRITES.has(name) ? "twin-skill" : "roleplay-builder" };
  return <Frameless>{TWIN_WRITES.has(name) ? <TwinCard item={item} /> : <RoleplayCard item={item} />}</Frameless>;
}

/** The frame every view sits in: the panel's own surface, set in from the step line it belongs to. */
function Frame({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <section aria-label={label} className="animate-copilot-chip mt-1 mb-2 ml-6 rounded-xl border bg-background px-3">
      {children}
    </section>
  );
}

const sessionHref = (s: { id: string; kind: Session["kind"] }) =>
  s.kind === "roleplay" ? dashRoute(`/roleplay/sessions/${s.id}`) : dashRoute(`/twin/sessions/${s.id}`);

const minutesText = (minutes: number | null) => (minutes === null ? null : `${Math.max(1, Math.round(minutes))} min`);

/** Score for a role play, the learner's rating for a twin: the same badges as the sessions pages. */
function SessionBadge({ session: s }: { session: Session }) {
  if (typeof s.score === "number") {
    return <Badge variant={scoreTone(s.score)}><span className="tabular-nums">Score {s.score}</span></Badge>;
  }
  if (typeof s.learnerRating === "number" && s.learnerRating > 0) {
    return <Badge variant={helpfulTone(s.learnerRating)}><span className="tabular-nums">Rated {s.learnerRating}/5</span></Badge>;
  }
  if (s.report === "generating") return <span className="text-xs text-muted-foreground">Preparing report…</span>;
  return null;
}

function SessionRow({ session: s }: { session: Session }) {
  const length = minutesText(s.minutes);
  return (
    <Item size="row" role="listitem" render={<Link href={sessionHref(s)} />}>
      <ItemMedia>
        <UserAvatar user={{ name: s.learner }} size="sm" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{s.learner}</ItemTitle>
        <ItemDescription>
          {s.kind === "bot" ? `${KIND_LABEL.bot}: ` : ""}{s.agent.name}
          {s.startedAt ? <> · <span className="whitespace-nowrap"><SessionTime iso={s.startedAt} /></span></> : null}
          {length ? <> · <span className="whitespace-nowrap">{length}</span></> : null}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <SessionBadge session={s} />
      </ItemActions>
    </Item>
  );
}

const FIRST = 4;

/** Sessions the copilot listed: the first few, the rest a click away, each opening its session page. */
function SessionList({ sessions, more }: { sessions: Session[]; more: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? sessions : sessions.slice(0, FIRST);
  const hidden = sessions.length - shown.length;
  return (
    <Frame label="Sessions the copilot read">
      <ItemGroup divided>
        {shown.map((s) => <SessionRow key={s.id} session={s} />)}
      </ItemGroup>
      {(hidden > 0 || (all && more)) && (
        <div className="flex items-center justify-between border-t py-1.5">
          {hidden > 0 ? (
            <Button variant="ghost" onClick={() => setAll(true)}>Show {hidden} more</Button>
          ) : (
            <span className="text-xs text-muted-foreground">More on the sessions page</span>
          )}
        </div>
      )}
    </Frame>
  );
}

const KIND_LABEL: Record<string, string> = { twin: "Twin", roleplay: "Role play", bot: "Website bot" };

/** Minutes as a share of the total: name, minutes, and a bar. */
function UsageRows({ rows, total }: { rows: { key: string; name: string; hint: string; minutes: number }[]; total: number }) {
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => (
        <li key={row.key}>
          <Progress value={total ? Math.round((row.minutes / total) * 100) : 0}>
            <ProgressLabel className="min-w-0 flex-1 basis-0 truncate font-normal">
              {row.name} <span className="text-muted-foreground">{row.hint}</span>
            </ProgressLabel>
            <span className="ml-auto shrink-0 text-sm text-muted-foreground tabular-nums">{row.minutes} min</span>
          </Progress>
        </li>
      ))}
    </ul>
  );
}

function UsageView({ usage }: { usage: z.infer<typeof SCHEMAS.usage_read> }) {
  const total = Math.round(usage.byAgent.reduce((sum, row) => sum + row.minutes, 0) * 10) / 10;
  if (!total) return null;
  return (
    <Frame label="Minutes the copilot read">
      <div className="flex items-baseline justify-between gap-3 pt-3">
        <span className="text-2xl font-semibold tabular-nums">{total} <span className="text-sm font-normal text-muted-foreground">min</span></span>
        <span className="text-xs text-muted-foreground">Last {usage.days} days</span>
      </div>
      <div className="flex flex-col gap-2 py-3">
        <h4 className="text-xs font-medium text-muted-foreground">By agent</h4>
        <UsageRows total={total} rows={usage.byAgent.map((row, i) => ({ key: `${row.name}-${i}`, name: row.name, hint: row.kind === "twin" ? "" : KIND_LABEL[row.kind] ?? "", minutes: row.minutes }))} />
      </div>
      {usage.byPerson.length ? (
        <div className="flex flex-col gap-2 border-t py-3">
          <h4 className="text-xs font-medium text-muted-foreground">By person</h4>
          <UsageRows total={total} rows={usage.byPerson.map((row, i) => ({ key: `${row.name}-${i}`, name: row.name, hint: row.as === "team" ? "Team" : "", minutes: row.minutes }))} />
        </div>
      ) : null}
    </Frame>
  );
}

function CalibrationList({ calibrations }: { calibrations: z.infer<typeof SCHEMAS.calibration_list>["calibrations"] }) {
  return (
    <Frame label="Calibrations the copilot read">
      <ItemGroup divided>
        {calibrations.slice(0, 6).map((c) => (
          <Item key={c.id} size="row" role="listitem" render={<Link href={dashRoute(`/twin/${c.twin.slug}/calibration/${c.id}`)} />}>
            <ItemContent>
              <ItemTitle>{c.twin.name}</ItemTitle>
              <ItemDescription>
                {c.by}
                {c.at ? <> · <SessionTime iso={c.at} /></> : null}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Badge variant={c.offAnswers ? "warning" : "success"}>
                <span className="tabular-nums">{c.offAnswers ? `${c.offAnswers} of ${c.answers} off` : `${c.answers} on point`}</span>
              </Badge>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    </Frame>
  );
}

const ROLE_LABEL: Record<string, string> = { admin: "Admin", team: "Team" };

function TeamList({ team }: { team: z.infer<typeof SCHEMAS.team_list>["team"] }) {
  return (
    <Frame label="The team">
      <ItemGroup divided>
        {team.map((member, index) => (
          <Item key={`${member.name}-${index}`} size="row" role="listitem" data-disabled={member.disabled || undefined}>
            <ItemMedia>
              <UserAvatar user={{ name: member.name ?? "?" }} size="sm" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{member.name ?? "Unnamed member"}</ItemTitle>
              {member.disabled ? <ItemDescription>Disabled</ItemDescription> : null}
            </ItemContent>
            <ItemActions>
              <Badge variant="secondary">{ROLE_LABEL[member.role] ?? member.role}</Badge>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    </Frame>
  );
}
