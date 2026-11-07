# Shareable twin links: /t/[username] and /t/[slug]

Goal: readable links a trainer can post anywhere.

- Main twin (all skills): `https://acme.trainertwin.com/t/olga` (username)
- Skill twin: `https://acme.trainertwin.com/t/acme-off-plan` (twin slug)

Whoever opens one signs in (or signs up), gets their own minutes, and talks to the twin.
Today Share copies `https://acme.trainertwin.com/s/<random code>`.

## What already works (verified 28 Oct)

- `TwinShareLink` (code, minutesPerUser, status active | disabled) + `twinAccessByCode`: the first session start
  through a link creates the person's own `TwinAssignment` with the link's minutes; reopening reuses it, never adds
  minutes; a disabled link refuses new joins (people who joined keep theirs); other-org people are refused (org lock).
- `/s/[code]` serves twin links (`TwinSession`), redirects to sign-in with a return URL; sign-up keeps it; pre-join
  uploads and session start already accept the link code.
- The all-skills twin pins its skills at each session start (`pinTwinSkills`).
- No links exist locally yet: nobody has opened one end to end.

## URL design (no new table or column)

- **username = the trainer's own persona slug.** The main twin is built from the trainer's own persona
  (`Persona.isOwn`, slug `olga`, unique per org). `/t/olga` → that persona → its all-skills twin
  (`Agent.data.source = "twin"`).
- **slug = the twin agent's slug** (`acme-off-plan`, `acme-olga-twin`): kind TWIN in this org.
- **Order:** own-persona slug first, then twin slug. They can't clash today: agent slugs are org-prefixed
  (`acme-…`), persona slugs aren't (`olga`). Org scoping comes from the subdomain, like `/s`.
- **Access still goes through the twin's `TwinShareLink`:** `/t/...` finds the twin, then its active link, and runs
  the same flow as `/s/<code>` (same TwinSession screen, same join, same minutes). The code stays internal.
- **Link off or never created → the page says the twin isn't available** (same card as `/s` today). A readable URL
  is guessable, so a twin is reachable only after the trainer turns sharing on in the dialog; that's the guard
  against anyone who guesses `/t/olga` using minutes.
- **`/s/<code>` keeps working:** personal invite emails (per-person codes) and links already copied.
- `/t/vasanth` has no main twin yet (only a skill twin) → not available until his all-skills twin exists.

## Plan

### 1. Learner route `app/(org)/t/[slug]/page.tsx`

- Same shape as `/s/[code]`: signed out → sign-in with `/t/<slug>` as return URL; resolve org from subdomain.
- `resolveTwinLink(orgId, slug)` in lib/twin-access.ts: own-persona slug → all-skills twin, else twin agent slug;
  then its active share link. Returns the link code (or why it's unavailable).
- Render the existing `TwinSession` with that code; reuse the `/s` "not available" card for errors.
- Extract `TwinSession` from `/s/[code]/page.tsx` into a shared component so both routes use one.
- The proxy already rewrites `<org>.<base>/*` to the `(org)` group; confirm `/t/*` is not caught by another rule.

### 2. Share URL

- `twinShareUrl(orgSlug, twin)`: main twin → `/t/<persona slug>`, skill twin → `/t/<agent slug>`.
  Used by the share dialog (and the copy action it replaces).

### 3. Share dialog (the only new UI), exactly the reference `botShareDialog`

Opened from **Share** in the menus on the twin cards (`/twin`) and the twin detail header (`/twin/[id]`),
replacing the current silent copy. Reference measurements (trainertwin-beta app.css `.confirm-*`, `.share-*`, `.bot-*`):

- Dialog 520px wide (max 100vw − 32px), backdrop `rgb(11 10 9 / 0.55)`.
- Card: padding 24px, gap 20px, 4px border in the surface colour, 24px radius,
  gradient sunken → surface (top to bottom), shadow `0 4px 8px rgb(30 28 25 / 0.2)`.
- Icon tile: 2px gradient ring (border → surface), inner 12px padding, 4px surface border, 16px radius,
  sunken → surface gradient, same shadow + inset `0 0 4px rgb(30 28 25 / 0.05)`; 20px share glyph (reference SVG).
- Close: ghost 32px icon button, top/right 12px.
- Title **Share {twin name}**: 20px / 28px semibold. Subtitle 14px / 20px, secondary text:
  main twin "Send this link to your learners so they can talk to your twin.",
  skill twin "Send this link to your learners so they can ask the bot."
- **Distribution link** label, then a row (gap 8px): read-only input (fills the row) + **Copy link** secondary pill
  (min 128px, regular weight, 16px copy icon). After copying: check icon + **Copied** in the brand colour.

Built on the house Dialog component (focus trap, Esc, backdrop click) with these styles; colours from the existing
tokens (sunken = `--sidebar`, surface = `--card`), so dark mode matches the screenshot. Opening the dialog fetches the
link (creating it the first time, as Share does today); while it loads the field shows a quiet placeholder, no error text.

### 4. tRPC `shareLink` router (replaces `agents.shareLink`)

- `get({ slug })`: url, minutes, status, joined count, or null. Creates nothing.
- `create({ slug, minutesPerUser })`, `update({ slug, minutesPerUser?, status? })`.
- Reuse `createTwinShareLink` / `setTwinShareLinkStatus`; add `updateTwinShareLinkMinutes`. studioProcedure, org-scoped.
  One link per twin in the UI; the REST route `/api/twins/[slug]/share-links` stays.

### 5. Checks

- Unit: `resolveTwinLink` (username → main twin, slug → skill twin, username wins, other org / role play / unknown /
  link off → unavailable); share-link procedures (get creates nothing, minutes affect only new joins, off/on,
  learners refused).
- Walk it once locally and on a Vercel preview as a person with no account: `/t/olga` → sign up → back → pre-join →
  talk (all skills) → minutes counted → shows in Twin sessions and Twin users. Same for a skill twin `/t/<slug>`.
- Typecheck, full suite (same pre-existing failures), build.

## Decisions needed

1. **Minutes and sharing on/off are not in the reference dialog.** Proposal: keep the dialog exactly as the
   reference; links keep the default 30 minutes per person (as Share does today). If you want them adjustable, they
   go on the twin's configure page ("Shared link: minutes per person, on/off"), not in the dialog. Without an off
   switch, a posted `/t/olga` can only be closed through the REST route.
2. **Skill twin URLs:** `/t/acme-off-plan` (the agent slug as stored) or a shorter `/t/off-plan` (strip the
   org prefix when resolving)? The short form needs no column either; proposal: accept both, share the short one.
3. **Username source:** the own persona's slug (`olga`) as proposed. Fine, or do you want it editable on the
   twin's configure page? (Editable = rename the persona slug, which other links/specs reference; not proposed.)

## Not in scope

Access without an account, link expiry dates, per-person link analytics, renaming usernames.
