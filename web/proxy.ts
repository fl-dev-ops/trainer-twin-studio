import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Host-aware routing. Subdomains are the only interface, locally via
 * portless (*.trainertwin.localhost) and in production the same shape.
 *
 *   auth.<base>/*            -> /auth/*          (sign-in, invites, onboarding)
 *   dash.<base>/*            -> /dash/*          (trainer studio, gated)
 *   <org-slug>.<base>/*      -> /*               (learner portal, (org) group)
 *   <base>/auth/*            -> auth.<base>/*    (apex hands off)
 *   <base>/dash/*            -> dash.<base>/*
 *   <base>/*                 -> sign-in on auth.<base>
 */
const BASE = process.env.NEXT_PUBLIC_BASE_DOMAIN ?? "trainertwin.localhost";

/** Paths that must never be host-rewritten (API, framework + public assets). */
function isPassthrough(pathname: string) {
  return (
    pathname.startsWith("/api") ||
    pathname.startsWith("/_next") ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml" ||
    /\.[a-zA-Z0-9]+$/.test(pathname) // public files: .svg, .png, .ico, ...
  );
}

export function proxy(request: NextRequest) {
  const hostHeader = request.headers.get("host") ?? "";
  const host = hostHeader.split(":")[0];
  const port = hostHeader.includes(":") ? `:${hostHeader.split(":")[1]}` : "";
  const { pathname } = request.nextUrl;
  const hasSession = Boolean(getSessionCookie(request));

  if (isPassthrough(pathname)) return NextResponse.next();

  const inFamily = host === BASE || host.endsWith(`.${BASE}`);
  const sub = inFamily && host !== BASE ? host.slice(0, host.length - BASE.length - 1) : null;

  const rewrite = (path: string) => {
    const url = request.nextUrl.clone();
    url.pathname = path;
    return NextResponse.rewrite(url);
  };

  // Auth host: everything lives under /auth. The bare root has no canonical
  // page — redirect to /sign-in so the URL is always shareable.
  if (sub === "auth") {
    if (pathname === "/") {
      return NextResponse.redirect(`https://auth.${BASE}${port}/sign-in`);
    }
    if (pathname.startsWith("/auth")) return NextResponse.next();
    return rewrite(`/auth${pathname}`);
  }

  // Dash host: everything lives under /dash, session required.
  if (sub === "dash") {
    if (!hasSession) {
      // Preserve the port so local proxies (portless :NNNN) keep working.
      return NextResponse.redirect(`https://auth.${BASE}${port}/sign-in`);
    }
    if (pathname === "/") return rewrite("/dash");
    // Canonicalize: strip the redundant /dash prefix on this host.
    if (pathname.startsWith("/dash/")) {
      return NextResponse.redirect(`https://dash.${BASE}${port}${pathname.slice(5)}`);
    }
    return rewrite(`/dash${pathname}`);
  }

  // Any other family subdomain is an org slug: the learner portal serves from
  // the root ((org) route group), no rewrite needed.
  if (sub) return NextResponse.next();

  // Apex host: hand each area to its subdomain.
  const area = (name: string, rest: string) =>
    NextResponse.redirect(`https://${name}.${BASE}${port}${rest}`);

  if (pathname.startsWith("/auth/")) {
    return area("auth", pathname.slice("/auth".length) || "/sign-in");
  }
  if (pathname === "/dash") {
    return area("dash", "/");
  }
  if (pathname.startsWith("/dash/")) {
    return area("dash", pathname.slice("/dash".length));
  }
  return area("auth", "/sign-in");
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
