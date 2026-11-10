# Authentication and host routing

> Authentication identifies a person by email/password or Google and keeps them signed in across the auth, studio and organization hosts. This module chooses where they land after sign-in, serves account and founder-onboarding pages, and separates identity from permission to use an organization. Signing up alone does not create an organization or grant practice access. (`web/lib/auth.ts`, `web/lib/auth-home.ts`, `web/proxy.ts`.)

## Who uses it

| Person | What they can do here |
| --- | --- |
| Signed-out visitor | Create an account or sign in with email/password; use Google when configured. No invitation is checked by the general sign-up page. (`web/app/auth/sign-up/page.tsx`, `web/components/auth/sign-up-form.tsx`, `web/lib/auth.ts`.) |
| Founder | Use a founder invite to create an organization and become its admin. The onboarding form creates an email/password account. (`web/components/auth/founder-form.tsx` `handleStep2Next`, `web/app/api/onboarding/route.ts` POST.) |
| Admin or team member | Sign in and land in the studio if they have an enabled studio membership. The signed-out team-invite screen offers Google only, with the invited email; it does not offer password registration. (`web/lib/auth-home.ts` `resolveHome`, `web/components/auth/invite-form.tsx`.) |
| Learner | Use either method on the general auth pages. The organization-home sign-in dialog offers Google; personal practice links can send them through general sign-in/sign-up. Sign-in is not itself permission to practise. (`web/components/org/org-home.tsx`, `web/lib/pages/learner.ts` `loadSharedSession`, `web/components/auth/sign-in-form.tsx`; see [Learner portal](learner-portal.md).) |
| TrainerTwin staff/operator | Generate a founder invite with a script. This is an operational action, not a separate staff role in the auth configuration. (`web/scripts/founder-invite.ts`, `web/lib/auth.ts`.) |
| Disabled member | Can still sign in if at least one other membership is enabled. Cannot create a new session when every membership is disabled. A person with no memberships is not blocked by this check. (`web/lib/members.ts` `isDisabledUser`, `web/lib/auth.ts` session-create hook.) |

## Words used here

| Term | Meaning |
| --- | --- |
| Base domain / family | `NEXT_PUBLIC_BASE_DOMAIN`, default `trainertwin.localhost`; the apex and hosts ending in `.<base>` are the family. (`web/lib/base-domain.ts`, `web/proxy.ts`.) |
| Auth host | `auth.<base>`: sign-in, sign-up, invites, onboarding and no-org pages. (`web/proxy.ts` `proxy`.) |
| Dash / studio host | `dash.<base>`: trainer workspace, internally under `/dash`. (`web/proxy.ts`.) |
| Organization host | Any other family subdomain, treated as an organization slug; learner routes live at its root. Routing does not prove the org exists. (`web/proxy.ts`, `web/lib/session-user.ts` `resolveSessionUser`.) |
| Session | Better Auth login record and cookies identifying a user. Not a voice/practice session; see [Sessions](sessions.md) for those. (`web/prisma/schema.prisma` `Session`, `web/lib/auth.ts`.) |
| Account / provider | A login method attached to a user: `credential` for a password, `google` for Google OAuth (external sign-in authorization). (`web/prisma/schema.prisma` `Account`; Better Auth `dist/api/routes/sign-up.mjs`, `dist/oauth2/link-account.mjs`.) |
| Membership | A user's role in an organization: `admin`, `team` or `user` (learner). `disabledAt` removes access in that org. See [Organizations and roles](orgs-and-roles.md). (`web/prisma/schema.prisma` `Member`, `web/lib/org.ts`.) |
| Founder invite | A single-use token authorizing organization creation, optionally tied to an email. Different from a team/learner membership invitation. (`web/prisma/schema.prisma` `FounderInvite`, `web/app/api/onboarding/route.ts` POST.) |
| Rewrite / redirect | A rewrite serves an internal path without changing the browser URL; a redirect sends the browser to another URL. (`web/proxy.ts` `rewrite`, `area`.) |
| Cookie cache | A signed snapshot of the session and user, usable for five minutes without looking up the session in the database. It is not a live membership check. (`web/lib/auth.ts` `session`; Better Auth `dist/cookies/index.mjs` `setCookieCache`, `dist/api/routes/session.mjs`.) |

Dependency pointers below are relative to `web/node_modules/better-auth/`. The version inspected is **1.7.15**, pinned by `web/bun.lock`; the project deliberately leaves several settings at that dependency's defaults (`web/lib/auth.ts`).

## Data

