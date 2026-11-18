# Shared skills for twins and role plays

Status: implementation authorized, 19 Nov 2026. Production operations remain unapproved.
Grounded in the `v3` checkout at `659e99c`. Recheck the implementation and branch tip before starting each phase.

## Execution ledger — resume here

Working checkout: `application-v3`, branch `feat/shared-skills` from `origin/v3` at `659e99c`.
The old checkout's `application/AGENTS.md` is not applicable after moving this session to this worktree.
The durable plan is this file; do not delete it as a temporary planning artifact.

| Phase | Implementation | Verification / release |
| --- | --- | --- |
| 1 — Registry + publisher | Complete implementation/local verification | Live comparison deferred until all phases; not deployed |
| 2 — Role-play runtime | Complete implementation/local verification | Exact pins, strict retrieval and recovery verified; live checks deferred |
| 3 — Twin runtime | Not started | Next implementation phase |
| 4 — Existing-data migration | Not started | Production execution needs explicit approval |
| 5 — Sole package ownership | Not started | Blocked on verified migration coverage and canary |

Current checkpoint: registry/publisher and managed role-play runtime adoption are implemented. New managed role-play
sessions pin exact packages; twins and null-marker sessions retain compatibility readers. No production credentials,
data, migrations or deployments were used.
Broad legacy runtime tests attempted AI Gateway requests with test-placeholder credentials and received 401; those
are not successful live-provider tests.

Implementation decisions:

- Immutable package files include SKILL.md, the original-format manifest, items.json and optional patterns.md.
  changes.json is provenance-only and does not force a content version.
- Phase 1 retains original-byte file strings in SkillVersion.files as a durable retry/verification envelope, alongside
  S3 copies. Runtime text/manifest are stored projections; none of these are independently editable.
- Package hashes include format, sorted filenames and exact file strings, not operational generation/attempt fields.
- Separate external namespaces prevent failed/superseded publishers overwriting a published package.
- Review changed Phase 1 sequencing: while Agent-version compatibility indexes remain in use, provider writes stay
  inside the existing bounded `agent:<slug>` finalization transaction. Otherwise an in-flight upload can collide with
  a settings writer's next Agent version. Move provider work outside this lock only after managed runtime adoption
  removes that collision. This is deliberate preservation of the existing lock, not a claim that the split is shipped.
- Pending requests share a generation only if package AND full experience-publication intent match (including persona,
  scoring and provenance). A true ready no-op is returned during reservation without advancing/cancelling another attempt.
- Fresh version state is read under the final lock before external writes; a duplicate cannot rewrite a now-ready
  namespace. Finalization's idempotent shortcut is also generation-qualified.
- SQL timeout does not cancel in-flight JavaScript/provider work. Every physical finalization therefore writes into
  a fresh `vN/attempt-<uuid>` S3/index namespace; its artifact pointer commits only together with readiness. A timed-out
  callback can finish only in its abandoned namespace. Retry preserves SkillVersion identity, not physical attempt path.
  Canonical Chroma scope is `(skillVersionId, skillIndexScope)`; indexScope is the ready version's artifacts prefix.
  Future readers MUST filter both; version ID alone can include abandoned attempts.
- Agent compatibility versions remain monotonically increasing but may have gaps after failed/superseded reservations.
  Do not interpret a missing number as missing published history. Skill version and Agent version are not interchangeable.
- Identical concurrent pending publication may share an attempt only when its recorded generation still owns the skill.
- Concurrent settings/archive changes during upload cause a retryable publication refusal rather than stale restoration.
- Installation: `bun install --frozen-lockfile` completed in web; generated Prisma client is ignored/uncommitted.
- Test DB target is the new local-only `trainertwin_shared_skills_test`; existing dev/test DBs must not be reset.
  Its TCP policy rejects connections; use `?host=/tmp` in the URL to connect through the local Unix socket.

Before leaving any checkpoint: update phase statuses, exact commands/results, commit IDs, known failures and next action
here. Do not mark live voice/external-service checks passed based on boundary-mocked tests.

### Phase 1 verification — 19 Nov 2026

Use `DATABASE_URL='postgresql://surya@localhost:5432/trainertwin_shared_skills_test?host=/tmp'` from `web/`.

