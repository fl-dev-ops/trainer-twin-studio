import type { DashHref } from "@/lib/routes";
/**
 * The studio page a copilot message was sent from (plans/copilot-everywhere.md, "Page context"): its dash path and the
 * name a trainer would give it. Sent as a <page> tag (lib/copilot-message.ts) so "this", "here" and "these" resolve.
 * No imports: client code and tests use it.
 */

export type CopilotPage = { path: string; title: string };

/** The dash URL the browser shows: the proxy serves app/dash at dash.<base>/, but a direct /dash/... path still works. */
export function dashPath(pathname: string): string {
  const path = pathname.replace(/^\/dash(?=\/|$)/, "") || "/";
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

declare const copilotOffBrand: unique symbol;
/** A studio page the copilot stays off, by its folder in app/dash: "/twin/[id]/calibrate". Made with copilotOff. */
export type CopilotOffRoute = string & { readonly [copilotOffBrand]: true };

/**
 * Keep the copilot off a studio page: no button, no panel, no ⌘J. Written as the page's folder under app/dash and
 * checked against it by typed routes, so a moved or renamed page is a compile error, not a silent miss.
 *
 *   copilotOff("/twin/[id]/calibrate")   // ok
 *   copilotOff("/twin/[id]/calibrat")    // type error: app/dash has no such page
 */
export function copilotOff<Href extends string>(href: DashHref<Href>): CopilotOffRoute {
  return href as unknown as CopilotOffRoute;
}

/** Whether this URL is one of those pages: "[id]" matches one segment, "[...rest]" and "[[...rest]]" the rest. */
export function isCopilotOff(pathname: string, routes: readonly CopilotOffRoute[]): boolean {
  const path = dashPath(pathname).split("/").filter(Boolean);
  return routes.some((route) => {
    const pattern = route.split("/").filter(Boolean);
    for (let i = 0; i < pattern.length; i++) {
      const part = pattern[i];
      if (/^\[\[?\.\.\./.test(part)) return part.startsWith("[[") || path.length > i;
      if (i >= path.length) return false;
      if (!(part.startsWith("[") && part.endsWith("]")) && part !== decodeURIComponent(path[i])) return false;
    }
    return pattern.length === path.length;
  });
}

/**
 * Home: the full-page copilot, where the panel steps aside. (Full-screen flows never render the studio chrome at all,
 * components/app-shell.tsx, so the panel isn't there either.)
 */
export const isCopilotHome = (pathname: string) => dashPath(pathname) === "/";

/** Section names, as the sidebar says them (components/app-sidebar.tsx). The first matching pattern wins. */
const ROUTES: [RegExp, string][] = [
  [/^\/twin$/, "Twin agents"],
  [/^\/twin\/sessions$/, "Twin sessions"],
  [/^\/twin\/sessions\/[^/]+$/, "Twin session"],
  [/^\/twin\/users$/, "Twin users"],
  [/^\/twin\/(brain|knowledge)$/, "Twin’s brain"],
  [/^\/twin\/settings$/, "Twin settings"],
  [/^\/twin\/[^/]+\/assign$/, "Twin: assign learners"],
  [/^\/twin\/[^/]+\/edit$/, "Twin: configure"],
  [/^\/twin\/[^/]+$/, "Twin"],
  [/^\/knowledge\/[^/]+$/, "Knowledge file"],
  [/^\/bots$/, "Website bots"],
  [/^\/bots\/[^/]+$/, "Website bot"],
  [/^\/roleplay$/, "Scenarios"],
  [/^\/roleplay\/new$/, "New role play"],
  [/^\/roleplay\/sessions$/, "Role play sessions"],
  [/^\/roleplay\/sessions\/[^/]+$/, "Role play session"],
  [/^\/roleplay\/users$/, "Roleplay users"],
  [/^\/roleplay\/[^/]+\/assign$/, "Role play: assign learners"],
  [/^\/roleplay\/[^/]+\/edit$/, "Role play: edit"],
  [/^\/roleplay\/[^/]+$/, "Role play"],
  [/^\/personas$/, "Personas"],
  [/^\/personas\/new$/, "New persona"],
  [/^\/personas\/[^/]+(\/edit)?$/, "Persona"],
  [/^\/sessions$/, "Sessions"],
  [/^\/sessions\/[^/]+$/, "Session"],
  [/^\/users$/, "Users"],
  [/^\/users\/[^/]+$/, "User"],
  [/^\/voice$/, "Voices"],
  [/^\/voice\/[^/]+$/, "Voice"],
  [/^\/overview$/, "Overview"],
  [/^\/usage$/, "Usage"],
  [/^\/billing$/, "Billing"],
  [/^\/settings$/, "Settings"],
  [/^\/developer$/, "Developer API"],
];

/** The section a dash path belongs to ("Role play"), or null for home and unknown paths. */
export function sectionOf(pathname: string): string | null {
  const path = dashPath(pathname);
  return ROUTES.find(([pattern]) => pattern.test(path))?.[1] ?? null;
}

/**
 * The page as the trainer sees it: the section, plus the page's own heading when it names something more specific
 * ("Role play: Renewal call"). A heading that only repeats the section adds nothing.
 */
export function copilotPageOf(pathname: string, heading?: string | null): CopilotPage | null {
  if (isCopilotHome(pathname)) return null;
  const section = sectionOf(pathname);
  if (!section) return null;
  const name = heading?.replace(/\s+/g, " ").trim().slice(0, 80);
  const [base, action] = section.split(": ");
  if (!name || section.toLowerCase().startsWith(name.toLowerCase())) return { path: dashPath(pathname), title: section };
  // "Olga Sinenko's twin" already says what it is; "Renewal call" needs its kind in front.
  const named = name.toLowerCase().includes(base.toLowerCase()) ? name : `${base}: ${name}`;
  return { path: dashPath(pathname), title: `${named}${action ? ` · ${action}` : ""}` };
}

/** A way to start a conversation: the words it fills the composer with, a line on what it does, and its area. */
export type Starter = { text: string; hint: string; area: "twin" | "roleplay" | "persona" | "people" };

const S = {
  buildSkill: { text: "Build a twin skill from my knowledge", hint: "From the files in Twin’s brain", area: "twin" },
  updateSkill: { text: "Update a twin skill with new material", hint: "Adds to what it already knows", area: "twin" },
  listSkills: { text: "What twin skills do I have?", hint: "Each one, and what it covers", area: "twin" },
  twinAccess: { text: "Who has access to my twin?", hint: "Learners and their assignments", area: "people" },
  writeRoleplay: { text: "Write a new role play", hint: "From a brief or your recordings", area: "roleplay" },
  listRoleplays: { text: "Which role plays do I have?", hint: "With who plays them", area: "roleplay" },
  changeRoleplay: { text: "Change this role play", hint: "Its script, settings or tools", area: "roleplay" },
  roleplayAccess: { text: "Who is assigned this role play?", hint: "Learners and invites", area: "people" },
  createPersona: { text: "Create a persona for a role play", hint: "A name, a role and a voice", area: "persona" },
  listVoices: { text: "Which voices can a persona use?", hint: "By language and accent", area: "persona" },
  assignments: { text: "Who is assigned which role play?", hint: "Across the organization", area: "people" },
} satisfies Record<string, Starter>;

/**
 * What the copilot can start from on this page, phrased as the trainer would ask. Only what it can do today (building
 * and changing twin skills and role plays, personas, reading people's assignments: copilot/agent/instructions), and
 * never role plays in a twin-only org.
 */
export function startersFor(page: CopilotPage | null, { roleplay = true }: { roleplay?: boolean } = {}): Starter[] {
  const section = page ? sectionOf(page.path) : null;
  const pick = (...list: Starter[]) => list.filter((s) => roleplay || (s.area !== "roleplay" && s.area !== "persona"));
  const choice = (() => {
    switch (section) {
      case "Twin agents":
      case "Twin":
      case "Twin: configure":
      case "Twin’s brain":
      case "Knowledge file":
        return pick(S.buildSkill, S.listSkills);
      case "Scenarios":
      case "New role play":
        return pick(S.writeRoleplay, S.listRoleplays);
      case "Role play":
      case "Role play: edit":
      case "Role play: assign learners":
        return pick(S.changeRoleplay, S.roleplayAccess);
      case "Personas":
      case "Persona":
      case "New persona":
        return pick(S.createPersona, S.listVoices);
      case "Users":
      case "User":
      case "Twin users":
      case "Roleplay users":
      case "Twin: assign learners":
        return pick(roleplay ? S.assignments : S.twinAccess, S.twinAccess);
      default:
        return pick(S.buildSkill, roleplay ? S.writeRoleplay : S.listSkills);
    }
  })();
  // Never fewer than two: a twin-only org on a role-play page falls back to its twin starters.
  const unique = [...new Map(choice.map((s) => [s.text, s])).values()];
  return unique.length >= 2 ? unique : [...unique, ...pick(S.buildSkill, S.listSkills)].filter((s, i, all) => all.findIndex((o) => o.text === s.text) === i).slice(0, 2);
}

/** Home, the full-page copilot: the four main ways in, for what this org uses. */
export function homeStarters({ roleplay = true }: { roleplay?: boolean } = {}): Starter[] {
  return roleplay
    ? [S.buildSkill, S.writeRoleplay, S.createPersona, S.assignments]
    : [S.buildSkill, S.updateSkill, S.listSkills, S.twinAccess];
}
