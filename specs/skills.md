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
| `skill_index_superseded` | 409 | Index rebuild completion/failure lost its generation CAS to a newer rebuild. Do not overwrite the newer index state or failure details. |
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

## Phase 2: exact role-play session pins

This section supersedes Phase 1's deferred role-play pin/runtime statements above. Phase 2 adopts
managed role-play packages only; twin multi-skill selection, no-skill conversion, legacy backfill,
retention tooling and public skill-management APIs remain deferred. Schema alone does not implement
the runtime contract: the session creation and runtime readers must ship together.

Phase 3 extends the same pin mechanism to twins; the role-play contracts below remain applicable.

### Phase 5 gated ownership

- Per-org `SkillOwnership` defaults to compatibility without a row. Managed activation requires explicit apply,
  complete fresh coverage matching the reviewed hash and a recorded final-canary approval reference. SQL requires
  approval/verification timestamps and nonempty references. Local test attestations do not constitute live approval.
- Current implementation blocks every historical gap as well as current/required gaps. It does not auto-activate
  organizations, run migration during builds or deploy a cutover.
- In managed mode, SkillVersion solely owns new package content and package source links. New Agent/SpecVersion
  writes omit only `skill`, `scenario`, `artifacts`, `filesHash`; existing historical data is not destructively rewritten.
  Agent versions, personas, settings/scoring and experience fields remain independent.
- Exact version mappings plus lightweight hydration preserve editor, public API, runtime, history and report shapes.
  Saved null-marker sessions retain legacy decoding; missing lazy snapshots resolve saved versions or refuse 503.
  Historical no-skill sessions must not inherit a current package. Missing package history remains required coverage.
- Ownership lock precedes Agent locks for package writes, settings, import, index claims and legacy backfill. Raw-row
  CAS, immutable physical publication attempts and generation fencing still apply.
- Compatibility indexes remain written. ALL automatic scenario-index pruning is disabled until a separate audited
  retention operation: external deletion cannot be fenced merely by SQL lock/state checks after a timeout.
- Real-org migration/cutover, final live/performance comparison, index retirement, deployment and pre-cutover-binary
  rollback are not implied by successful controlled-provider tests. Use the last managed-compatible binary after cutover.

### Phase 4 history mapping and import

- `AgentSkillVersion` maps `(agentId, agentVersion)` to a ready same-org/owner package. Mapping updates are forbidden;
  several experience versions may share content identity. Index availability is operational, not mapping identity.
- `SkillVersionSource` owns package provenance, including saved titles for deleted documents. Legacy source rows remain
  for unmapped history. Settings-only versions use the same package provenance.
- Publication records exact mappings and source links atomically. Current/history readers prefer explicit mappings,
  never a mutable current pointer. Runtime hydration excludes package files; explicit history verification can load them.
- Org-scoped import is dry-run by default, bounded/resumable, with explicit apply/check and complete coverage reports.
  Import verifies original S3 bytes, format, projections, canonical/recognized legacy hashes, example counts and source
  consistency before readiness. Optional missing evidence is distinguished from storage permission/service failure.
- Deduplication is owner-local. Every differing original artifact prefix is independently verified byte-identical
  before mapping it to an existing package. Conflicting provenance or duplicate ready identities refuse explicitly.
- Current, archived, historical, session-only and mapping-only references remain inventoried. Package-free mapped
  records verify through immutable envelopes plus original S3 objects, not invented compatibility fields.
- Publication/index-generation checks prevent import taking over a newer publication. Interrupted claims are visible and
  retryable. Missing/corrupt current or required history blocks cutover; legacy historical gaps remain explicitly reported.
- Import does not rewrite sessions or identity/access/billing/report records. Production-copy rehearsal, production
  execution, destructive cleanup and live-provider approval are separate, uncompleted operational gates.

### Phase 3 twin adoption

- `loadSessionSkills` is the generalized authorized resolver. Single managed twins have one position-zero owner pin.
  Main twins have marker 1 and an explicit `compiledSnapshot.twinSkills` catalog, including an empty array.
- Catalog entries preserve Agent aliases/versions and ordering. A `skillVersionId` identifies a managed entry;
  entries without it remain explicit legacy references. Managed pin positions match full catalog positions.
- Selection remains same-org/same-persona/nonarchived at activation. Existing managed packages survive subsequent
  archive/publication. Newly added skills never appear in an existing catalog.
