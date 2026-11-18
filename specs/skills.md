# Managed skills

## Scope and implementation boundary

This is the Phase 1 registry/publisher contract from [the shared-skills plan](../plans/shared-skills.md).
The schema and additive SQL migration establish database invariants; publication, refusal mapping and
compatibility behavior below are requirements for the shared publisher, not claims that this schema
alone implements runtime behavior. No backfill, session-pin table or runtime-reader cutover is included.

An `Agent` remains the twin/role-play experience. A `Skill` owns one package lineage for the
same-org `ownerSlug`, initially the owning Agent's slug. Main twins and no-skill legacy interviews may
have no `primarySkillId`. A registry row may exist before its Agent, so `ownerSlug` deliberately has
no Agent foreign key. The publisher must correlate the slug, organization and Agent kind; names or
matching package hashes must never merge different owners.

## Schema API

Source: `web/prisma/schema.prisma`; custom database checks/triggers:
`web/prisma/migrations/20261119120000_shared_skills/migration.sql`.

| Record | Fields and constraints |
| --- | --- |
| `Skill` | `id` cuid; required `orgId`, `ownerSlug`, `name`; `nextVersion` integer default 1, positive; `generation` integer default 0, nonnegative; nullable `publicationHash` (full experience-publication intent) and `currentVersionId`; `createdAt`, `updatedAt`. Unique `orgId_ownerSlug` and `[id, orgId]`. |
| `SkillVersion` | `id` cuid; required `skillId`, positive `version`, `format`, `contentHash`, `skillText`, JSON-object `manifest`, JSON-object `files`, `artifacts` S3 prefix, nonnegative `itemCount`; `status` and `indexStatus` default `pending`; nonnegative `publicationGeneration` default 0; nullable `failure` (at most 2,000 characters); `createdAt`, `updatedAt`. Unique `skillId_version` and `[id, skillId]`. |
| Relations | `Skill.organization` references `Organization` (SQL `organization`); `Skill.versions`, `Skill.agents`, `Skill.currentVersion`; `SkillVersion.skill`, `SkillVersion.currentForSkills`; nullable `Agent.primarySkillId` / `Agent.primarySkill`. |
| Format values | Exactly `twin`, `legacy-twin`, `builder-roleplay`, `authored-roleplay`. Preserve each format's manifest, instruction and example-role semantics. |
| Lifecycle values | `status`: `pending`, `ready`, `failed`. `indexStatus`: `pending`, `ready`, `failed`, independently operational after publication. |

### Database rules

1. Every Skill belongs to an existing organization. Agent's composite `(primarySkillId, orgId)` FK
   references Skill's `(id, orgId)`. A separate check forbids a non-null primary skill with null Agent
   org, closing the nullable-composite-FK bypass.
2. Skill's composite `(currentVersionId, id)` FK references SkillVersion's `(id, skillId)`. A deferred
   constraint trigger checks the final Skill row at transaction end: any current version must be ready.
   Thus one short transaction may mark a pending version ready and activate it. The foreign key itself
   is immediate: create the version before assigning its ID to `currentVersionId`.
3. A ready SkillVersion cannot be downgraded, moved to another Skill or have any package/identity
   field changed. Only `indexStatus`, `failure`, `publicationGeneration` and `updatedAt` may change after readiness.
   A ready package may have an unavailable/rebuilding index without losing its immutable content.
4. Pending/failed versions are not frozen. `pending -> failed -> pending -> ready` retries are allowed.
   Same-attempt content/namespace checks are publisher responsibilities; SQL does not pretend to
   validate S3, Chroma, exact file hashes or manifests.
5. All new FKs use delete/update `RESTRICT`; there is no cascading deletion of package history.
   Ready history survives Agent deletion. Organization deletion is blocked while registry rows remain;
   Skill deletion is blocked while versions or Agent references remain. SQL does not add a ready-row
   DELETE guard in Phase 1: the current-version FK prevents deletion while referenced; after clearing
   that pointer an otherwise unreferenced version can be deleted for isolated-test cleanup.
   Hard-delete authorization/retention is service policy until the retention phase. Archive/restore
   must not delete ready versions or their artifacts.

## Package bytes and identity

