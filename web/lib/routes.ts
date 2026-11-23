import type { Route } from "next";

/**
 * Typed links for the studio and sign-in hosts (typedRoutes in next.config.ts).
 *
 * The proxy serves app/dash at dash.<base>/ and app/auth at auth.<base>/, so a studio page in app/dash/twin/[id]/edit
 * is linked as "/twin/<id>/edit". Next types links by folder path ("/dash/twin/[id]/edit"), so these helpers check the
 * link against its folder and hand Next the URL the browser actually uses. Learner pages ((org) group) and API routes
 * need no helper: their folders match their URLs.
 *
 *   <Link href={dashRoute("/twin/" + id + "/edit")} />      // compile error if app/dash has no such page
 *   router.push(dashRoute(`/roleplay/${slug}`));
 *   redirect(authRoute("/sign-in"));
 */

/** The folder path a URL on a prefixed host comes from: "/" is the area's own index. */
type Folder<Prefix extends string, Href extends string> =
  Href extends "/" ? Prefix : Href extends `/${"?" | "#"}${string}` ? `${Prefix}${Href extends `/${infer Rest}` ? Rest : never}` : `${Prefix}${Href}`;

/** `Href` when app/<area> has a page for it, else never (a type error at the call). */
type AreaHref<Prefix extends string, Href extends string> = Folder<Prefix, Href> extends Route<Folder<Prefix, Href>> ? Href : never;

export type DashHref<Href extends string> = AreaHref<"/dash", Href>;
export type AuthHref<Href extends string> = AreaHref<"/auth", Href>;

/** A studio URL (dash.<base>), checked against app/dash. */
export function dashRoute<Href extends string>(href: DashHref<Href>): Route {
  return href as unknown as Route;
}

/** A sign-in host URL (auth.<base>), checked against app/auth. */
export function authRoute<Href extends string>(href: AuthHref<Href>): Route {
  return href as unknown as Route;
}

/**
 * A URL Next can't check: an absolute URL on another host (sign-in, an org's portal), a redirect target validated at
 * run time, or /auth/* reached from the dash host (the proxy forwards it to auth.<base>). Prefer dashRoute/authRoute.
 */
export function crossHostRoute(url: string): Route {
  return url as Route;
}

/** A learner-portal URL (<org>.<base>), checked against the (org) pages, whose folders match their URLs. */
export function orgRoute<Href extends string>(href: Href extends Route<Href> ? Href : never): Route {
  return href as unknown as Route;
}