| Record | Fields and writers |
| --- | --- |
| `User` → `user` | `id`, `name`, unique `email`, `emailVerified` (default false), optional `image`, timestamps. Better Auth writes account identity through its Prisma adapter. Roles are not on this row. (`web/prisma/schema.prisma` `User`, `web/lib/auth.ts`.) |
| `Account` → `account` | `userId`, provider's `accountId`, `providerId`; optional password hash, OAuth access/refresh/ID tokens, token expiry, scope and issuer. Better Auth creates password/Google accounts and updates credentials/tokens. (`web/prisma/schema.prisma` `Account`; dependency `dist/api/routes/sign-up.mjs`, `dist/oauth2/link-account.mjs`, `dist/utils/password.mjs`.) |
| `Session` → `session` | Unique `token`, `userId`, `expiresAt`, timestamps, optional IP/user agent and `activeOrganizationId`. Better Auth creates, refreshes and deletes sessions. Organization selection may change the active org; disabling the last enabled membership deletes all that user's login sessions. (`web/prisma/schema.prisma` `Session`, `web/lib/auth.ts`, `web/lib/members.ts` `setMemberDisabled`.) |
| `Verification` → `verification` | `identifier`, `value`, `expiresAt`, timestamps. Password reset stores `reset-password:<token>` with the user ID as its value. Better Auth creates and consumes it. (`web/prisma/schema.prisma` `Verification`; dependency `dist/api/routes/password.mjs`.) |
| `FounderInvite` → `founder_invite` | Unique `token`, optional `email`, nullable `acceptedAt`, `createdAt`. No expiry field. The founder-invite script creates it; onboarding marks it accepted and clears it on provisioning failure. (`web/prisma/schema.prisma` `FounderInvite`, `web/scripts/founder-invite.ts`, `web/app/api/onboarding/route.ts` POST.) |

Organization, membership and ordinary invitation records belong to [Organizations and roles](orgs-and-roles.md) and [Invites and emails](invites-and-emails.md). Auth reads membership role/disabled state and invite email/status; founder onboarding writes a new org and its admin membership directly. (`web/lib/org.ts`, `web/app/auth/invite/page.tsx`, `web/app/api/onboarding/route.ts`.)

Lifecycles:

- Login session: created → refreshed while used → expired or deleted on sign-out/revocation. Defaults are a seven-day lifetime and one-day refresh age; a valid five-minute cache may avoid the database in between. (`web/lib/auth.ts`; dependency `dist/context/create-context.mjs`, `dist/api/routes/session.mjs`, `dist/api/routes/sign-out.mjs`.)
- Reset token: created with one-hour expiry → consumed once by a successful password reset; expired or missing tokens fail. (`dist/api/routes/password.mjs`, `dist/utils/password.mjs`.)
- Founder invite: unused (`acceptedAt = null`) → accepted; provisioning failure attempts to restore unused state. (`web/app/api/onboarding/route.ts` POST.)

## How it works

### Host routing, in order

All rows below describe `web/proxy.ts` `proxy`, `isPassthrough` and `config.matcher`. Earlier rules win. Redirects are Next.js default temporary redirects (307); target strings use HTTPS and preserve the port read from `Host`. They do **not** copy the original query string. Rewrites clone `request.nextUrl`, changing only the pathname, so their query remains.

| Host/path condition | Result |
| --- | --- |
| Matcher exclusions: `/_next/static`, `/_next/image`, `/favicon.ico`, `/.well-known/workflow/` prefixes | Proxy does not run. Workflow SDK internal routes remain untouched. |
| Any matched host: path starts `/api` or `/_next`; equals `/robots.txt` or `/sitemap.xml`; or ends in a dot plus one or more ASCII letters/digits | Pass through unchanged, before any session gate. These are prefix/extension checks, not a route existence check. |
| `auth.<base>/` | Redirect to `https://auth.<base>[:port]/sign-in`. |
| Auth host: pathname starts `/auth` | Pass through (even `/authentication` matches this prefix). |
| Auth host: any other path | Rewrite to `/auth<pathname>`; e.g. `/sign-up` → `/auth/sign-up`. |
| Dash host: `/auth` or `/auth/...`, with or without a session cookie | Redirect to auth host with `/auth` stripped; bare `/auth` becomes `/sign-in`. This rule runs before checking the cookie. |
| Dash host: any remaining path without a nonempty session cookie | Redirect to auth-host `/sign-in`. No return path is attached. |
| Dash host with cookie: `/` | Rewrite to `/dash`. |
| Dash host with cookie: `/dash/...` | Redirect to dash host with the redundant `/dash` prefix removed. |
| Dash host with cookie: any other path | Rewrite to `/dash<pathname>`. Bare `/dash` therefore rewrites to `/dash/dash`, unlike `/dash/...`. |
| Any other family subdomain, any remaining path | Pass through to root routes; no cookie gate or rewrite. This includes `www` and multi-label subdomains; the proxy does not validate an org slug. |
| Apex or host outside the family: `/auth/...` | Redirect to auth host with `/auth` stripped. |
| Apex or outside-family host: `/dash` | Redirect to dash-host `/`. |
| Apex or outside-family host: `/dash/...` | Redirect to dash host with `/dash` stripped. |
| Apex or outside-family host: everything else, including bare `/auth` | Redirect to auth-host `/sign-in`. |

The dash gate only checks `Boolean(getSessionCookie(request))`; a stale, forged or expired token can pass this routing gate. Actual session and membership authorization is downstream (`web/lib/org.ts` `currentMembership`, `getTrainerOrg`; `web/lib/trpc.ts` `userFrom`, `studioProcedure`). Never treat a rewrite as successful authentication.

### General sign-in and sign-up