1. `files` is a filename-to-publication-text map. Values are exact UTF-8 file strings at the Studio publication
   boundary, including whitespace, trailing newlines and optional empty files. Markdown is verbatim; existing
   ingestion endpoints accept JSON objects and serialize them through `fileText`, so this does not claim to preserve
   arbitrary JSON whitespace from a copilot's earlier source file.
   Required files are `SKILL.md`, the format's original `skill.json` or `scenario.json`, and `items.json`.
   Validate filenames and reject non-text/unsafe paths rather than silently dropping files.
2. Hash the names **and exact UTF-8 bytes of every versioned content file**, with deterministic ordering
   and unambiguous filename/content framing. Use a full SHA-256 digest and one stable serialization
   convention in publication, verification and retry detection. Never hash only parsed JSON or a subset
   of files. `patterns.md` is versioned content and is included when present; absent and empty differ.
3. `changes.json` is provenance-only: preserve its original bytes alongside a newly reserved package,
   but exclude it from content identity. Changing only this provenance does not allocate a content version
   or mutate a ready package's saved files. Run IDs, attempt timestamps, S3 prefixes and index state likewise
   do not create content versions. Other supplied package content files are included, not silently excluded.
4. `skillText` and `manifest` are validated stored projections of the saved original files. Verify their
   consistency before readiness. `artifacts` is the immutable version's S3 prefix; `itemCount` is the
   expected count derived from `items.json`. S3 is durable package storage and Chroma is rebuildable.
   Zero items is a valid ready index after successful verification, not an index failure.
5. Version identity includes the explicit format. Changes to rendered instructions/examples or package
   files require a package version. Scoring, persona, visibility and Before/Tools/After-only changes do
   not, unless they actually alter rendered package files. `Agent.version` remains an independent
   experience/compatibility version; it is never assumed equal to `SkillVersion.version`.
   Compatibility version reservations may leave gaps after failed/superseded attempts; committed
   Agent versions must remain monotonic, not necessarily consecutive.

## Publication rules

1. Use the existing authenticated/authorized ingestion and builder boundaries. Validate current org,
   Agent ownership/kind, persona requirements and package format before reserving a publication.
   Shared package storage does not grant cross-agent sharing or cross-org access.
2. Reservation is a short transaction under the existing `agent:<slug>` transaction advisory lock.
   If taking an additional `skill:<id>` lock, always take it **after** the Agent lock in reservation,
   finalization, retries and reconciliation. Re-read the Agent and registry under the lock; the
   unique `(orgId, ownerSlug)` row also serializes publication before an Agent exists.
3. Under that lock, compare validated format/hash/bytes with the current package and any reusable
   pending/failed attempt. An identical already-ready current package is idempotent; settings changes
   can still update the Agent compatibility representation without allocating a package version.
   Reuse a same-package pending/failed version's ID and version number for retry, not its physical write namespace.
   Otherwise reserve `version = nextVersion` and increment `nextVersion`; gaps from failed attempts are valid.
4. Increment `Skill.generation` when accepting a publication attempt and store that value in
   `SkillVersion.publicationGeneration` as its activation token. A concurrent identical request may
   share a pending attempt only after proving its stored publication generation still matches
   `Skill.generation` AND Skill.publicationHash matches the complete publication intent (persona, compatibility content
   and provenance). A matching package hash alone does not prove ownership of the active attempt.
   A true no-op of the already-ready current experience returns under the reservation lock without changing generation,
   even when another different publication is pending.
   A failed retry obtains a fresh generation under the same lock, updates the version's
   `publicationGeneration`, and reuses the same SkillVersion identity and exact package bytes.
   Reserve the S3 namespace base from the SkillVersion identity before releasing the transaction.
5. Phase 1 uploads/verifies S3 files and upserts/verifies Chroma examples inside the existing bounded final
   `agent:<slug>` transaction (120-second wait/transaction limits). This serializes settings version writes with legacy
   index writes. External writes still cannot be rolled back with SQL. Moving them outside this lock is deferred until
   exact managed runtime scopes remove the compatibility collision. Retries must be idempotent and may not overwrite
   a ready namespace; re-read the version under this lock before any upload.
   Each physical finalization gets a fresh `attempt-<uuid>` namespace under the reserved base. Update the pending
   version's artifact pointer in this transaction so it commits only with readiness. A transaction timeout does NOT
   cancel provider callbacks; late callbacks must target abandoned prefixes/index IDs, never a retry's ready namespace.
   Preserve the org collection and example role/step metadata. Managed index scope is the pair `skillVersionId` and
   `skillIndexScope`, with the latter equal to the committed ready artifact prefix. Readiness checks and future runtime
   retrieval must supply both; filtering by version ID alone can include abandoned attempts.