- SQL freezes the catalog and validates completeness, managed twin formats and insertion-time persona ownership.
  Persona/settings changes after creation do not repin historical calls. Other managed identity guards remain.
- Context cache v3 validates all pins first. Single skills project their pinned text/manifest; main twins derive
  playbooks from the frozen mixed catalog, not the live skill list.
- Search authorizes the owner alias or a recorded main-twin catalog alias. Managed example lookup always uses exact
  version/artifact scopes; only explicitly recorded legacy entries use the compatibility lookup.
- Managed copilot package-history reads verify the immutable original-file envelope, selecting manifest filename by
  format (including scenario-shaped legacy twins). Missing/corrupt current managed packages refuse, not legacy fallback.
- Coaching rules, inline/Eve behavior, calibration, feedback/evidence, tools, after-call reports and new-start semantics
  remain unchanged. Local provider-boundary tests are not live-provider or latency-comparison evidence.

### Schema API and database guards

Source: `web/prisma/schema.prisma`; additive migration:
`web/prisma/migrations/20261119130000_session_skill_pins/migration.sql`.

| Record | Fields and constraints |
| --- | --- |
| `InterviewSession` | Nullable `skillPinsVersion Int?`: null means legacy, 1 means managed; no default or backfill. Relation `skillPins SessionSkill[]`; unique `[id, orgId]` (`id_orgId`). |
| `SessionSkill` | Required `sessionId`, `orgId`, `skillVersionId`, `alias`; `position Int` default 0, nonnegative; `createdAt` default now. Composite primary key `[sessionId, alias]` (`sessionId_alias`); unique `[sessionId, position]` (`sessionId_position`); index `[skillVersionId]`. |
| Relations | `SessionSkill.session`: `[sessionId, orgId]` → `InterviewSession.[id, orgId]`, delete cascade/update restrict. `SessionSkill.version`: `skillVersionId` → `SkillVersion.id`, delete/update restrict. Reverse `SkillVersion.sessionPins SessionSkill[]`. |

1. Insert-time guards require the managed marker, a same-org session and Skill, ready package
   `status`, ready `indexStatus`, and `alias = Skill.ownerSlug`. Session/version/Skill reads take row
   share locks; the Agent kind read takes key-share.
   A ROLEPLAY session additionally requires `builder-roleplay` or `authored-roleplay` format,
   `alias = session.agentSlug`, and position 0. Unique position makes a second role-play pin impossible.
2. Deferred constraint triggers re-read final rows at transaction end: managed ROLEPLAY sessions
   require exactly one pin; null-marker sessions require none. Create the session with marker 1 and
   its pin in the same transaction. Marker updates, including null → 1, are forbidden.
3. Pin UPDATE is forbidden. Deferred deletion checks reject deleting any managed pin while its
   session survives, including delete-and-replace attempts. Deleting the parent session still cascades
   successfully, allowing isolated-fixture cleanup. A pinned version cannot be deleted.
4. Managed session identity (`id`, `orgId`, `agentId`, `agentSlug`, `agentVersion`, `personaSlug`,
   `personaVersion`) and `compiledSnapshot.agent` / `compiledSnapshot.persona` cannot change, preserving
   the pinned experience's skills, scoring and persona. The whole snapshot is not frozen: top-level
   `sessionDocumentIds` and `documentManifests` remain mutable for mid-call attachments.
   Null-marker legacy updates retain existing behavior. A pinned Skill's org
   and owner alias cannot change. Existing tenant/Agent-kind guards remain in force. Session status
   is not restricted to activating: historical and completed sessions must remain readable/updatable.
5. Readiness is checked on pin INSERT, not subsequent session/package operational updates.
   A ready package's index may later fail/rebuild without invalidating history; unavailable runtime
   indexes must fail explicitly. SQL does not validate external artifacts or index contents.
6. The table can represent future ordered twin pins. Phase 2 services do not create those pins or
   mark existing twins/no-skill/legacy sessions as managed.

### Creation, snapshot and runtime contract

1. Resolve managed role-play packages from a coherent Agent snapshot's `primarySkillId` and
   `data.artifacts`, not from the mutable `Skill.currentVersionId` pointer. Match the exact SkillVersion
   belonging to that primary Skill and artifact prefix, and verify org, owner, role-play format and
   readiness. Never assume Agent version equals package version.