| Check | Result |
| --- | --- |
| Fresh isolated DB migrations | All baseline migrations + both shared-skill migrations applied successfully |
| `bun test --parallel .db.test` | **780 pass, 0 fail** (44 files); real Postgres, provider boundaries replaced where appropriate |
| Focused web suites listed below | **101 pass, 0 fail** (12 files) |
| `bun test --parallel tests/flows` | **150 pass, 0 fail** (9 files); controlled external services, not real payment/provider checks |
| `cd ../chat && bun test tests` | **125 pass, 0 fail** (19 files); chat source unchanged |
| `bunx tsc --noEmit` | Pass |
| ESLint on changed application/test files | Pass; `specs.ts` separately has 3 existing unused-import warnings |
| Local `bun run build` | Pass after the framework's advisory acknowledgment; Next security issue remains unresolved |
| Independent read-only publisher review | Concurrency/timeout findings addressed; no remaining introduced managed-publication blocker reported |
| Real S3/Chroma/LiveKit voice canary | **Not run**; isolated provider/voice environment is not configured in this worktree |
| Production-data migration rehearsal / production release | **Not run / not authorized** |

Focused suites:

```sh
bun test --parallel tests/api/skills.test.ts tests/api/route-guards.test.ts \
  tests/lib/shared-skill-files.test.ts tests/lib/scenario-item-versions.test.ts \
  tests/lib/scenario-ingest.test.ts tests/lib/scenario-ingest-contract.test.ts \
  tests/lib/twin-avatar.test.ts tests/lib/copilot-studio.test.ts tests/lib/skill-sources.test.ts \
  tests/lib/roleplay-skill.test.ts tests/lib/runnable-agent.test.ts tests/lib/twin-playbooks.test.ts
```

For the local build, also set a disposable BETTER_AUTH_SECRET and BETTER_AUTH_URL=http://localhost:3000.
Do not copy a production secret. The build-generated `next-env.d.ts` route imports were restored to the baseline.

Broad unit command was attempted, not declared green: with a minimal local seed it returned **1124 pass / 6 fail**.
Failures were two existing PDF-surface assertions, live-model-dependent document/deictic expectations with placeholder
credentials, and a legacy snapshot test using the old agent-token contract. The empty unseeded DB initially caused
additional seed-dependent setup failures. A no-DATABASE_URL run also fails existing env validation and is not a useful
offline-test recipe. Do not weaken these tests or silently count them as passing.

The important new regression uses a real 100ms transaction timeout: an old provider callback resumes after a retry is
ready, but can write only to its abandoned S3 and Chroma physical scopes. It cannot change the winner's files,
provenance, artifact pointer or readiness. Ordinary identical/different-intent races and settings serialization are
tested separately.

### Next action / completion boundary

1. Phase 1 code/local-test checkpoint: **`0d974e0`**, `feat(skills): add managed package registry and publisher`.
   Local branch only; not pushed, no PR opened. This ledger update follows in a documentation-only commit.
2. Owner clarified the gates on 19 Nov: each phase must compile and pass local behavioral/integration checks. Real
   provider/voice comparison is deferred until ALL phases are implemented; it does not block the next implementation
   phase. Existing canary/release checklists remain deferred release evidence, not completed checks.
3. Phase 2 is complete locally; see its checkpoint below. Next implement Phase 3 twin session pinning and runtime
   adoption. Keep a separate commit and local verification record for each phase.
4. Keep Phase 1's existing bounded publication lock until exact managed runtime adoption makes compatibility indexing
   safe to separate. Legacy fallback and failed compatibility-index orphan behavior are not fixed by this checkpoint.

### Phase 2 checkpoint — 19 Nov 2026

Implemented:

- Additive `SessionSkill` pins and nullable `InterviewSession.skillPinsVersion` marker. Null explicitly means legacy;
  existing sessions are not retroactively repinned. Managed role-play activation captures package, Agent settings,
  persona and scoring together. Resume retains the existing session and pin.
- PostgreSQL guards enforce org/format/readiness, pin completeness and immutable managed identity/snapshot sections.
  Attachment metadata remains mutable. Cascading parent-session deletion still works.