6. Finalization is a second bounded transaction with the same lock order. Re-read ownership and the
   attempt, require the captured token to match both `SkillVersion.publicationGeneration` and
   `Skill.generation`, and activate
   using a generation CAS. The generation-qualified write must affect exactly one row.
   Only the winning attempt may mark its package ready, switch `currentVersionId`, and write
   Agent/history/source compatibility data atomically. A superseded attempt must not overwrite a
   newer Agent, ready package or index state. Both ordinary and duplicate-success paths must check generation.
   A settings/archive change between reservation and this lock refuses for explicit retry, not stale restoration.
7. Failed external writes retain the previous ready current version and persist bounded, sanitized,
   operator-visible failure details on the reserved attempt. Record failure without overwriting a
   later successful retry or publication; check the attempt's generation under the lock. A superseded attempt may
   be marked failed only while its own version still carries that generation, never after a newer retry reused it.
   Publication failure records `status = failed`; index failure records `indexStatus = failed` as
   applicable, without downgrading an already-ready package. Retry returns the failed attempt to pending.
   Interrupted pending attempts remain inspectable and retryable, never falsely ready.
8. A failed/superseded publication must not discard the previous usable package. Reconcile orphaned
   external writes using the reserved identity; never infer readiness from the existence of one object.
   Do not delete ready content as compensation.

## Refusal contract

These are publisher/read-contract requirements. Route adapters must preserve existing response
envelopes and permissions; schema constraints alone do not implement these HTTP responses.

| Code | HTTP | Required refusal |
| --- | --- | --- |
| `not_found` | 404 | Requested Agent/Skill/version does not exist in the authorized org, or the requested owner/version pairing is invalid. Do not disclose another org's records. |
| `skill_publication_superseded` | 409 | Final activation lost its generation CAS to another accepted publication. Do not replace the winner; caller must re-read before retrying. |
| `skill_package_unavailable` | 503 | A managed package or required index cannot be verified/read for an operation requiring it. Expose an operational failure, not fabricated content or another package version. Exact-pin runtime enforcement is deferred to runtime adoption. |

Existing authentication, permission, validation and immutable Agent-kind refusals remain at their
current boundaries; this contract does not replace them or introduce a public skill-management API.

## Phase 1 compatibility and later adoption

1. The shared publisher must keep `Agent.data` and `SpecVersion` as generated compatibility projections,
   including current manifest shape, artifacts, source display and existing read/history behavior.
   Settings-only writers must preserve package fields. Builder saves still publish immediately.
2. Publish legacy `agentSlug`/`agentVersion` Chroma metadata needed by current readers in addition to
   stable `skillVersionId` scope. Package and Agent version numbers may diverge; preserve the explicit
   mapping rather than substituting a package number into old runtime metadata. Prune below the previous committed
   Agent version, not `newVersion - 1`, so failed-reservation gaps cannot delete the previous published index.
3. Existing sessions keep their current snapshots/retrieval behavior, including existing legacy
   fallback. Phase 1 does **not** promise exact SkillVersion session pins, migrate old sessions,
   introduce `SessionSkill`, or rewrite main-twin selection. Historical unedited Agents need no eager backfill.
4. Future runtime adoption will pin exact managed versions at session activation, enforce org/session
   authorization, remove cross-version fallback for those pins, retain indexes for live pins, and distinguish
   valid zero/no-match results from unavailable indexes. Keep those guarantees explicitly deferred until
   their readers, schema, retention tooling and tests ship.
5. Rollback keeps additive tables and compatibility data. Drain publishers before changing writer
   versions and reconcile pending attempts before returning to managed writers. No production migration,
   backfill or destructive retention action is authorized by this spec.

## Verification gates

- Schema validation/client generation without database changes.
- Before release, isolated DB tests for cross-org/null-org links, wrong-skill/non-ready current references,
  ready mutation/downgrade, referenced-version deletion refusal, permitted operational changes,
  failed-generation retry transitions and counter/status checks.
- Publisher tests for exact-byte/filename hashes, optional files, provenance-only changes, empty items,
  failed retries, stale success/failure callbacks, simultaneous first publication, generation-CAS races,
  and rollback preserving prior current/package projections.
- Existing builder/copilot/history/settings/source flows and real multi-turn voice canaries remain
  Phase 1 release gates. Schema validation is not evidence that publisher/provider/runtime flows passed.