2. Inside the existing minutes/session creation transaction, take `SELECT ... FOR KEY SHARE` on the
   Agent row, then fetch the complete Agent/persona metadata through a getter accepting that
   transaction client. Build the session snapshot and pin from that coherent read. Do not wait on the
   publisher's advisory Agent lock across external provider writes. Key-share permits non-key Agent
   updates, avoiding the lock cycle between a publisher holding Skill then updating Agent and a start
   holding Agent share then reading the pinned Skill under share lock. Resolve the captured package
   by immutable artifacts, never the mutable current pointer; concurrent publication must not mix
   package and experience metadata.
3. Persist `skillPinsVersion = 1` and the single position-0 owner-alias pin atomically with session
   creation. Creation refusal rolls back both the session and associated minutes transaction work.
4. Managed runtime reads authorize the session/org and use only its pinned SkillVersion, immutable
   files/manifest/instructions, and exact canonical index scope:
   `skillVersionId = version.id` AND `skillIndexScope = version.artifacts`. Never substitute the current
   pointer, Agent version metadata, another artifact attempt, or an unfiltered/previous-version fallback.
5. Zero-item packages and valid no-match queries return clean empty examples. Missing, failed,
   unverifiable or inaccessible required package/index data is not a no-match result.
   Managed failures return existing `skill_package_unavailable` (503); unauthorized/missing records
   or invalid owner/version pairings return existing `not_found` (404), without cross-org disclosure.
6. Null-marker sessions keep existing legacy snapshot/retrieval behavior. Main twins and no-skill
   legacy interviews remain unchanged; no eager backfill or mutable-current-pointer adoption.

### Verification and rollout boundary

- Per phase, validate/generate Prisma and compile local code; do not apply this migration implicitly.
- Live database/provider and multi-turn testing is scheduled **after all phases**, not between phases.
  Deferred checks must cover missing/extra pins, marker mutation, cross-org/owner/format/readiness
  refusal, immutable pins/identity, deletion/replacement refusal, parent cascade cleanup and operational
  index updates. Runtime tests must cover publication races, coherent snapshots, historical exact
  retrieval, abandoned-attempt isolation, empty/no-match results and explicit index outages.
- SQL identity tests must reject individual managed changes to `agentVersion`, `personaSlug`,
  `personaVersion`, and either `compiledSnapshot.agent` or `compiledSnapshot.persona` (including
  removal/null replacement), while allowing top-level `sessionDocumentIds`/`documentManifests`
  attachment updates with both protected sections unchanged. Verify equivalent null-marker legacy
  updates remain permitted and managed marker changes remain forbidden.
- No production migration, backfill, commit/push, destructive retention or twin-reader cutover is
  authorized by this contract. Retention must eventually preserve every live/historical referenced
  version and exact index namespace; pinning alone does not change legacy pruning tooling.

### Phase 2 index recovery generation

`SkillVersion.indexGeneration Int` defaults to 0 and has a nonnegative database check in the Phase 2
migration. It is operational metadata, excluded from package identity; the replaced ready-version
immutability function permits changes to `indexGeneration` alongside `indexStatus`, `failure`,
`publicationGeneration` and `updatedAt`, without permitting package/status mutation.

1. An explicit operator reindex invocation claims the version under a short `agent:<ownerSlug>`
   transaction advisory lock: increment `indexGeneration`, mark `indexStatus = pending`, and capture
   the generation and immutable package identity. No UUID claim or lease table is introduced.
2. Perform external index work outside that transaction, verifying the same immutable package and
   exact canonical scope (`version.id`, `version.artifacts`). Reindexing does not allocate a package
   version or change its artifacts/content identity.
3. Both success and failure updates use a compare-and-swap on `id` AND the captured
   `indexGeneration`. A stale rebuild must not mark a newer rebuild ready/failed or overwrite its
   failure details. Only verified success marks the claimed generation ready.
4. A crashed pending rebuild is recovered by another explicit operator reindex invocation, taking
   the same lock and claiming a new generation. No implicit timeout-based readiness or downgrade.
5. Publisher reuse of an already-ready package must freshly require `indexStatus = ready` under
   its lock; reuse must not undo maintenance pending/failure state. Managed runtime retains explicit
   `skill_package_unavailable` (503) behavior while the required index is unavailable.
