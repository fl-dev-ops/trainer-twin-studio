import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "../lib/minutes-test-db";

// Real auth config/routes/DB, with only Google's code exchange and verified identity stubbed (no live OAuth).
const original = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET };
process.env.GOOGLE_CLIENT_ID = "people-test-google-client";
process.env.GOOGLE_CLIENT_SECRET = "people-test-google-secret";
const { auth } = await import("@/lib/auth");
for (const [key, value] of [["GOOGLE_CLIENT_ID", original.id], ["GOOGLE_CLIENT_SECRET", original.secret]] as const) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

describe.skipIf(!localMinutesDb)("Google sign-in has no self-sign-up (local database)", () => {
  let f: MinutesFixture;
  let exchange: ReturnType<typeof spyOn>;
  let identity: ReturnType<typeof spyOn>;
  let state: string | undefined;
  let address: string;
  const request = (path: string, body?: unknown, cookie?: string) => new Request(`https://auth.${BASE_DOMAIN}/api/auth/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", origin: `https://auth.${BASE_DOMAIN}`, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  beforeEach(async () => {
    f = minutesFixture(); await f.create(); state = undefined; address = `google-${f.org.id}@example.com`;
    const google = (await auth.$context).socialProviders.find((provider) => provider.id === "google")!;
    expect(google.options?.disableSignUp).toBe(true);
    exchange = spyOn(google, "validateAuthorizationCode").mockResolvedValue({ accessToken: "verified-test-token", scopes: ["openid", "email", "profile"] });
    identity = spyOn(google, "getUserInfo").mockImplementation(async () => ({
      user: { id: `${f.org.id}-google`, name: "Google person", email: address, emailVerified: true },
      data: { sub: `${f.org.id}-google`, name: "Google person", email: address, email_verified: true },
    }));
  });
  afterEach(async () => {
    exchange?.mockRestore(); identity?.mockRestore();
    if (state) await db.verification.deleteMany({ where: { identifier: state } });
    await f.clean();
  });
  const callback = async (requestSignUp = false) => {
    const back = `https://${f.org.slug}.${BASE_DOMAIN}/s/return?x=1&y=2`;
    const errorCallbackURL = `https://auth.${BASE_DOMAIN}/sign-in?redirect=${encodeURIComponent(back)}`;
    const started = await auth.handler(request("sign-in/social", { provider: "google", callbackURL: back, errorCallbackURL, disableRedirect: true, requestSignUp }));
    expect(started.status).toBe(200);
    const authorization = new URL((await started.json()).url);
    state = authorization.searchParams.get("state")!;
    expect(state).toBeTruthy();
    const cookie = started.headers.getSetCookie().map((header) => header.split(";")[0]).join("; ");
    const response = await auth.handler(request(`callback/google?state=${encodeURIComponent(state)}&code=test-code`, undefined, cookie));
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(identity).toHaveBeenCalledTimes(1);
    return { response, back, errorCallbackURL };
  };

  test.each([false, true])("Google refuses an unknown email even with requestSignUp=%s and returns to sign-in with redirect", async (requestSignUp) => {
    const { response, back } = await callback(requestSignUp);
    expect(response.status).toBe(302);
    const refusal = new URL(response.headers.get("location")!);
    expect(refusal.origin).toBe(`https://auth.${BASE_DOMAIN}`);
    expect(refusal.pathname).toBe("/sign-in");
    expect(refusal.searchParams.get("error")).toBe("signup_disabled");
    expect(refusal.searchParams.get("redirect")).toBe(back);
    expect(await db.user.findUnique({ where: { email: address } })).toBeNull();
    expect(await db.account.count({ where: { accountId: `${f.org.id}-google` } })).toBe(0);
  });

  test("Google links an existing unverified account, creates no new account/member, and returns to its requested session", async () => {
    address = f.learner.email;
    await db.user.update({ where: { id: f.learner.id }, data: { emailVerified: false } });
    const { response, back } = await callback();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(back);
    expect(await db.user.count({ where: { email: address } })).toBe(1);
    expect(await db.account.findFirstOrThrow({ where: { userId: f.learner.id } })).toMatchObject({ providerId: "google", accountId: `${f.org.id}-google` });
    expect(await db.session.count({ where: { userId: f.learner.id } })).toBe(1);
    expect(await db.member.count({ where: { userId: f.learner.id } })).toBe(1);
  });

  test("Google callback without an explicit error URL uses the app's sign-in page, not Better Auth's error page", async () => {
    const response = await auth.handler(request("callback/google?code=test-code"));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`https://auth.${BASE_DOMAIN}/sign-in?error=state_not_found`);
    expect(exchange).not.toHaveBeenCalled();
  });
});