- Lightweight runtime projections exclude package files/transcript and avoid per-turn S3 reads or package hashing.
  Cache v2 validates pins before using cached context. Unknown/wrong-org/wrong-agent sessions refuse explicitly.
- Managed example retrieval uses both version ID and committed artifact scope, checks expected cardinality, and
  broadens a step miss only within those pins. Missing/partial indexes return 503, never another package's examples.
  Builder/authored formats and their client/trainer roles remain distinct.
- Index recovery verifies original S3 bytes, rebuilds the same immutable package, and fences state updates with
  `indexGeneration` CAS. A stale recovery cannot downgrade a newer recovery. CLI requires explicit `--apply`;
  remote-database operation additionally requires `--production`. No remote operation was run.

Concurrency decision: managed activation uses Agent `FOR KEY SHARE`, not `FOR SHARE`. Publisher non-key Agent updates
must proceed to avoid the Skill→Agent / Agent→Skill lock cycle. The exact package is resolved from the captured
`primarySkillId` and artifact pointer, not mutable `currentVersionId`.

Local migration `20261119130000_session_skill_pins` was applied only to `trainertwin_shared_skills_test`.
Use the same socket DATABASE_URL as Phase 1 for the following commands, from `web/`:

| Check | Result |
| --- | --- |
| `bun test --parallel .db.test` | **804 pass, 0 fail**, 46 files |
| Phase 1 focused command above plus `tests/lib/roleplay-report.test.ts tests/lib/interview-sessions.test.ts` | **113 pass, 0 fail**, 14 files |
| `bun test --parallel tests/flows` | **150 pass, 0 fail**, 9 files |
| `bun test tests` from `chat/` | **125 pass, 0 fail**, 19 files |
| TypeScript / ESLint on touched files | Pass; same 3 existing unused-import warnings in `specs.ts` |
| `bun run build` with disposable local Better Auth configuration | Pass on retry; existing Next.js security advisory remains unresolved |

The new session-pin suite contributes 19 tests / 106 assertions, including publication during activation, successive
publications preserving old context/search/scoring, resume, archive, unavailable indexes, immutable snapshots and
permitted attachment updates. Recovery tests cover corrupted S3, provider retry and stale worker failure.

Verification gotchas:

- The SQL twin-access fixture now runs deferred constraints before disabling triggers. Without that, PostgreSQL
  correctly refuses ALTER TABLE with pending trigger events; the fix preserves the new invariant checks.
- One full run concurrent with the flow suite hit a billing mock's unexpected Meteroid subscription request. A fresh
  standalone full DB run passed all 804 tests. Do not treat the transient run as green or weaken billing assertions.
- Chroma `count()` cannot filter metadata in this SDK. Exact scope cardinality uses paginated ID-only reads (300/page).
  Measure this overhead in final performance/live testing after all implementation phases.
- The broad legacy unit failures recorded under Phase 1 remain outside this checkpoint; no claim that suite is green.
- Build-generated `next-env.d.ts` imports were restored to baseline. No dependency/security upgrade was included.

Resume: inspect `git log` for `feat(skills): pin managed roleplay session packages` (Phase 2 local checkpoint), then
implement Phase 3 from the detailed phase section below. Phases 3–5 and final real-provider/voice comparison remain
unimplemented/unrun. No push, production migration, data backfill or deployment is authorized by this checkpoint.

## Goal

Give published skill packages their own identity and lifecycle. Twins and role plays reference those packages rather
than owning separate copies of storage, indexing and version-management logic.

Every phase must be a usable release. If work stops after a phase, trainers can still author, publish and run calls.
An empty schema, an unconnected API, or a partially migrated runtime is not a phase.

This establishes a consistent data/backend foundation, not a UI redesign or identical conversation behavior.

## The billing precedent

Reviewed:

