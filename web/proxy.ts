import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Temporary single-host routing for the Vercel host/guest integration test.
 * Auth and dashboard routes stay on this deployment's origin so no wildcard
 * DNS is required. Revert this commit to restore subdomain routing.
 */

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
  const { pathname, search } = request.nextUrl;
  const hasSession = Boolean(getSessionCookie(request));

  if (isPassthrough(pathname)) return NextResponse.next();

  // Host-delegated subpath hosting (e.g. careerwithvasanth.com/interview): the
  // host app authenticates and proxies; its x-tenant-slug header marks these
  // requests. Skip standalone auth routing so the guest page remains mounted.
  if (request.headers.get("x-tenant-slug")) return NextResponse.next();

  if (pathname.startsWith("/auth")) return NextResponse.next();

  // `/dash` is the internal Next.js route namespace. Standalone studio URLs
  // expose clean paths (`/agents`, `/sessions`, ...), while host-delegated
  // mounts reach `/dash/*` after their organization basePath is stripped.
  if (pathname === "/dash" || pathname.startsWith("/dash/")) {
    const url = request.nextUrl.clone();
    url.pathname = pathname.slice("/dash".length) || "/";
    return NextResponse.redirect(url);
  }

  if (!hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = "/auth/sign-in";
    url.search = "";
    if (pathname !== "/") url.searchParams.set("redirect", `${pathname}${search}`);
    return NextResponse.redirect(url);
  }

  const url = request.nextUrl.clone();
  url.pathname = pathname === "/" ? "/dash" : `/dash${pathname}`;
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