1. Both pages validate the `redirect` query with `safeFamilyRedirect`. An existing session immediately continues to that safe URL, otherwise to `resolveHome()`. A requested destination wins even when the user has no membership. (`web/app/auth/sign-in/page.tsx`, `web/app/auth/sign-up/page.tsx`.)
2. Email sign-in trims the email and sends the password unchanged to `authClient.signIn.email`. Sign-up requires name/email/password/confirmation, trims name, trims and lowercases email, and refuses mismatched passwords before calling `signUp.email`. Password fields have an eight-character HTML minimum; the server default range is 8–128. Errors are displayed and the submit button becomes usable again. Unknown email, no credential password (for example, a Google-only account), or a wrong password returns the same 401 invalid-email-or-password error; having a Google account does not itself create a password. (`web/components/auth/sign-in-form.tsx` `onSubmit`, `web/components/auth/sign-up-form.tsx` `onSubmit`; dependency `dist/context/create-context.mjs`, `dist/api/routes/sign-up.mjs`, `dist/api/routes/sign-in.mjs`.)
3. Better Auth creates the user/password account and normally signs them in on successful sign-up. There is no app-level invite check, role-specific password restriction, or required email verification in this configuration. A duplicate email is refused by the dependency; signing up is not joining an org. (`web/lib/auth.ts`; dependency `dist/api/routes/sign-up.mjs`.)
4. After email success, the form revalidates the requested redirect and uses `window.location.assign` if safe. Otherwise it fetches `/api/me/home` with `cache: "no-store"` and calls `router.push` with the returned destination. Links between sign-in and sign-up carry `redirect` forward. (`web/components/auth/sign-in-form.tsx`, `web/components/auth/sign-up-form.tsx`.)
5. Google appears on these two pages only when **both** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` exist. The button calls `signIn.social({ provider: "google", callbackURL })`, defaulting to the complete current URL. Returning to the same page lets its signed-in redirect logic finish. Errors are shown on the button; thrown client errors get a generic retry message. Google registration is not disabled. (`web/app/auth/sign-in/page.tsx`, `web/app/auth/sign-up/page.tsx`, `web/components/auth/google-sign-in-button.tsx`, `web/lib/auth.ts`.)
6. Google sign-in sets `includeGrantedScopes: false`, so it does not combine login scopes with prior Drive/YouTube connector grants made using the same OAuth client. (`web/lib/auth.ts` `socialProviders.google`.)

### Home choice and identity on organization hosts

- `resolveHome()` returns null if signed out, `/auth/no-org` if there is no enabled membership, dash-host `/` for `admin`/`team`, and the chosen org-host `/` for a learner. Generated family URLs retain the request host's port. `/api/me/home` substitutes `/auth/sign-in` for null. (`web/lib/auth-home.ts` `resolveHome`, `familyOrigin`; `web/app/api/me/home/route.ts` GET.)
- Enabled memberships are read from the database oldest first, excluding `disabledAt != null`. Selection prefers studio roles: pinned studio org, active studio org, oldest studio org; only without studio roles does it use the active learner org or oldest membership. See [Organizations and roles](orgs-and-roles.md) for switching/pinning. (`web/lib/org.ts` `enabledMemberships`, `pickMembership`, `currentMembership`.)
- `resolveSessionUser()` looks up both the session and the organization named by `portalSlug(host)`. A known portal org wins over session membership; otherwise it falls back to current membership. It returns the org, user identity (or null), and a sign-in URL. It does **not** itself prove that the user belongs to, or is enabled in, that portal org. Downstream learner/practice guards own access checks. (`web/lib/session-user.ts` `resolveSessionUser`, `web/lib/base-domain.ts` `portalSlug`; see [Learner portal](learner-portal.md).)
- `/no-org` renders with or without a session. Its title is “No practice session selected”; it tells the visitor to open their trainer's practice link. Signed-in people see their email and a Sign out button; others see Sign in. Switching accounts calls `signOut` first, then navigates; an auth error stays on the page. (`web/app/auth/no-org/page.tsx`, `web/components/auth/switch-account-button.tsx`.)

### Team and learner invite boundary

A studio invite at `/invite?token=<invitation-id>` offers **Google only** when signed out, asking for the invited email. If already signed in with that email (case-insensitive comparison), it offers Accept invitation, regardless of how that session was obtained. A different email gets Switch account, preserving the invite URL. Acceptance goes through Better Auth and then `/api/me/home`; errors stay in the form. The page only displays pending studio invites; invalid/missing/non-pending invites show “Invite required.” It does not pre-check expiry; Better Auth may reject an expired pending invite on acceptance. Learner-role invites redirect to the org home, including old email links. (`web/app/auth/invite/page.tsx`, `web/components/auth/invite-form.tsx`; dependency `dist/plugins/organization/routes/crud-invites.mjs` `acceptInvitation`.)

The org-home Google button returns to that page. Its loader passes the signed-in identity to learner-invite acceptance; that helper does not inspect the login provider. Invitation validation/expiry/acceptance and emails are specified in [Invites and emails](invites-and-emails.md), not here. (`web/components/org/org-home.tsx`, `web/lib/pages/org-home.ts` `loadOrgHome`, `web/lib/invite/accept.ts` `acceptLearnerInvite`.)

### Founder onboarding

1. Operator runs `bun scripts/founder-invite.ts <email>` from `web/`. The script validates email syntax, refuses an already-registered exact email, generates 24 random bytes as a base64url token, inserts an invite and prints `https://auth.<base>/onboarding?t=<token>`. It does not send an email. (`web/scripts/founder-invite.ts`.)
2. `/onboarding` allows any unused founder token, even for someone already running another org. Otherwise, a signed-in enabled admin can resume the connector step for their active admin org, or oldest admin org. Other visitors see “Invite required” and a sign-in link. Token validity is not an authentication requirement to display the new-org form. (`web/app/auth/onboarding/page.tsx`.)
3. New-org form: step 1 collects first/last name and matching passwords of at least eight characters; step 2 collects company name, optional HTTPS website and subdomain. It suggests company/slug from a non-generic email domain or edited company name, and checks availability after 280 ms. It creates the password account **before** posting the workspace request. (`web/components/auth/founder-form.tsx` `inferCompanyFromEmail`, `handleStep1Next`, `handleStep2Next`.)
4. POST `/api/onboarding` requires a session (401), valid body (400), an existing unused token (400), and matching invited email if set (403). It trims company name (1–80), limits website to 2048 characters and HTTPS or empty, lowercases/trims slug, validates it, and returns 409 if taken. `knowledgeConnector` is `none`, `notion` or `youtube`. (`web/app/api/onboarding/route.ts` `bodySchema`, POST; `web/lib/slugs.ts` `validateOrgSlug`.)
5. A database transaction sets `acceptedAt` and creates the org with the signed-in user as `admin`. It then provisions a Chroma database and sets the new org active, so an existing founder opens the new workspace. On failure it attempts Chroma/org cleanup and token restoration, then returns 500 “Could not create the organization.” Cleanup errors are swallowed. (`web/app/api/onboarding/route.ts` POST.)
6. The form posts `knowledgeConnector: "none"` and moves to step 3 after success. It offers optional Notion/YouTube connections according to configured client IDs, starts their connector OAuth routes with `source: "onboarding"`, shows callback notices, and can continue to dash without connecting. Returning enabled admins start at step 3 using stored connection presence. Connector behavior belongs to [Knowledge](knowledge.md). (`web/components/auth/founder-form.tsx` `handleConnect`, `handleGoToDashboard`; `web/app/auth/onboarding/page.tsx`.)
7. API callers may request a connector during provisioning. Success returns `{ redirect, slug }`; a connector-start failure keeps the workspace and returns a dashboard knowledge-page redirect containing an error, rather than rolling back the org. The current form ignores this API redirect and handles connectors separately. (`web/app/api/onboarding/route.ts` POST, `web/components/auth/founder-form.tsx`.)

