# Authentication and host routing

> Sign-in identifies an existing account using Google or a six-digit email code. It never creates an account or grants org access. Operators create founders; studio members add other accounts. Shared cookies cover auth, studio and learner hosts. This module selects a home and handles founder onboarding; practice access is separate. Owners: `web/lib/auth.ts`, `web/lib/auth-client.ts`, `web/lib/auth-home.ts`, `web/proxy.ts`. Agreed rules: [People](people.md).

## Who uses it

| Actor | What they do / pointer |
| --- | --- |
| Existing account | Sign in with Google when configured, or email OTP (`web/components/auth/sign-in-form.tsx`; `web/lib/auth.ts`). |
| Unknown visitor | Can request a code and receive generic success, but gets no code/account. Google also refuses signup (`web/lib/auth.ts` disableSignUp; Better Auth email-otp routes). |
| Founder | Operator-created account signs in before unused-token onboarding (`web/scripts/founder-invite.ts`; `web/app/auth/onboarding/page.tsx`). |
| Admin/team / learner | Same sign-in methods; home resolves enabled studio membership first, otherwise learner org or no-org (`web/lib/auth-home.ts` `resolveHome`). |
| Disabled person | Sign-in blocked only when memberships exist and all are disabled (`web/lib/members.ts` `isDisabledUser`; `web/lib/auth.ts` session-create hook). |

## Words used here

| Term | Meaning |
| --- | --- |
| Account | `User`, one identity/email across orgs, created before sign-in (`web/lib/org-people.ts` `accountFor`). |
| Provider account | `Account`: Google tokens or historical credential/password record. OTP does not require a credential record (`web/prisma/schema.prisma`; Better Auth signInEmailOTP). |
| Login session | Better Auth `Session`/cookies, not a practice call ([Sessions](sessions.md)). |
| OTP | One-time password in the dependency's name; here an expiring email code, not a reusable password (`web/lib/auth.ts` emailOTP). |
| Founder token | `FounderInvite`, unused/accepted authorization to create an org, not a member invitation (`web/prisma/schema.prisma`). |
| Family | Apex and any hostname ending `.<BASE_DOMAIN>`; BASE_DOMAIN defaults trainertwin.localhost (`web/lib/base-domain.ts`). |
| Pin / active org | Tab header / session preference, not authorization; [Organizations and roles](orgs-and-roles.md). |

Dependency pointers below are relative to `web/node_modules/better-auth/` (installed 1.7.15).

## Data

| Record | Fields / writers |
| --- | --- |
| User | Unique email, name, emailVerified, image, timestamps. People/founder script create; OTP verifies email and creates a login, Google may link its provider to an existing unverified account (`web/lib/org-people.ts`; `web/scripts/founder-invite.ts`; `dist/plugins/email-otp/routes.mjs` signInEmailOTP; `dist/oauth2/link-account.mjs`). |
| Account | userId/provider/accountId, optional historical password and OAuth tokens. Password storage fields were not dropped. Google linking writes provider data (`web/prisma/schema.prisma`; `web/lib/auth.ts`). |
| Session | Unique token, userId, expiry, IP/user agent, activeOrganizationId. Better Auth creates/refreshes/deletes; disabling last enabled org deletes DB login sessions (`web/lib/auth.ts`; `web/lib/members.ts`). |
| Verification | Identifier, hashed OTP value plus attempt state, expiresAt. emailOTP stores sign-in codes; successful use consumes them (`web/lib/auth.ts`; `dist/plugins/email-otp/{routes,otp-token}.mjs`). |
| FounderInvite | Unique random token, optional email, acceptedAt and createdAt; no expiry. Operator creates with account transaction; onboarding consumes/restores on setup failure (`web/scripts/founder-invite.ts`; `web/app/api/onboarding/route.ts`). |

Login: created → refreshed → expired/deleted. Better Auth defaults seven-day lifetime, one-day refresh age; app caches login identity for five minutes (`web/lib/auth.ts`; `dist/context/create-context.mjs`). Code: stored → wrong attempts counted / expired / consumed; resend issues another code (`dist/plugins/email-otp/routes.mjs`). Founder token: unused → accepted; best-effort cleanup can restore unused (`web/app/api/onboarding/route.ts`).

