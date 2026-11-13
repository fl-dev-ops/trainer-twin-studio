# Authentication and host routing

> Sign-in identifies an existing account using Google or a six-digit email code. It never creates an account or grants org access. Operators create founders; studio members add other accounts. Shared cookies cover auth, studio and learner hosts. This module selects a home and handles founder onboarding; practice access is separate. Owners: `web/lib/auth.ts`, `web/lib/auth-client.ts`, `web/lib/auth-home.ts`, `web/proxy.ts`. Agreed rules: [People](people.md).

## Who uses it

| Actor | What they do / pointer |
| --- | --- |
| Existing account | Sign in with Google when configured, or email OTP (`web/components/auth/sign-in-form.tsx`; `web/lib/auth.ts`). |
| Unknown visitor | A sign-in-code request returns USER_NOT_FOUND/404 with trainer-add guidance, without a code/account. Google also refuses signup (`web/lib/auth.ts` after-hook and disableSignUp; Better Auth email-otp routes). |
| Founder | Operator-created account signs in before unused-token onboarding (`web/scripts/founder-invite.ts`; `web/app/auth/onboarding/page.tsx`). |
| Admin/team / learner | Same sign-in methods; home resolves enabled studio membership first, otherwise learner org or no-org (`web/lib/auth-home.ts` `resolveHome`). |
| Disabled person | Sign-in blocked only when memberships exist and all are disabled (`web/lib/members.ts` `isDisabledUser`; `web/lib/auth.ts` session-create hook). |

## Words used here

| Term | Meaning |
| --- | --- |
| Account | `User`, one identity/email across orgs, created before sign-in (`web/lib/org-people.ts` `accountsFor`). |
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
| FounderInvite | Unique random token, optional email, acceptedAt and createdAt; no expiry. Operator creates with account transaction; foundOrg spends it with org/admin creation; undoFounding restores it only after successful cleanup (`web/scripts/founder-invite.ts`; `web/lib/onboarding.ts`). |

Login: created → refreshed → expired/deleted. Better Auth defaults seven-day lifetime, one-day refresh age; app caches login identity for five minutes (`web/lib/auth.ts`; `dist/context/create-context.mjs`). Code: stored → wrong attempts counted / expired / consumed; resend issues another code (`dist/plugins/email-otp/routes.mjs`). Founder token: unused → accepted in the org transaction; successful provisioning undo restores unused. Failed undo leaves the token spent for staff (`web/lib/onboarding.ts` `foundOrg`, `undoFounding`).

## How it works

### Sign in, never self-register