### Cookies and revocation

`web/lib/auth.ts` enables cross-subdomain cookies with `domain: BASE_DOMAIN`; auth, dash and org hosts share one login. The dependency's `dist/cookies/index.mjs` `createCookieGetter`, `getCookies`, `setSessionCookie` supply these defaults:

| Cookie/setting | Behavior |
| --- | --- |
| Session token | `better-auth.session_token`, or `__Secure-better-auth.session_token` when secure cookies are selected. Signed token; default max age seven days. |
| Session/user cache | `better-auth.session_data`, with the same optional `__Secure-` prefix; five-minute max age here. Default compact format is HMAC-signed, not encrypted. Large cache values may be chunked. |
| Scope/attributes | `Domain=<base>`, `Path=/`, `HttpOnly`, `SameSite=Lax`; `Secure` accompanies the secure prefix. Ports do not separate cookies. |
| Secure selection | Uses configured HTTPS base URL when available; otherwise the dependency's production fallback. `web/.env.example` sets `BETTER_AUTH_URL=https://auth.trainertwin.localhost`; `web/lib/auth.ts` does not override cookie names or secure selection. |

`getSession` verifies the signed token and matching, unexpired cache before returning cached identity; otherwise it queries the session store. App session reads do not generally request `disableCookieCache`. Deleting a DB session therefore does not guarantee every subsequent identity read is immediately anonymous during the cache window. Enabled studio membership is independently checked on every current-membership lookup. (`dist/api/routes/session.mjs`; `web/lib/auth.ts`, `web/lib/org.ts` `currentMembership`.)

Disabling the last enabled membership deletes login sessions; disabling one of several does not. The session-create hook blocks **all login methods** only when memberships exist and every one is disabled, throwing `FORBIDDEN` with “Your access has been disabled. Contact your trainer.” An enabled membership elsewhere permits sign-in but not use of the disabled org. Re-enabling allows sign-in again, without restoring revoked practice access. See [Organizations and roles](orgs-and-roles.md) for disabling, and [Sessions](sessions.md) for terminating calls. (`web/lib/auth.ts` `databaseHooks.session.create.before`, `web/lib/members.ts` `isDisabledUser`, `assertNotDisabledIn`, `setMemberDisabled`.)

### Password reset and account linking