## How it works

### Sign in, never self-register

1. SignInPage validates `redirect` with safeFamilyRedirect. Existing session immediately redirects there, else resolveHome. Signed-out page offers Google only with both Google client ID/secret configured; always offers email code (`web/app/auth/sign-in/page.tsx`).
2. SignInForm trims email and calls emailOtp.sendVerificationOtp(type:sign-in). Unknown accounts receive `{success:true}`; Better Auth deletes the temporary verification and never invokes the send callback. Form says “If <email> has a TrainerTwin account, we've sent it a code.” Changing email resets code state; resend clears code (`web/components/auth/sign-in-form.tsx` `sendCode`; `dist/plugins/email-otp/routes.mjs` sendVerificationOTP).
3. Server emailOTP: disableSignUp=true, otpLength=6, expiresIn=600 seconds, allowedAttempts=3, storeOTP=hashed. Only type sign-in calls sendOtpEmail. Failed Resend result throws INTERNAL_SERVER_ERROR with retry/Google guidance. Development only without Resend prints the real expiring code to terminal and returns success (`web/lib/auth.ts`; `web/lib/email.ts` `sendOtpEmail`).
4. Numeric six-digit form calls signIn.emailOtp. Wrong/unknown code → guidance to check code and trainer-added address; expired → send new; too many attempts → send new; other server messages (including disabled access) pass through (`web/components/auth/sign-in-form.tsx` `onSubmit`, `codeError`). Successful OTP verifies existing user's email, consumes code, creates login, but creates no member (`dist/plugins/email-otp/routes.mjs` signInEmailOTP).
5. Google has disableSignUp=true and includeGrantedScopes=false. It can link a verified Google identity to an existing unverified local account because requireLocalEmailVerified=false and trustedProviders=[google]. Login does not reuse connector scopes or add membership (`web/lib/auth.ts`; `dist/oauth2/link-account.mjs`).
6. Google button callback defaults current URL; its error callback targets auth sign-in with return URL and local port. Missing explicit callback uses onAPIError.errorURL. SignInPage maps signup_disabled to “no TrainerTwin account ... use the email your trainer added”, other failures to retry/code guidance (`web/components/auth/google-sign-in-button.tsx`; `web/app/auth/sign-in/page.tsx` `signInError`; `web/lib/auth.ts`).
7. After code success, safe requested destination wins; otherwise fetch no-store `/api/me/home` and navigate. `/sign-up` is redirect-only to `/sign-in`, preserving encoded redirect query. No signup/password form remains (`web/components/auth/sign-in-form.tsx`; `web/app/auth/sign-up/page.tsx`). Under `/api/auth`, `disabledPaths` returns 404 for `/sign-in/email`, `/sign-up/email`, `/change-password`, `/request-password-reset`, `/reset-password` and `/verify-password`, before handlers run. Email-OTP reset paths are separate; see Mismatches (`web/lib/auth.ts` `auth`; `web/node_modules/better-auth/dist/api/index.mjs` `onRequest`).

### Host routing and safe returns

`proxy` first passes API, Next, robots/sitemap and extension-looking paths unchanged; matcher excludes static/image/favicon/workflow-internal routes. Other rules are ordered below (`web/proxy.ts` `proxy`, `isPassthrough`, `config.matcher`). Rewrites preserve query; string-built redirects do not, use HTTPS and retain host port. Cookie gate is presence only, not token verification.

| Host/path | Result |
| --- | --- |
| auth root | Redirect /sign-in. |
| auth /auth-prefix | Pass through; other auth paths rewrite to /auth<path>. |
| dash /auth or /auth/... | Redirect to auth with prefix stripped, before cookie gate. |
| dash without nonempty session cookie | Redirect auth /sign-in, no return URL. |
| dash with cookie, / | Rewrite /dash. |
| dash with cookie, /dash/... | Redirect dash with prefix stripped. |
| dash with cookie, other | Rewrite /dash<path>; bare /dash becomes /dash/dash. |
| Other family subdomain | Pass through to org root routes; no slug validation or cookie gate. |
| Apex/outside family /auth/... | Redirect auth with prefix stripped. |
| Apex/outside family /dash or /dash/... | Redirect dash root or prefix-stripped path. |
| Apex/outside family other (including bare /auth) | Redirect auth sign-in. |

