import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest, NextResponse } from "next/server";
import { proxy } from "../proxy";

function request(host: string, path: string, cookie = "") {
  const req = new NextRequest(`https://${host}${path}`, {
    headers: { host, ...(cookie ? { cookie } : {}) },
  });
  return req;
}

/** Location helper: redirects carry it, rewrites do not. */
function location(res: ReturnType<typeof proxy>): string | null {
  return res.headers.get("location");
}

const BASE = process.env.NEXT_PUBLIC_BASE_DOMAIN ?? "trainertwin.localhost";

test("dash host + expired/stale session cookie + /auth/sign-in hands off to auth host, no 404", () => {
  // Stale cookie: present, but invalid. Previously this rewrote to
  // /dash/auth/sign-in which does not exist -> "That page isn't here."
  const res = proxy(request(`dash.${BASE}`, "/auth/sign-in", "better-auth.session_token=stale-token"));
  assert.match(location(res)!, new RegExp(`^https://auth\\.${BASE.replace(".", "\\.")}/sign-in$`));
});

test("dash host + /auth (bare) redirects to auth host sign-in", () => {
  const res = proxy(request(`dash.${BASE}`, "/auth", "better-auth.session_token=stale-token"));
  assert.match(location(res)!, /\/sign-in$/);
});

test("dash host + no cookie still redirects to sign-in", () => {
  const res = proxy(request(`dash.${BASE}`, "/"));
  assert.match(location(res)!, new RegExp(`^https://auth\\.${BASE.replace(".", "\\.")}/sign-in$`));
});

test("dash host + valid-looking cookie rewrites to /dash (no redirect)", () => {
  const res = proxy(request(`dash.${BASE}`, "/", "better-auth.session_token=whatever"));
  assert.equal(location(res), null);
});

test("auth host + /sign-in rewrites to /auth/sign-in (no redirect)", () => {
  const res = proxy(request(`auth.${BASE}`, "/sign-in"));
  assert.equal(location(res), null);
});

test("apex /auth/sign-in hands off to the auth host", () => {
  const res = proxy(request(BASE, "/auth/sign-in"));
  assert.match(location(res)!, new RegExp(`^https://auth\\.${BASE.replace(".", "\\.")}/sign-in$`));
});

test("api paths are never host-rewritten", () => {
  const res = proxy(request(`dash.${BASE}`, "/api/v1/chat/completions", "better-auth.session_token=x"));
  assert.equal(location(res), null);
  assert.equal((res as unknown as { destination?: string }).destination, undefined);
});

// Keep NextResponse import referenced for types in stricter bundles.
void NextResponse;