- Reset is available through Better Auth, even though no forgot/reset-password page or sign-in link is implemented in `web/app/auth/` or `web/components/auth/sign-in-form.tsx`. POST `/api/auth/request-password-reset` takes email and optional `redirectTo`. Existing and unknown emails get the same success response. For a known user it creates a one-hour token and calls the app's email hook with the reset URL and user name. (`web/lib/auth.ts` `emailAndPassword.sendResetPassword`; dependency `dist/api/routes/password.mjs` `requestPasswordReset`.)
- GET `/api/auth/reset-password/:token?callbackURL=...` redirects to the supplied callback with `token`, or `error=INVALID_TOKEN`; the callback must be trusted and nonempty to complete that redirect. POST `/api/auth/reset-password` takes `newPassword` and a token in the body or query; invalid/expired/used tokens fail with 400. Password length defaults to 8–128; a successful reset consumes the token and writes a hashed credential password, creating a credential account even for a Google-only user. It does not sign them in. (`dist/api/routes/password.mjs`, `dist/utils/password.mjs` `resetCredentialPassword`.)
- The app does not enable `revokeSessionsOnPasswordReset`; reset does not revoke existing sessions under this dependency default. The disabled-member check still applies when the user next signs in. (`web/lib/auth.ts`; `dist/utils/password.mjs`; `web/lib/members.ts` `isDisabledUser`.)
- `sendPasswordResetEmail` sends “Reset your TrainerTwin password” through the shared email sender. Missing Resend configuration or provider failure is logged and returned as `{ success: false }`; the auth hook awaits but does not inspect that return value, so auth success does not prove delivery. See [Invites and emails](invites-and-emails.md). (`web/lib/email.ts` `sendPasswordResetEmail`, `sendEmail`; `web/lib/auth.ts`.)
- Google is the one configured trusted provider for account linking. In 1.7.15, implicit linking finds the same-email local user but also requires that **local user's** `emailVerified` be true by default. Trusted Google alone does not bypass this. Unverified local users get “account not linked”; a matching verified local user can gain a Google account rather than a second user. Existing Google account ownership is resolved before email matching. (`web/lib/auth.ts` `account.accountLinking`; `dist/oauth2/link-account.mjs` `handleOAuthUserInfo`.)
- Explicit linking also refuses a provider account already belonging to another user and, by default, a different email. No linking UI is present in `web/components/auth/`; the underlying Better Auth endpoint is exposed by the catch-all handler. (`dist/oauth2/link-account.mjs` `linkOAuthAccount`, `dist/api/routes/account.mjs`; `web/app/api/auth/[...all]/route.ts`.)

## Rules

1. General account creation and email/password login are not restricted by org role or invitation. Google login requires both Google credentials to be configured. Team-invite **UI** is Google-only; there is no provider check on an already-signed-in matching invitee. (`web/lib/auth.ts`, `web/components/auth/sign-up-form.tsx`, `web/components/auth/invite-form.tsx`.)
2. A new login session is refused if and only if the user has memberships and all are disabled; one enabled membership or zero memberships passes this hook. The hook is shared by password and social login. (`web/lib/auth.ts` session-create hook, `web/lib/members.ts` `isDisabledUser`.)
3. A routing cookie is not an authorization result. Passthrough paths bypass the dash cookie gate; pages/APIs must validate their own identity/access. (`web/proxy.ts`, `web/lib/org.ts`, `web/lib/trpc.ts`.)
4. `safeFamilyRedirect` accepts only an absolute, parseable HTTPS URL whose hostname is the base domain or ends in `.<base>`. Missing, relative, HTTP, JavaScript and outside-family values return null. It returns the URL's normalized string, retaining port/path/query/fragment; it does not check organization membership or route existence. (`web/lib/base-domain.ts` `safeFamilyRedirect`.)
5. `signInUrl(host, returnPath)` builds an HTTPS auth-host URL retaining the input host's port. It attaches `redirect=https://<host><returnPath>` only when `returnPath` starts `/`. The sign-in page validates the resulting target again. (`web/lib/base-domain.ts` `signInUrl`, `web/app/auth/sign-in/page.tsx`.)
6. Safe requested redirects take priority over home resolution on sign-in/sign-up, both for existing sessions and successful email submissions. Unsafe targets fall back to home. (`web/app/auth/sign-in/page.tsx`, `web/app/auth/sign-up/page.tsx`, both auth forms.)
7. Configured trusted origins are `https://<base>` and `https://*.<base>`. A request's exact `Origin` is also added when `safeFamilyRedirect(origin)` accepts it, allowing local proxy ports. This does not add HTTP or unrelated hosts. Better Auth checks origins and callback URLs; the app does not disable its CSRF/origin protections. (`web/lib/auth.ts` `trustedOrigins`; `dist/api/middlewares/origin-check.mjs`.)
8. Cookie domain is the shared base, not an individual auth/dash/org host. Cookie-cache validity is five minutes; current studio membership is read separately from DB and excludes disabled rows. (`web/lib/auth.ts`, `web/lib/org.ts` `enabledMemberships`, dependency `dist/cookies/index.mjs`.)
9. Built-in organization creation is disabled (`allowUserToCreateOrganization: false`, `organizationLimit: 1`). Founder-token onboarding creates directly through Prisma and can create another org for an existing founder; the plugin limit is not a one-membership restriction. (`web/lib/auth.ts` organization plugin, `web/app/api/onboarding/route.ts` POST.)
10. Onboarding cannot consume a missing/already-used invite or a different email's invite. General sign-up may still have created an account before the workspace request fails. (`web/app/api/onboarding/route.ts` POST, `web/components/auth/founder-form.tsx` `handleStep2Next`.)
11. Password reset tokens are single-use, expire after one hour, and require an 8–128-character new password. Reset does not remove a disabled membership or grant org access. (`dist/api/routes/password.mjs`, `dist/utils/password.mjs`, `web/lib/auth.ts`, `web/lib/members.ts`.)
12. Auth HTTP rate limiting uses Better Auth defaults because the app sets no top-level `rateLimit`: enabled in production, not by default in development; in-memory buckets keyed by client IP and normalized endpoint path. Ordinary auth endpoints allow 100 requests per 10 seconds. Sign-in/sign-up/change-password/change-email prefixes allow 3 per 10 seconds; request-password-reset/send-verification-email and legacy forget-password paths allow 3 per 60 seconds. Exceeding the chosen limit returns 429 and `X-Retry-After`. Missing a resolvable client IP uses one shared per-path bucket and logs a warning. These are not one global per-account bucket. (`web/lib/auth.ts`; `dist/context/create-context.mjs`, `dist/api/rate-limiter/index.mjs` `getDefaultSpecialRules`, `resolveRateLimitConfig`, `rateLimitResponse`.)
13. The API-key plugin's explicit 120 requests per 60,000 ms is separate from browser sign-in throttling. API-key permissions and limits belong to [Public API](public-api.md). (`web/lib/auth.ts` `apiKey`.)