safeFamilyRedirect accepts absolute HTTPS family URLs only, retaining port/path/query/fragment. It does not check membership or path existence. signInUrl(host,returnPath) uses auth host/port and adds a redirect only for a slash-starting path (`web/lib/base-domain.ts`). Downstream enabled-membership/studio checks remain required (`web/lib/org.ts`; `web/lib/trpc.ts`).

### Choose home and use portal identity

resolveHome returns null signed out; no enabled member → /auth/no-org; selected admin/team → dash root; selected learner → org root. Selection prefers pinned/active/oldest studio, then active/oldest learner. GET `/api/me/home` substitutes /auth/sign-in for null (`web/lib/auth-home.ts`; `web/lib/org.ts` `currentMembership`, `pickMembership`; `web/app/api/me/home/route.ts`).

resolveSessionUser prefers a known host org over selected membership, and returns identity/sign-in URL without proving portal membership. No-org displays signed-in email/switch or sign-in and says to open the trainer's link (`web/lib/session-user.ts`; `web/app/auth/no-org/page.tsx`). Portal Google dialogs now include EmailCodeSignInLink with return URL. No org-home invitation acceptance remains (`web/components/org/org-home.tsx`; `web/components/twin/twin-learner-flow.tsx`; `web/components/auth/email-code-sign-in-link.tsx`; `web/lib/pages/org-home.ts`).

Old `/invite?token=id` looks up historical role/org and redirects to org home (learner) or studio (admin/team), unknown token → /sign-in. It never offers acceptance or checks pending/expiry (`web/app/auth/invite/page.tsx`; `web/lib/invite/links.ts`).

### Founder onboarding

1. `bun scripts/founder-invite.ts <email>` trims/lowercases/validates email, refuses already registered exact normalized email, transactionally creates unverified account (name before @) and token (24 random bytes, base64url), prints onboarding URL, sends no email (`web/scripts/founder-invite.ts`).
2. Unused token and signed-out visitor redirects to code/Google sign-in with onboarding return URL. Otherwise existing enabled admin can resume connectors for active/oldest admin org; invalid/used token with no admin org shows Invite required (`web/app/auth/onboarding/page.tsx`).
3. Form steps: first/last name → company/optional HTTPS website/slug → optional connectors. Step 2 updates the existing signed-in account name, then POSTs onboarding; no password/account signup. Availability checks debounce 280 ms (`web/components/auth/founder-form.tsx` `handleStep1Next`, `handleStep2Next`).
4. POST requires session (401), valid body/unused token (400), matching invited email (403), trimmed company 1–80, HTTPS-or-empty website ≤2048, valid slug and no collision (409); optional connector none/notion/youtube. Transaction consumes token and creates org/admin directly, not via addPeopleToOrg or Better Auth self-org endpoint (`web/app/api/onboarding/route.ts`).
5. runOnboarding provisions Chroma, Meteroid subscription and 30-day/30-minute trial when configured, with startup-only direct fallback. Success activates new org. Provisioning failure attempts Chroma/billing/org cleanup and token restoration, returns 500. Connector-start failure keeps org and returns warning redirect; current form handles connectors separately (`web/lib/workflow-runs.ts`; `web/workflows/onboard-org.ts`; `web/app/api/onboarding/route.ts`; [Credits](credits.md), [Knowledge](knowledge.md)).

### Cookies, origins and throttling

Cross-subdomain cookies use BASE_DOMAIN, Path=/, HttpOnly, SameSite=Lax; secure HTTPS defaults use __Secure prefix. Five-minute signed cookie cache is not encrypted or a live membership check. Deleting DB login sessions may not immediately remove cached identity; studio resolver independently rechecks enabled membership (`web/lib/auth.ts`; `dist/cookies/index.mjs`; `dist/api/routes/session.mjs`; `web/lib/org.ts`).

