# Skill versions, sources and diff-based updates (twin skills, role plays)

Status: Phases 0–3 done 6 Nov (d7f3942, 5fbd9cb, 35510f1, 550cb7c); Phase 4 deferred.

## Where we are (checked in code)

- **Publishing already versions.** `storeSkillAgent` (web/lib/scenario-ingest.ts) snapshots the old spec into `SpecVersion`,
  bumps `Agent.version`, and writes the files to S3 under `…/scenarios/<slug>/v<N>/` (SKILL.md, skill.json /
  scenario.json, items.json, patterns.md). Every version's `items.json` is already backed up in S3 and never deleted.
- **Vector items are not versioned.** `MainCollectionService.replaceScenarioItems` deletes all `scenario_item`s of the slug,
  then embeds and inserts the new ones (no version in metadata). Problems:
  1. A failed embed leaves the skill with no items; the window between delete and insert has none either.
  2. Vector DB and Postgres are not in step: items are replaced before the Agent row's transaction (which may fail).
  3. A twin call pins its skills and versions at start (`pinTwinSkills` / `twinPlaybooks`), so its SKILL text stays at
     v19, but `scenario_examples` / `search_style` read whatever items exist now (v20).
- **Items know their source document.** Each twin item's `metadata.source` is the `KnowledgeDocument.id` (copilot syncs
  files as `<title> [<docId>].md`); recordings also keep `ref` (the turn). Verified on Olga's skills (6/6 sources match KB
  docs). Older Acme skills predate the KB sync: their sources are not KB ids. Nothing in Postgres records this.
- **Copilot updates are partial for items only.** `load_skill` writes the published version as `base.json`; a build adds
  items and removes listed ones and writes `changes.json` (kept / added / removed / skipped / newSources). But `body`
  (SKILL.md) and `patterns` (patterns.md) are required, full rewrites on every update.
- **Bug (review #2):** `base.json` is not refreshed after publish, so a second update in the same conversation merges onto
  the old version and drops the first update's items.
- **Bug (review #3):** publishing onto an archived skill updates it but leaves it archived (invisible).

## Plan

### Phase 0: fix the two bugs (small) — DONE 6 Nov (uncommitted)
- After a successful studio publish, rewrite `base.json` with the published items and the new version
  (copilot `publish_twin_skill`, and the role-play equivalent). Test: two updates in a row keep both.
- `storeSkillAgent`: publishing onto an existing agent clears `archivedAt` (update and unchanged paths).

### Phase 1: versioned vector items, safe publish order — DONE (5fbd9cb)
- Item metadata gets `agentVersion` (the Agent version the items belong to); vector ids become
  `scenario_item_<slug>@v<N>#<i>` so versions don't overwrite each other.
- Publish order: embed + insert the new version's items (additive) → Postgres transaction flips `Agent.version` →
  delete item versions that are no longer needed. A failure before the flip leaves the old version fully working.
- Queries filter by slug **and** version: the live version, or the pinned version for a running twin call
  (`$or` of `{agentSlug, agentVersion}` pairs).
- Cleanup policy: keep the live version and the previous one (running calls, quick rollback); older versions are only in
  S3. Restoring an older version re-embeds from its S3 `items.json`.
- **All of this is done by the studio's publish code, never by the copilot.** The copilot has no delete or cleanup tool;
  it only publishes, and the studio decides what is kept.
- Backfill once: tag existing items with their agent's current version (metadata update, no re-embed).

### Phase 2: sources per version (the "which documents built this skill" UI) — DONE
- At publish, count items per source document and store it: `SkillSource(agentId, version, documentId, items)`
  (a table, so the reverse lookup "which skills use this document" is a plain query).
- Skill page: "Built from: Session 3 · Osama (12 items), Objection 1-15 (8 items) …", linking to the KB document;
  a deleted document shows as deleted; legacy skills show "sources not recorded".
- KB document page: "Used in: Objection handling v8, Off-plan v20" (in scope now).
- Backfill from each live version's S3 `items.json`.

### Phase 3: diff-based copilot updates — DONE (twin skills)
- In update mode, SKILL.md and patterns.md change by **edits**, not rewrites: `edits: [{ file, find, replace, why }]`,
  each `find` an exact, unique piece of the loaded text (refused otherwise, like an editor). New skills still send the
  whole text.
- `changes.json` adds a unified diff of SKILL.md / patterns.md next to the item changes, and is published with the
  version to S3 (`…/v<N>/changes.json`). **For debugging only: no diff in the UI or the approval card.**

### Phase 4: role plays built from recordings — DEFERRED (6 Nov)
- Phases 1–2 already cover them (they publish through storeSkillAgent: versioned items, sources).
- Phase 3's edit mode for `build_scenario` is deferred: production has no copilot-built recording role plays (the 15
  ROLEPLAY agents without a source are older spec-based interview scenarios with no published files, which the copilot
  can't load). It needs plan recovery (plan.json is only in the run archive, and the check requires items from every
  planned session). Do it when the first one is built and needs an update.

## Decisions (6 Nov)
1. Vector DB keeps the live + previous version. Cleanup is programmatic, in the studio's publish; the copilot never deletes.
2. No diff in the UI: the change record (with diff) is stored per version in S3 for debugging.
3. The "Used in" view on KB documents is in scope now.