## Entry points

| Entry | Source / purpose |
| --- | --- |
| Auth-host GET `/sign-in?redirect=...`, `/sign-up?redirect=...` | `web/app/auth/sign-in/page.tsx`, `web/app/auth/sign-up/page.tsx`; internally `/auth/...`. |
| Auth-host GET `/onboarding?t=...` (also connector callback notice query), `/no-org` | `web/app/auth/onboarding/page.tsx`, `web/app/auth/no-org/page.tsx`. |
| Auth-host GET `/invite?token=...` | `web/app/auth/invite/page.tsx`; Google studio-invite handoff; learner invites go to org home. See [Invites and emails](invites-and-emails.md). |
| Every matched page request | `web/proxy.ts` `proxy`, `config.matcher`; routing table above is exhaustive. |
| GET/POST `/api/auth/[...all]` | `web/app/api/auth/[...all]/route.ts` `toNextJsHandler(auth)` exposes Better Auth routes; `web/lib/auth-client.ts` creates the React client with organization roles. |
| POST `/api/auth/sign-in/email`, `/sign-up/email`, `/sign-in/social`; GET/POST `/api/auth/callback/google` | Better Auth `dist/api/routes/sign-in.mjs`, `sign-up.mjs`, `callback.mjs`, via catch-all. Social sign-in starts authorization; callback finishes it. |
| GET `/api/auth/get-session`; POST `/api/auth/sign-out` | Better Auth `dist/api/routes/session.mjs`, `sign-out.mjs`; current login and logout. |
| POST `/api/auth/request-password-reset`; GET `/api/auth/reset-password/:token`; POST `/api/auth/reset-password` | Better Auth `dist/api/routes/password.mjs`; email request, callback and password write. No corresponding application reset form. |
| POST `/api/auth/link-social` | Better Auth `dist/api/routes/account.mjs`; explicit provider linking, no app auth UI. |
| GET `/api/me/home` | `web/app/api/me/home/route.ts`; `{ redirect }` for forms/invite acceptance. |
| GET `/api/onboarding?slug=...`; POST `/api/onboarding` | `web/app/api/onboarding/route.ts`; public slug availability and authenticated founder provisioning. |
| POST `/api/connectors/notion/oauth/start`, `/api/connectors/youtube/oauth/start` | Invoked by `web/components/auth/founder-form.tsx` `handleConnect`; see [Knowledge](knowledge.md). |
| `bun scripts/founder-invite.ts <email>` | `web/scripts/founder-invite.ts`; creates token and prints onboarding URL. |
| Password reset email | `web/lib/auth.ts` hook → `web/lib/email.ts` `sendPasswordResetEmail`; other auth/invite emails: [Invites and emails](invites-and-emails.md). |

No auth-specific tRPC procedure, cron or webhook is defined here. App tRPC authorization consumes the session/membership through `web/lib/trpc.ts`; learner page queries use public procedures and resolve identity separately (`web/lib/pages/router.ts`).

## Talks to

