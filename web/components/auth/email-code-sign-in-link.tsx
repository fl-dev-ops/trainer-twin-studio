"use client";

import { BASE_DOMAIN } from "@/lib/base-domain";

/**
 * The other way in, next to a Google button (specs/people.md rule 10): the sign-in page's email code, then back to
 * `returnTo` (this page by default).
 */
export function EmailCodeSignInLink({ returnTo }: { returnTo?: string }) {
  const here = typeof window === "undefined" ? "" : window.location.href;
  const port = typeof window === "undefined" || !window.location.port ? "" : `:${window.location.port}`;
  const href = `https://auth.${BASE_DOMAIN}${port}/sign-in?redirect=${encodeURIComponent(returnTo ?? here)}`;
  return (
    <a href={href} className="text-center text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">
      Or sign in with a code sent to your email
    </a>
  );
}