- [PR #15](https://github.com/fl-dev-ops/trainer-twin-studio/pull/15): working org credits and spending through Meteroid,
  with Razorpay disabled. It delivered value without online payments.
- [PR #18](https://github.com/fl-dev-ops/trainer-twin-studio/pull/18): billing phases 2 and 3.
  Phase 2 made plans, invoices and packs work with payments recorded by hand; phase 3 automated collection through
  Razorpay without replacing the invoice/credit foundation. These phases ultimately shipped together.
- `plans/phase1-release.md`, `plans/billing-phase-2.md`, `plans/billing-phase-3.md`.

Apply the same pattern: ship a useful shared foundation first, adopt it for each experience, migrate existing data,
then retire the old representation. Do not make a large rewrite the prerequisite for the first working release.

## What exists today

| Concern | Current implementation |
| --- | --- |
| Twin / role-play identity | Both are `Agent` rows, distinguished by immutable `kind`; `web/prisma/schema.prisma` |
| Package publishing | `storeSkillAgent` in `web/lib/scenario-ingest.ts` already shares S3, Chroma and DB writes |
| Skill content and manifest | `Agent.data.skill`, `.scenario`, `.artifacts`, `.filesHash`; previous data in `SpecVersion` |
| S3 files | Versioned `SKILL.md`, `skill.json` or `scenario.json`, `items.json`, optional evidence/change files |
| Examples | Org main Chroma collection; `scenario_item` entries scoped by `agentSlug` + `agentVersion` |
| Source provenance | `SkillSource`, keyed by agent/version/document; `web/lib/skill-sources.ts` |
| Single-skill sessions | Agent/persona snapshots in `InterviewSession.compiledSnapshot`; `web/lib/interview-sessions.ts` |
| Main-twin skill selection | Live skill agents of the same org/persona, pinned as slug/version; `web/lib/twins.ts` |
| Runtime reads | `web/lib/session-context.ts`, studio `searchScenarioItems` action, `chat/agent/lib/brain.ts` |
| Skill history reads | Copilot `readSkill` path in `web/lib/copilot-studio.ts` reads Agent/SpecVersion and S3 |

Important existing behavior:

- Agent versions currently mix package changes and some experience/persona/settings changes. They cannot simply become
  skill version numbers.
- Main twins aggregate skills; they do not have a single SKILL.md of their own.
- Builder role plays use client/learner examples and fixed client rules. Authored role plays use their published
  procedure and trainer/learner examples. Twins have both current and legacy manifest shapes.
- Chroma prunes older than the current and previous Agent version. A missing pinned version may fall back to examples
  from other retained versions of the same agent. The new model must not promise exact pins while retaining this behavior.
- Publication currently holds `agent:<slug>` while writing external artifacts. External writes are not rolled back if
  the DB transaction fails. Reuse the existing entry point, but explicitly address these publication boundaries.

## Proposed ownership and model

Keep `Agent` as the experience record. Do not create separate Twin/Roleplay tables in this project.

```text
Agent (TWIN or ROLEPLAY)
  persona, access, before/tools/after settings, existing identity/version
       |
       +-- primarySkillId --> Skill
                                |
                                +-- currentVersionId --> SkillVersion
                                                          |
                                                          +-- S3 package
                                                          +-- Chroma index scope
                                                          +-- source provenance

Main twin --> existing same-persona skill selection --> several Skills
Session   --> SessionSkill pins --> exact SkillVersions
```

### Initial tables and fields

Names are proposed; the implementation rule spec must settle exact columns, constraints and refusal contracts.

| Record | Responsibility |
| --- | --- |
| `Skill` | Stable ID, required org ownership, name, timestamps, nullable current-ready-version reference |
| `SkillVersion` | Skill ID, monotonic package version, format discriminator, lifecycle state, package hash, immutable skill text/manifest, S3 file references, index scope and expected item count |
| `Agent.primarySkillId` | Optional reference for a skill-bearing Agent. Main twins and no-skill legacy interviews need no primary skill |
| `SessionSkill` | Introduced with runtime adoption: session ID, skill-version ID, stable lookup alias and ordering; supports one or many pins |
| Source references | Move provenance ownership to SkillVersion during migration; preserve saved titles for deleted documents |

Constraints:

- Unique `(skillId, version)`; currentVersion must belong to the same Skill and be ready.
- Agent/Skill links, session pins and source references cannot cross organizations.
- Initially one Skill per skill-bearing Agent. No cross-agent sharing/editor is introduced; do not accidentally bind
  different existing skills because their names or hashes match.
- Keep explicit format distinctions: twin skill, legacy scenario-shaped twin, builder role play and authored role play.
  A common storage envelope does not require rewriting all manifests or treating instruction packages interchangeably.
- `Agent.version` remains the experience/spec version; `SkillVersion.version` advances only for package changes.
- A persona, access or scoring-only change does not make a new SkillVersion. A builder edit that changes rendered
  instructions/examples does. Identity and scoring history continue to use existing Agent/session mechanisms.

### Storage contract

- S3 is the durable original package, preserving manifest filename, optional files and original bytes.
- SkillVersion holds immutable validated skill text/manifest for runtime reads, verified against the package at
  publication. Runtime calls do not download SKILL.md from S3 on every turn. This is a deliberate stored projection,
  not a second editable source.
- Chroma is a rebuildable index of items.json, not the only copy of examples.
- New index entries use `skillVersionId` plus `skillIndexScope` (the committed artifact prefix) within the existing org
  collection, with role/step metadata preserved. The pair excludes abandoned/expired physical attempts of the same package.
  No collection per skill; knowledge/persona entries in the same collection are unaffected.
- Existing S3 keys do not need moving. The registry can reference verified existing paths.

### Publication contract

`pending -> ready` or `pending -> failed`; failed attempts can be retried under the same attempt identity.
Published package content is immutable; index availability/rebuild state is tracked separately from content.

1. Validate org, experience kind, persona, package format and permissions at existing boundaries.
2. Under the owning agent/skill locks in a documented order, reserve a pending version. Same-package retries reuse its
   identity; every physical write attempt has an isolated namespace. Changed content cannot overwrite a ready version.
3. Write/verify S3 files and index examples outside a long-running DB transaction.
4. Atomically mark ready and switch Skill.currentVersion plus the Agent compatibility projection, after checking the
   expected publication generation. A superseded publisher cannot replace a newer committed publication.
5. Failure keeps the previous ready version current. Zero examples is valid and distinguishable from a failed index.

Package hashing includes file names and bytes for all versioned content; operational attempt IDs/timestamps do not
force content versions. Define evidence/change-file treatment explicitly instead of inheriting today's partial hash.
Persist visible bounded failure details for operators; retries/reconciliation must not hide failed publication.

The sequence above is the target after runtime adoption. Phase 1 reserves pending state separately but retains the
existing bounded final save transaction around external writes and compatibility activation. Do not prematurely split
it while legacy readers can confuse an unpublished Agent-version index with settings versions.

## Phase 1 — Working skill registry and shared publisher

**Product:** every new or updated twin skill and role play has a managed, inspectable package. Existing calls and
editors keep working through their current contracts.

Build:

- Add Skill/SkillVersion and nullable Agent reference, with additive constraints/migrations.
- Extract the package lifecycle behind `storeSkillAgent`; route twin ingestion, authored-role-play ingestion and
  builder saves through it. Preserve route payloads, return shapes, permissions and immediate builder publication.
- Persist reservations/failure state separately; retain the bounded existing save lock for external writes until
  runtime adoption makes stable skill-version scope authoritative. Include this limitation in release review.
- Keep Agent.data/SpecVersion as a generated compatibility representation, written only through the shared publisher.
  Existing Agent-only settings writers remain scoped to their settings and cannot replace the package projection.
- During this phase, publish legacy Chroma metadata as required by existing runtime readers as well as the new stable
  skill-version scope. Keep compatibility versions separate from package version numbers.
- Provide an authenticated studio/copilot read path for package versions/state and an operator check command.
  No new skill-library UI is required.
- Ensure existing restore/read, archive/restore and settings paths do not bypass or corrupt the registry.

**Demo:** create a builder role play and a copilot twin skill; inspect their managed files, versions and item counts;
run both through existing voice flows. Change examples, republish and see one new package version.

**Release gate:** unchanged publication is idempotent; scoring/persona-only changes do not bump package versions;
concurrent and interrupted publication leave a usable prior version; failures are inspectable/retryable; existing
builder, copilot read/history, source display and no-skill interview flows pass.

**Stop here:** useful registry/publishing management is live; runtime still consumes the compatible Agent representation.
Unedited historical agents continue working without an eager backfill.

**Rollback:** old-compatible application can use the generated representation. Leave additive tables in place.
Drain publishers before switching writer versions; reconcile publications before returning to new writers.

## Phase 2 — Role plays run on exact managed skill versions

**Product:** newly managed role plays use the registry end to end. Publishing again cannot change an existing call's
instructions or examples.

Build:

- Add SessionSkill pins at activation for managed builder and authored role plays, in the session-creation transaction.
- Resolve instructions/manifest/source references through SkillVersion; keep chat's external session-context shape
  stable where possible. Preserve authored versus builder prompts, tool permissions, example roles and endings.
- Search examples by the authorized session's exact SkillVersion AND its committed skillIndexScope, never a
  model-supplied arbitrary version ID or an unqualified version-ID filter.
- Remove cross-version example fallback for new pins. A valid empty/no-match result returns no examples; a missing or
  corrupt index is an explicit operational failure, not permission to search another version.
- Add idempotent reindex-from-S3/check tooling and protect live-session pins from index pruning. Verify index readiness
  before starting a new managed call; do not silently fall back to Agent data if a managed reference is broken.
- Keep old snapshots/unmanaged role plays on an explicit legacy reader. Preserve scoring snapshots and public APIs.

**Demo:** start a role play on v1; publish v2 and v3 during that call; the existing call retrieves only v1 examples,
and a new call uses v3. Both finish and produce the expected rubric report.

**Release gate:** real multi-turn builder and authored calls; retry/resume keeps original pins; tool execution and
reporting remain unchanged; cross-org and wrong-session lookup refuses; failed reindex leaves no false-ready index.

**Stop here:** role plays have fully managed packages; twins still use Phase 1's working compatibility representation.

**Rollback:** keep generating old snapshots/Agent projections and legacy retrieval metadata until migration closes.
Drain active calls before rolling runtime readers back; never assume old readers understand new pins.

## Phase 3 — Twins use the same managed skill runtime

**Product:** single-skill and all-skills twins run through the same package/version mechanism as role plays.

Build:

- Pin one managed version for a single-skill twin and the selected versions for a main twin.
- Preserve existing same-org/same-persona selection, ordering, supported legacy formats, lookup aliases, source display
  and inline-versus-Eve-skill behavior. No new manual skill-assignment UI or selection policy.
- Preserve main twins with no skills as valid empty catalogs; do not create an artificial SKILL.md for them.
- Route instructions, examples and copilot package-history reads through the shared resolver.
- Preserve coaching/decline rules, calibration feedback/evidence, permitted tools and after-call reporting.
- During transition, keep unmanaged historical skills explicitly on the legacy path; mixed catalogs may have managed
  version pins and legacy slug/version pins, recorded distinctly rather than pretending they are all managed.
- Prevent archive/republish from removing a ready package already pinned to a live session.

**Demo:** run a main twin with two managed skills; publish a revision and a third skill during the call. That call keeps
its original catalog; the next call gets the updated one. Repeat a single-skill and calibration call.

**Release gate:** multi-turn retrieval across topics, no-skill decline, calibration ratings/report, archive during
active call, same-persona isolation and mixed legacy/managed catalogs all work. Measure context/lookup latency against
the baseline; no per-turn S3 download.

**Stop here:** all newly published skill-based experiences use the common foundation end to end.

**Rollback:** retain compatibility writes; drain active calls and roll web/chat contracts back together if necessary.

## Phase 4 — Bring existing published skills and history into the registry

**Product:** existing trainers gain the same package/history guarantees without recreating their twins or role plays.

Build:

- Add dry-run/apply/check migration tooling scoped by org and resumable in batches. Rehearse on a fresh production-data
  copy with isolated S3/Chroma destinations before any approved production run.
- Inventory current Agent data, historical SpecVersion rows, S3 artifacts, Chroma versions and SkillSource links.
  Include archived skills and package versions referenced by supported sessions; do not rewrite historical snapshots.
- Import verified packages with an explicit `(agentId, agentVersion) -> skillVersionId` mapping. Multiple Agent versions
  may map to one package version when only settings changed.
- Verify files/hashes/manifest format, source provenance and item counts. Rebuild pruned indexes from items.json where
  needed; missing files become actionable migration failures, never fabricated packages or false-ready versions.
- Cut over an org only after every current eligible package and required pin is verified. Unrecoverable historical
  packages remain explicitly legacy/unavailable with a documented report; no destructive cleanup while gaps remain.
- Retain existing slugs, IDs, assignments, deployment links, persona relationships, session/report data and API shapes.

**Demo:** migrate an org with builder/authored role plays, single/main twins, archived skills and historical versions;
open history, start all call types, and rerun the migration with no duplicate rows or versions.

**Release gate:** before/after inventory and hash/count comparison; unchanged memberships, credits, assignments and
reports; rerun/interruption safety; backfill-versus-live-publication race tests; full voice canary for the migrated org.

**Stop here:** current and recoverable historical packages are managed; explicit legacy history remains readable.

**Rollback:** stop cutover, retain legacy records and compatibility writes, return affected org readers to the legacy
path only after verification/draining. A code rollback does not undo data changes.

## Phase 5 — Make managed skills the sole package owner

**Product:** one authoritative package model for both experiences, with fewer divergent writes and simpler maintenance.

Build only after the migration report and production canary establish coverage:

- Stop generating duplicate package fields in Agent.data for managed agents. Agent owns experience settings;
  SkillVersion owns instructions, manifests, artifacts, hashes, indexes and source links.
- Stop writing package history into SpecVersion; retain it for persona/experience history and explicit legacy readers.
- Remove legacy package publication/search branches only where all writers/readers have migrated. Retain any historical
  decoder needed for saved sessions; no forced conversion of no-skill interview agents.
- Retire compatibility Chroma records only after old callers/live pins are absent and rollback retention has elapsed.
- Document index retention: current packages and live-session pins stay indexed; older indexes can be explicitly
  restored from verified S3 packages. Restoring/reindexing does not mutate published package content.
- Update module specs, authoring/publishing docs and operating checks. Do not hard-delete old files/history in this PR.

**Demo:** publish/update both experiences without package copies in Agent.data; run both, inspect history/source links,
and restore/reindex an older package through the same services.

**Release gate:** no remaining managed-package readers/writers depend on removed fields; clean install/migrations,
all relevant tests and real voice canaries pass; operational rebuild and publication recovery demonstrated.

**Rollback boundary:** this closes backward compatibility. Once legacy projections stop being written, a pre-cutover
binary is not a safe rollback target. Use the last managed-compatible release; regenerating legacy projections requires
a separately rehearsed recovery operation.

## Verification and release discipline for every phase

1. Write agreed package rules/refusals before implementation; test the rules, not just table CRUD.
2. Unit/DB tests for constraints, tenant isolation, publication races, idempotency, hash/bytes consistency, zero items,
   source provenance and correct version resolution. Use isolated DB/S3/Chroma resources.
3. Flow/browser tests for builder and copilot authoring, publish/update/history/settings, assignments, start/resume,
   enabled workspaces, finish/transcript/report and calibration where affected.
4. Real multi-turn voice checks with LiveKit/chat/agent and actual S3/Chroma, including publish during an active call.
   Report controlled tests separately from live-provider evidence.
5. Type-check/build/lint affected services with Bun; measure activation/context/retrieval latency before and after.
6. Each phase gets its own release scope, migration/runbook, rehearsal results, canary and rollback target. Record which
   services deploy; the Python voice transport need not change unless tracing proves a contract change.
7. Production backfills, migrations, releases and destructive cleanup require explicit approval. Review the automatic
   migrate-on-build behavior in `web/scripts/vercel-build.sh`; a failed build does not reverse applied migrations.

## Explicitly deferred

- Splitting/renaming Agent, moving assignments, changing billing or public API resource names.
- A generic Active Storage clone or registry for every S3 upload in the application.
- Shared skill marketplace, cross-org reuse, arbitrary many-to-many attachments or a new skill editor/library UI.
- Rewriting all manifests to one schema, changing conversation prompts, or converting no-skill interviews to skills.
- Changing twin selection/access policy, report semantics, copilot approval/authority or user-visible conversation design.

## Before implementation

Approve the ownership/phase boundaries and write the rule spec with exact publication concurrency, retry/refusal and
retention contracts. Then implement Phase 1 only; later phases depend on its measured results.

The active worktree/session is `application-v3`; implementation branch is `feat/shared-skills` from `origin/v3`.
The previous checkout's AGENTS instructions ceased applying when the session moved here. No remote branch or PR has
been created; confirm release/PR destination before publishing work.