- **Better Auth + PostgreSQL/Prisma:** user/accounts, login sessions, reset verification and organization plugin endpoints. The app supplies role definitions, disabled-member checks, shared cookie domain, Google configuration and email callbacks. (`web/lib/auth.ts`, `web/lib/auth-roles.ts`, `web/prisma/schema.prisma`.)
- **Google OAuth:** supplies identity/account tokens; login does not import connector content or reuse all previously granted connector scopes. (`web/lib/auth.ts` `socialProviders`; see [Knowledge](knowledge.md).)
- **Organizations and roles:** auth hands over a user and active org ID; org helpers return enabled membership/role for home and authorization. Identity alone is insufficient. (`web/lib/auth-home.ts`, `web/lib/org.ts`, `web/lib/trpc.ts`; see [Organizations and roles](orgs-and-roles.md).)
- **Invites and emails / Resend:** auth passes invitation/reset identity and URL into email hooks; invite pages hand acceptance to Better Auth. (`web/lib/auth.ts`, `web/lib/email.ts`, `web/components/auth/invite-form.tsx`; see [Invites and emails](invites-and-emails.md).)
- **Learner portal / practice:** auth preserves a safe return URL and supplies user identity plus host-derived org; practice authorization and joining happen outside auth. (`web/lib/base-domain.ts`, `web/lib/session-user.ts`; see [Learner portal](learner-portal.md), [Twins](twins.md), [Role plays](roleplays.md).)
- **Chroma and connector onboarding:** new-org creation provisions the org's Chroma database, and optionally starts Notion/YouTube authorization. (`web/app/api/onboarding/route.ts`, `web/components/auth/founder-form.tsx`; see [Knowledge](knowledge.md).)

## Edge cases and limits

- Host parsing splits `Host` at `:` and uses its first port segment; this is designed for domain names, not IPv6 literal hosts. `portalSlug` takes only the first dot-separated label, whereas proxy family routing can recognize multi-label subdomains. (`web/proxy.ts`, `web/lib/base-domain.ts`, `web/lib/auth-home.ts` `familyOrigin`.)
- All family URLs generated here use HTTPS, including localhost. A plain HTTP development host is not made trusted by these helpers. An outside-family host follows the apex routing branch, rather than serving a separate preview UI. (`web/proxy.ts`, `web/lib/base-domain.ts`, `web/lib/auth.ts`.)
- Query strings survive rewrites, but are lost on the proxy's string-built redirects. For example, apex `/auth/sign-in?redirect=...` loses the requested destination on the handoff. A cookie-less dash redirect also loses the originally requested page. (`web/proxy.ts`.)
- `safeFamilyRedirect` permits any port and any nested family hostname. It does not reject URL user-info or restrict paths; HTTPS family membership is its complete check. (`web/lib/base-domain.ts`.)
- A disabled member can remain recognizable from a valid cache until expiry. `resolveSessionUser` is only an identity resolver; disabled-org denial must occur at the downstream access boundary. (`web/lib/session-user.ts`, `web/lib/auth.ts`, `web/lib/members.ts` `assertNotDisabledIn`; dependency `dist/api/routes/session.mjs`.)
- Without Google configuration, general forms hide Google, but the studio-invite and org-home Google buttons are still rendered. Those components do not receive a `googleEnabled` flag. (`web/app/auth/sign-in/page.tsx`, `web/components/auth/invite-form.tsx`, `web/components/org/org-home.tsx`.)
- Auth throttles are process-local memory, not a shared limit across server instances; no custom onboarding availability/provisioning throttle is defined. (`web/lib/auth.ts`, `web/app/api/onboarding/route.ts`; dependency `dist/context/create-context.mjs`.)
- The founder form marks `accountCreated` before workspace provisioning succeeds. Retrying step 2 in that component then skips both account creation and the POST and moves to step 3. An account can be left with no org after a failed workspace request. (`web/components/auth/founder-form.tsx` `handleStep2Next`.)
- Founder consumption checks `acceptedAt` before the transaction and updates by token without an unused-state condition. Single-use behavior is not a demonstrated concurrency guarantee for simultaneous requests. Cleanup also runs after the organization transaction has committed. (`web/app/api/onboarding/route.ts` POST.)

## Mismatches

