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

/**
 * What the copilot can start from on this page, phrased as the trainer would ask. Only what it can do today: building
 * and changing twin skills and role plays, personas, and reading people's assignments (copilot/agent/instructions).
 */
export function startersFor(page: CopilotPage | null): string[] {
  const section = page ? sectionOf(page.path) : null;
  switch (section) {
    case "Twin agents":
    case "Twin":
    case "Twin: configure":
    case "Twin’s brain":
    case "Knowledge file":
      return ["Build a twin skill from my knowledge", "What twin skills do I have?"];
    case "Scenarios":
    case "New role play":
      return ["Write a new role play", "Which role plays do I have?"];
    case "Role play":
    case "Role play: edit":
    case "Role play: assign learners":
      return ["Change this role play", "Who is assigned this role play?"];
    case "Personas":
    case "Persona":
    case "New persona":
      return ["Create a persona for a role play", "Which voices can a persona use?"];
    case "Users":
    case "User":
    case "Twin users":
    case "Roleplay users":
    case "Twin: assign learners":
      return ["Who is assigned which role play?", "Who has access to my twin?"];
    default:
      return ["Build a twin skill from my knowledge", "Write a new role play"];
  }
}