1. SignInPage validates `redirect` with safeFamilyRedirect. Existing session immediately redirects there, else resolveHome. Signed-out page offers Google only with both Google client ID/secret configured; always offers email code (`web/app/auth/sign-in/page.tsx`).
2. SignInForm trims email and calls emailOtp.sendVerificationOtp(type:sign-in). Unknown accounts receive `USER_NOT_FOUND`/404: “This email isn't on TrainerTwin. Ask your trainer to add you.” Better Auth deletes their temporary verification and never invokes the send callback; the app after-hook replaces its internal success with that refusal. The form keeps unknown accounts on email entry (including a refused resend). Known accounts move to code entry and see “Code expires in 10 minutes.” in every environment; delivery is a backend concern. The form puts email/code before Google. Native email-format validation remains; a server INVALID_EMAIL refusal is shown as “Enter a valid email address.” The six separate OTP cells use the input's border, radius, height and focus/error treatment, with one native input for paste and autofill. Sign in stays disabled until all six digits are entered; Resend code sits beside the Code label. Changing email resets code state; resend clears code (`web/components/auth/sign-in-form.tsx` `sendCode`; `dist/plugins/email-otp/routes.mjs` sendVerificationOTP).
3. Server emailOTP: disableSignUp=true, otpLength=6, expiresIn=600 seconds, allowedAttempts=3, storeOTP=hashed. Only type sign-in calls sendOtpEmail. Failed Resend result throws INTERNAL_SERVER_ERROR with retry/Google guidance. Development (`NODE_ENV=development`) always prints the real expiring code to the server terminal and returns success without email, even with a Resend key. After the plugin successfully handles a sign-in-code request, the auth after-hook checks the same lowercased email through Better Auth's internal adapter in every environment and refuses a missing account with USER_NOT_FOUND/404. Registration disclosure is intentional under People rule 10. Only development logs the unknown address. Failed requests and other endpoints are skipped; lookup failures return a generic 500 rather than a false missing-account error (`web/lib/auth.ts`; `web/lib/email.ts` `sendOtpEmail`).
4. Numeric six-digit form calls signIn.emailOtp. Wrong/unknown code → guidance to check code and trainer-added address; expired → send new; too many attempts → send new; other server messages (including disabled access) pass through (`web/components/auth/sign-in-form.tsx` `onSubmit`, `codeError`). Successful OTP verifies existing user's email, consumes code, creates login, but creates no member (`dist/plugins/email-otp/routes.mjs` signInEmailOTP).
5. Google has disableSignUp=true and includeGrantedScopes=false. It can link a verified Google identity to an existing unverified local account because requireLocalEmailVerified=false and trustedProviders=[google]. Login does not reuse connector scopes or add membership (`web/lib/auth.ts`; `dist/oauth2/link-account.mjs`).
6. Google button callback defaults current URL; its error callback targets auth sign-in with return URL and local port. Missing explicit callback uses onAPIError.errorURL. SignInPage maps signup_disabled to “no TrainerTwin account ... use the email your trainer added”, other failures to retry/code guidance (`web/components/auth/google-sign-in-button.tsx`; `web/app/auth/sign-in/page.tsx` `signInError`; `web/lib/auth.ts`).
7. After code success, safe requested destination wins; otherwise fetch no-store `/api/me/home` and navigate. `/sign-up` is redirect-only to `/sign-in`, preserving encoded redirect query. No signup/password form remains (`web/components/auth/sign-in-form.tsx`; `web/app/auth/sign-up/page.tsx`). The GET/POST catch-all checks OPEN_AUTH_ROUTES before Better Auth runs; every unlisted GET/POST path/method pair returns `{error,code}` with `not_found`/404. It permits only get-session, sign-out, ok/error, the two sign-in-code routes, social sign-in, Google callback, organization/set-active and update-user. update-user must have exactly one field, name; other shapes get invalid_input/400. disabledPaths also closes base and email-OTP password/reset endpoints inside Better Auth (`web/app/api/auth/[...all]/route.ts` `open`; `web/lib/auth.ts` `disabledPaths`).

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
4. POST requires a session (signed_out/401), body with token length ≥10, trimmed company 1–80, HTTPS-or-empty website ≤2048 and connector none/notion/youtube; bad body is invalid_input/400. foundOrg checks 3–30-character nonreserved slug and availability, then in one transaction checks token/email, conditionally spends the unused token and creates org/admin directly. A concurrent spend fails token_invalid/400; a unique conflict becomes slug_taken/409 and rolls back the spend (`web/app/api/onboarding/route.ts` `POST`, `bodySchema`; `web/lib/onboarding.ts` `foundOrg`, `slugRefusal`; `web/lib/slugs.ts` `validateOrgSlug`; `web/lib/db.ts` `isUniqueViolation`).
5. runOnboarding provisions Chroma, Meteroid subscription and 30-day/30-minute trial when configured, with startup-only direct fallback. Provisioning failure attempts Chroma/billing cleanup, then transactionally deletes org and restores token; failed undo logs and leaves org/token for staff. Once foundOrg returns, active-org switch failure only logs and connector-start failure returns a warning redirect: neither undoes the org (`web/lib/onboarding.ts` `undoFounding`; `web/lib/workflow-runs.ts`; `web/workflows/onboard-org.ts`; `web/app/api/onboarding/route.ts` `POST`, `connectorStart`; [Credits](credits.md), [Knowledge](knowledge.md)).

### Cookies, origins and throttling

Cross-subdomain cookies use BASE_DOMAIN, Path=/, HttpOnly, SameSite=Lax; secure HTTPS defaults use __Secure prefix. Five-minute signed cookie cache is not encrypted or a live membership check. Deleting DB login sessions may not immediately remove cached identity; studio resolver independently rechecks enabled membership (`web/lib/auth.ts`; `dist/cookies/index.mjs`; `dist/api/routes/session.mjs`; `web/lib/org.ts`).

Trusted origins are HTTPS apex and wildcard subdomains, plus request Origin when safeFamilyRedirect accepts it (local ports allowed). CSRF/origin checks remain active. Better Auth default HTTP rate limiter is production-enabled, process-local/IP/path, with general 100 requests/10 seconds and sensitive special rules; emailOTP adds 3 requests/60 seconds per OTP endpoint, separately from 3 tries per stored code. App does not override top-level rateLimit (`web/lib/auth.ts`; `dist/api/rate-limiter/index.mjs`; `dist/plugins/email-otp/index.mjs`). API key's 120/60,000-ms setting is separate ([Public API](public-api.md)).