Trusted origins are HTTPS apex and wildcard subdomains, plus request Origin when safeFamilyRedirect accepts it (local ports allowed). CSRF/origin checks remain active. Better Auth default HTTP rate limiter is production-enabled, process-local/IP/path, with general 100 requests/10 seconds and sensitive special rules; emailOTP adds 3 requests/60 seconds per OTP endpoint, separately from 3 tries per stored code. App does not override top-level rateLimit (`web/lib/auth.ts`; `dist/api/rate-limiter/index.mjs`; `dist/plugins/email-otp/index.mjs`). API key's 120/60,000-ms setting is separate ([Public API](public-api.md)).

## Rules

1. Google and OTP can sign in only existing accounts; unknown OTP request is generic success with no delivered code or persisted account (`web/lib/auth.ts`; `dist/plugins/email-otp/routes.mjs`; `dist/oauth2/link-account.mjs`).
2. Codes are six digits, hashed, valid ten minutes, three wrong attempts before exhaustion. Successful code is single-use; only development without Resend prints it (`web/lib/auth.ts`; `web/lib/email.ts`; `dist/plugins/email-otp/routes.mjs`).
3. The six base password sign-in/signup/change/request/reset/verify paths return 404 through disabledPaths, not a password-disabled JSON refusal. Signup page redirects; onboarding has no password fields. The plugin's differently named reset paths remain mounted (Mismatches) (`web/lib/auth.ts` `auth`; `web/node_modules/better-auth/dist/api/index.mjs` `onRequest`; `web/app/auth/sign-up/page.tsx`; `web/components/auth/founder-form.tsx`).
4. Signing in alone creates no org access; safe return URL can still win over no-org home, with authorization checked at destination (`web/lib/auth-home.ts`; `web/app/auth/sign-in/page.tsx`; `web/lib/pages/learner.ts`).
5. All-disabled membership check applies to every new login method; zero memberships or another enabled org permits login (`web/lib/auth.ts` databaseHooks; `web/lib/members.ts` `isDisabledUser`).
6. Better Auth generic org creation is disabled; onboarding requires unused token and matching account email. Existing founders can provision another org through a token/API, though operator script refuses existing accounts (`web/lib/auth.ts`; `web/app/api/onboarding/route.ts`; `web/scripts/founder-invite.ts`).
7. Cookie presence/rewrite is not authentication; user/role is checked downstream (`web/proxy.ts`; `web/lib/org.ts`; `web/lib/trpc.ts`).

## Entry points

- GET auth `/sign-in`, `/sign-up` (redirect), `/onboarding?t=...`, `/no-org`, `/invite?token=...`: corresponding `web/app/auth/*/page.tsx`.
- GET/POST `/api/auth/[...all]`: Better Auth catch-all (`web/app/api/auth/[...all]/route.ts`); client plugins organizationClient/emailOTPClient (`web/lib/auth-client.ts`).
- POST `/api/auth/email-otp/send-verification-otp`, `/api/auth/sign-in/email-otp`, `/api/auth/sign-in/social`; Google callback; get-session/sign-out. The six base password paths listed above return 404; they are not usable entry points (`web/lib/auth.ts` `disabledPaths`).
- GET `/api/me/home`, GET/POST `/api/onboarding`; connector starts from founder form; founder-invite operator script (pointers above).
- sendOtpEmail calls Resend directly from auth hook; action emails belong to [People and emails](invites-and-emails.md).

## Talks to

- Better Auth + PostgreSQL: identity, Google provider records, sessions and OTP verifications (`web/lib/auth.ts`; `web/prisma/schema.prisma`).
- Google OAuth: verified external identity, not connector content (`web/lib/auth.ts` socialProviders).
- Resend: OTP template/results; no OTP workflow (`web/lib/email.ts` `sendOtpEmail`).
- Org/portal/access modules: enabled membership, home, host org and safe return URLs (`web/lib/org.ts`, `auth-home.ts`, `session-user.ts`, `base-domain.ts`; owning specs linked above).
- Chroma/Meteroid/Notion/YouTube: founder provisioning/connectors (`web/lib/workflow-runs.ts`; `web/app/api/onboarding/route.ts`).