- “Invite-only platform” in `web/lib/auth.ts` and the `FounderInvite` schema comment applies to **organization creation**, not account registration: `/sign-up` and Google new-user sign-in are open. `PRODUCT.md` describes the trainer creation workflow but does not specify an auth-method or signup policy. (`web/components/auth/sign-up-form.tsx`, `web/lib/auth.ts`; dependency `dist/api/routes/sign-up.mjs`, `dist/oauth2/link-account.mjs`.)
- Comments describe studio/learner invites as Google sign-in flows, and `docs/guides/users.mdx` describes Google on the org home. This matches the signed-out UI, not a server-enforced Google-only membership rule. An existing matching password session reaches studio Accept invitation; learner acceptance does not inspect provider. (`web/app/auth/invite/page.tsx`, `web/components/auth/invite-form.tsx`, `web/lib/invite/accept.ts`.)
- The auth hook comment says disabled members cannot sign in “any method” and disabling deletes their sessions. Actual behavior is narrower: both restrictions apply only when **all** memberships are disabled. `plans/prod-release-v2.md` §2A similarly summarizes disabling as signing the learner out. (`web/lib/auth.ts` comment versus `web/lib/members.ts` `isDisabledUser`, `setMemberDisabled`.)
- `plans/twin-share-link.md` says the proxy rewrites org hosts to the org route group. Actual proxy behavior is pass-through: root routes already live in that group. The plan's sign-in/sign-up return-URL intent is implemented by the general auth pages/helpers. (`web/proxy.ts`, `web/lib/base-domain.ts`, both sign-in/sign-up pages.)
- `plans/twin-roleplay-db-split.md` §13 calls for learner membership on first sign-in through a link. Auth has no such sign-in hook; org-home invite acceptance or later practice access paths perform membership work. Signing in directly may land on no-org. (`web/lib/auth.ts`, `web/lib/auth-home.ts`, `web/lib/invite/accept.ts`; see [Learner portal](learner-portal.md).)
- Onboarding promises a 3–30-character slug, but `validateOrgSlug`'s optional regex group accepts a single alphanumeric character too. The form blocks fewer than three; API validation/availability can accept one. (`web/lib/slugs.ts`, `web/components/auth/founder-form.tsx`, `web/app/api/onboarding/route.ts`.)
- Onboarding page/API explicitly allow another org for an existing founder, but the invite script rejects existing registered emails and the form unconditionally attempts password sign-up for a new org. The API supports more than the normal script/form path can complete. (`web/app/auth/onboarding/page.tsx`, `web/app/api/onboarding/route.ts`, `web/scripts/founder-invite.ts`, `web/components/auth/founder-form.tsx`.)

## Open questions

- Is “team invites are Google-only” meant as a UI choice or a hard access rule? The invite page says Google, but the accept button only checks email, and `web/lib/auth.ts` has no provider restriction on acceptance. (`web/components/auth/invite-form.tsx`, `web/lib/auth.ts`.)
- Should a password-created user be able to switch immediately to Google? The app trusts Google but does not enable local email verification, while Better Auth 1.7.15 implicit linking requires a verified local email by default. No app linking screen resolves this. (`web/lib/auth.ts`, `web/components/auth/sign-up-form.tsx`; dependency `dist/oauth2/link-account.mjs` `handleOAuthUserInfo`.)
- What is the supported reset-password destination? The server sends reset links, but there is no application page to collect the new password, nor a forgot-password link. Should resetting revoke other login sessions? It currently does not. (`web/lib/auth.ts`, `web/lib/email.ts` `sendPasswordResetEmail`, `web/app/auth/`, `web/components/auth/sign-in-form.tsx`; dependency `dist/utils/password.mjs`.)
- Should founder provisioning support existing users end to end and retry the workspace POST after account creation? The server accepts existing sessions, but the script/form and retry state disagree. Should invite consumption also be conditional inside the transaction? (`web/scripts/founder-invite.ts`, `web/components/auth/founder-form.tsx` `handleStep2Next`, `web/app/api/onboarding/route.ts` POST.)

## Tests today

| Layer | Existing coverage |
| --- | --- |
| Unit/routing | `web/tests/proxy.test.ts`: stale-cookie dash `/auth` handoff, no-cookie dash redirect, cookie-bearing root, auth rewrite, apex handoff and API bypass. Some tests check only absence of a redirect, not the rewrite target. |
| Unit/helpers | `web/tests/lib/base-domain.test.ts`: family redirect acceptance/attacker rejection and practice return link; `web/scripts/session-user-check.mjs`: basic slug extraction and local-port sign-in URL. |
| Unit/membership | `web/tests/lib/members.test.ts`: all-disabled versus other-enabled and no-membership cases, conditional login-session deletion, re-enable and disabled-org denial. These mock storage; they do not test the Better Auth session-create hook over HTTP. `web/tests/lib/org-membership.test.ts`: pinned/active/oldest membership order and studio preference. |
| DB boundary | `web/tests/lib/invite/accept.db.test.ts`: pending learner invite lookup, existing member/expired/used/studio invite exclusions, graceful failure. Database-backed but mocks `auth.api.acceptInvitation`; not an OAuth test. `web/tests/sql/org-roles.sql`: adjacent membership role constraints. |
| Flows | `web/tests/flows/trainer-credits.flow.test.ts`: obtains a real Better Auth password session and passes cookies into invitation/credit flows. Not a sign-up, OAuth or host-routing flow. |
| Browser | `web/e2e/seed.setup.ts` signs fixtures in through the password API and writes shared-domain cookies for other browser suites; its comment explicitly says it bypasses auth pages because the test server does not serve the HTTPS auth host. No dedicated auth-page/Google browser suite. |
| Python | None for browser authentication; `agent/tests` and `chat/tests` cover other runtimes, not these auth pages. |

Most important gaps: the full proxy matrix (rewrite targets, query loss, ports, bare prefixes, outside-family hosts); actual cross-host cookie issuance/cache expiry and revocation; password/Google sign-up and provider linking; trusted-origin rejection and production throttles; reset token expiry/reuse/delivery failure; disabled-user HTTP login for each method; and founder provisioning, rollback, retries and concurrent token consumption. No dedicated tests for `resolveHome`, `resolveSessionUser` or the no-org/onboarding pages were found in `web/tests` or `web/e2e`.