## Rules

1. Google and OTP can sign in only existing accounts; an unknown OTP request is explicitly refused with USER_NOT_FOUND/404, no delivered code or persisted account (`web/lib/auth.ts`; `dist/plugins/email-otp/routes.mjs`; `dist/oauth2/link-account.mjs`).
2. Codes are six digits, hashed, valid ten minutes, three wrong attempts before exhaustion. Successful code is single-use; only development prints it, regardless of Resend configuration (`web/lib/auth.ts`; `web/lib/email.ts`; `dist/plugins/email-otp/routes.mjs`).
3. Unlisted GET/POST auth routes, including password/reset, organization CRUD/member actions and API-key lifecycle routes, return not_found/404 before any handler writes. Signup page redirects; onboarding has no passwords. Other HTTP methods are a remaining mismatch (`web/app/api/auth/[...all]/route.ts` `OPEN_AUTH_ROUTES`, `open`; `web/lib/auth.ts` `disabledPaths`; `web/app/auth/sign-up/page.tsx`).
4. Signing in alone creates no org access; safe return URL can still win over no-org home, with authorization checked at destination (`web/lib/auth-home.ts`; `web/app/auth/sign-in/page.tsx`; `web/lib/pages/learner.ts`).
5. All-disabled membership check applies to every new login method; zero memberships or another enabled org permits login (`web/lib/auth.ts` databaseHooks; `web/lib/members.ts` `isDisabledUser`).
6. Better Auth generic org creation is disabled and its HTTP route is closed. Add/invite/remove/role-change hooks throw member_action_closed/403 even from server code; leave has no hook (Mismatches). Onboarding requires unused token and matching account email. Existing founders can provision another org through a token/API, though operator script refuses existing accounts (`web/lib/auth.ts` `memberActionClosed`, `organizationHooks`; `web/lib/onboarding.ts` `foundOrg`; `web/scripts/founder-invite.ts`).
7. Cookie presence/rewrite is not authentication; user/role is checked downstream (`web/proxy.ts`; `web/lib/org.ts`; `web/lib/trpc.ts`).

### Refusals