## Edge cases and limits

- Proxy redirects lose query; no-cookie dash redirects lose original page. Host splitting is domain/port oriented, not IPv6. portalSlug reads first label; family matcher accepts nested subdomains (`web/proxy.ts`; `web/lib/base-domain.ts`).
- Portal dialogs render Google even without configured credentials, unlike SignInPage; email-code link remains usable (`web/components/org/org-home.tsx`; `web/components/twin/twin-learner-flow.tsx`).
- SignInForm code requests lack a try/finally around thrown transport failures; busy can remain set. Google button has catch/finally (`web/components/auth/sign-in-form.tsx`; `google-sign-in-button.tsx`).
- Founder form sets accountCreated after name save but before workspace POST; retry after failed POST skips provisioning and advances to connectors. Token consume check is outside its transaction; simultaneous requests are not conditional single-use writes (`web/components/auth/founder-form.tsx`; `web/app/api/onboarding/route.ts`).

## Mismatches

- **People rule 10, remaining plugin reset routes:** the six base password paths are now 404, but disabledPaths matches exact normalized paths. Email-OTP still registers `/email-otp/request-password-reset`, `/forget-password/email-otp` and `/email-otp/reset-password`, none listed there. Requests can store a forget-password code; the callback sends no reset email. With a valid stored code, the plugin reset handler can write a credential password even with emailAndPassword disabled. This is not an enabled password sign-in route (`web/lib/auth.ts` `auth`, `sendVerificationOTP`; `web/node_modules/better-auth/dist/api/index.mjs:166–169`; `dist/plugins/email-otp/routes.mjs:464–598` `requestPasswordResetEmailOTP`, `forgetPasswordEmailOTP`, `resetPasswordEmailOTP`; `web/app/api/auth/[...all]/route.ts`).
- Historical plan §8 says first sign-in creates an account; agreed rule 10 and current disableSignUp refuse it. Founder account comes from script instead (`plans/people-and-sign-in.md`; `web/lib/auth.ts`; `web/scripts/founder-invite.ts`).
- Disabled copy says no sign-in, but all-disabled check permits other enabled orgs; cache can preserve identity temporarily (`web/lib/members.ts`; `web/lib/auth.ts`).
- Founder UI promises 3–30-character slug, while server regex also accepts one character. Founder script refuses existing accounts although onboarding page/API support another org for an existing founder; its “send an invite from dashboard” error is stale because member invitations are refused (`web/lib/slugs.ts`; `web/scripts/founder-invite.ts`; `web/app/api/onboarding/route.ts`).

## Open questions

- How should an operator issue another founder token to an existing account? Script refuses it, API accepts its session/token (`web/scripts/founder-invite.ts`; `web/app/api/onboarding/route.ts`).
- Should workspace POST retry after name save, and token consumption be conditional in-transaction? Current form/route allow skipped retries and concurrent consumption (`web/components/auth/founder-form.tsx`; `web/app/api/onboarding/route.ts`).
- None about password policy, invitation acceptance or Google linking to pre-created unverified accounts: [People](people.md) decides them.

## Tests today

- DB auth: `web/tests/api/people-auth.db.test.ts` covers real OTP routes, hash/expiry/single-use/wrong tries/unknown account, disabled password sign-in, founder script, invitation refusal and assignment cleanup after role update. `people-google-auth.db.test.ts` stubs Google exchange/identity with real auth routes/DB: unknown signup refusal, linking existing account and error callback.
- Unit: `web/tests/lib/email-otp-delivery.test.ts`, `base-domain.test.ts`, `members.test.ts`, `org-membership.test.ts`; routing `web/tests/proxy.test.ts`.
- Onboarding: `web/tests/api/onboarding.db.test.ts`, `web/tests/lib/onboard-org.test.ts`, `onboarding-steps.test.ts`. Browser fixture now signs in with generated OTP (`web/e2e/seed.setup.ts`); `web/e2e/people.spec.ts` covers adding/assigning and people lists, not code-page refusal.
- No tests run for this edit. No live Google, Resend or cross-host cookie test; residual password/reset endpoints, founder retry/concurrency and transport failures need dedicated coverage.