See [People — Refusals](people.md#refusals) for codes, statuses, messages and required layers. AppError/errorResponse/toAPIError implement the shared boundary (`web/lib/errors.ts`); tRPC carries ours in data.refusal (`web/lib/trpc.ts:54–57`).

## Entry points

- GET auth `/sign-in`, `/sign-up` (redirect), `/onboarding?t=...`, `/no-org`, `/invite?token=...`: corresponding `web/app/auth/*/page.tsx`.
- GET/POST `/api/auth/[...all]`: Better Auth catch-all (`web/app/api/auth/[...all]/route.ts`); client plugins organizationClient/emailOTPClient (`web/lib/auth-client.ts`).
- Exact allowlist: GET `/api/auth/get-session`, `/ok`, `/error`; POST `/api/auth/sign-out`, `/email-otp/send-verification-otp`, `/sign-in/email-otp`, `/sign-in/social`, `/organization/set-active`, `/update-user` (name only); GET/POST `/api/auth/callback/google`. All other GET/POST pairs are closed (`web/app/api/auth/[...all]/route.ts` `OPEN_AUTH_ROUTES`).
- GET `/api/me/home`, GET/POST `/api/onboarding`; connector starts from founder form; founder-invite operator script (pointers above).
- sendOtpEmail runs directly from the auth hook: terminal-only in development, Resend otherwise. The after-hook explicitly refuses unknown accounts; only development also logs the unknown address; action emails belong to [People and emails](invites-and-emails.md).

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
- Founder form sets accountCreated after name save but before workspace POST; retry after failed POST skips provisioning and advances to connectors. Server token consumption is now conditional and atomic, but this UI retry issue remains (`web/components/auth/founder-form.tsx:204–242`; `web/lib/onboarding.ts:35–52`).
- Slug availability GET returns 200 `{available,reason}` rather than a refusal response; it is an advisory check, not token authorization (`web/app/api/onboarding/route.ts` `GET`).

## Mismatches

- **People rules 13, 23 — missing method layer:** the catch-all exports only GET/POST. PATCH/PUT/DELETE are framework 405, OPTIONS is automatic and HEAD can reuse GET, instead of every unlisted method being not_found/404 with `{error,code}` (`web/app/api/auth/[...all]/route.ts:40–46`).
- **People rule 13 / member_action_closed — missing server hook:** HTTP leave is closed, but auth.api.leaveOrganization deletes a non-admin membership without any organization hook. The configured hooks cover only invite/add/update-role/remove (`web/lib/auth.ts:75–82`; `web/node_modules/better-auth/dist/plugins/organization/routes/crud-members.mjs:408–438` `leaveOrganization`).
- **People rule 23 — Better Auth errors not adapted:** allowed update-user/set-active/body validation and missing-login errors still use dependency codes/body, not invalid_input/signed_out and `{error,code}`. open checks the name field key, not its value; only the own disabled/member-action hooks use toAPIError. The rule's exception covers OTP/Google sign-in errors, not these account/org errors (`web/app/api/auth/[...all]/route.ts:31–37`; `web/lib/auth.ts:15–16,49–50`; `web/node_modules/better-auth/dist/api/routes/update-user.mjs:13–18,50–59` `updateUser`; `dist/plugins/organization/routes/crud-org.mjs:421–426` `setActiveOrganization`).
- **People token_invalid / onboarding_failed — route/service gaps:** missing/short token is invalid_input/400 with the general form message, not token_invalid/400. Nonunique errors during slug lookup or the org/admin DB transaction escape foundOrg/errorResponse rather than onboarding_failed/500; no spend commits, but the prescribed refusal is missing. If provisioning undo fails, foundOrg still gives onboarding_failed although its table promises an undone org and reusable token (`web/app/api/onboarding/route.ts:25–26,45–46,63–64`; `web/lib/onboarding.ts:32–56,59–62,67–78`; `web/lib/errors.ts:38–40`).
- Historical plan §8 says first sign-in creates an account; agreed rule 10 and current disableSignUp refuse it. Founder account comes from script instead (`plans/people-and-sign-in.md`; `web/lib/auth.ts`; `web/scripts/founder-invite.ts`).
- Disabled copy says no sign-in, but all-disabled check permits other enabled orgs; cache can preserve identity temporarily (`web/lib/members.ts`; `web/lib/auth.ts`).
- Founder script refuses existing accounts although onboarding page/API support another org for an existing founder; its “send an invite from dashboard” error is stale because member invitations are refused (`web/scripts/founder-invite.ts`; `web/app/auth/onboarding/page.tsx`; `web/lib/onboarding.ts`).
- Founder retry skips a failed workspace POST after saving the name, despite the setup link being reusable after a successful undo (`web/components/auth/founder-form.tsx:204–242`; `web/lib/onboarding.ts:67–75`).


## Open questions

- How should an operator issue another founder token to an existing account? Script refuses it, API accepts its session/token (`web/scripts/founder-invite.ts`; `web/app/api/onboarding/route.ts`).
- None about single-use tokens, post-creation cleanup or workspace retries: People rule 20 decides the server behavior; the remaining form retry is a bug listed above.
- None about password policy, invitation acceptance or Google linking to pre-created unverified accounts: [People](people.md) decides them.

## Tests today

- DB auth: `web/tests/api/people-auth.db.test.ts` covers OTP routes, hash/expiry/single-use/wrong tries/unknown account, founder script and staff role-change cleanup. Concurrent additions cover allowlisted routes, closed GET/POST pairs, name-only update, server member hooks and disabled sign-in. Wrong-method tests call exported GET/POST handlers, not Next's unsupported-method layer. `people-google-auth.db.test.ts` stubs Google exchange/identity: unknown signup refusal, existing-account linking and error callback.
- Unit: `web/tests/lib/email-otp-delivery.test.ts`, `base-domain.test.ts`, `members.test.ts`, `org-membership.test.ts`; routing `web/tests/proxy.test.ts`.
- Onboarding: concurrent `web/tests/api/onboarding.db.test.ts` additions cover single-token concurrency, slug/refusal paths, post-creation switch failure and failed undo; service/step tests remain `web/tests/lib/onboard-org.test.ts`, `onboarding-steps.test.ts`. Browser fixture signs in with generated OTP (`web/e2e/seed.setup.ts`); `web/e2e/people.spec.ts` covers people flows, not every refusal.
- Read-only check: latest `bun test ./web/tests/specs-refusals.test.ts` → 2 pass / 0 fail after concurrent title edits (an earlier snapshot failed). It checks title presence, not complete code/status/message or layer coverage (`web/tests/specs-refusals.test.ts:30–35`). No DB/flow/browser suite, live Google/Resend or cross-host cookie test run here. Server leave, Next method handling, invalid name values, missing body token and UI retries still need targeted coverage.
