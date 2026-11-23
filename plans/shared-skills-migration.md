# Shared skill migration and ownership operations

## Safety boundary

Implementation and local rehearsal are authorized. Production-data access, production backfills, deployment,
index retirement and ownership activation are not authorized. Do not add these operations to build scripts.
Use an isolated database plus isolated S3/Chroma destinations for any production-copy rehearsal.

## Phase 4

The migration must inventory current and archived Agents, historical Agent versions, saved session references,
original S3 packages and recorded provenance. Agent-version identity remains distinct from package-version identity.
Settings-only versions may map to one verified package; never merge owners because bytes happen to match.

Default to a dry run, scoped to one organization. Preserve IDs, aliases, assignments, personas, reports, balances
and historical session snapshots. Report missing/corrupt packages as actionable legacy/unavailable entries.
Do not fabricate missing items, silently ignore provider permission errors, or activate unverified packages.

The explicit mapping is `AgentSkillVersion(agentId, agentVersion) -> SkillVersion`. Package provenance lives in
`SkillVersionSource`, including saved titles for deleted documents. Keep legacy records for historical readers.
History mappings describe immutable content identity, not current index availability: index recovery must not
prevent recording a settings-only version or reading history.

Check reruns, interruption/retry, publication races, archived and session-only references, zero-item packages,
format-specific filenames, exact bytes/hashes, item counts and provenance conflicts before declaring coverage.
Rehearsal evidence in the main ledger must distinguish local controlled-provider fixtures from a production copy.

From `web/`, with explicitly isolated provider/database configuration:

```sh
bun scripts/migrate-skills.ts --org <slug>
bun scripts/migrate-skills.ts --org <slug> --apply --batch-size 50
bun scripts/migrate-skills.ts --org <slug> --apply --after <returned-cursor>
bun scripts/migrate-skills.ts --org <slug> --check
```

Remote database reads/writes additionally require `--production`; that flag is not approval to execute them.
Follow cursors until complete. `checkSkillMigrationCoverage` checks all pages for cutover, not only a single batch.
The inventory hash describes package/reference coverage and excludes mutable experience settings.

## Phase 5

Compatibility is the default for every organization. Managed ownership is an explicit operator action requiring
fresh coverage verification, the matching inventory hash and a recorded final live-canary approval reference.
Local tests can exercise this protocol with test attestations; that is not production or live-canary approval.

After approved activation, new managed package writes belong to SkillVersion rather than duplicate fields on
Agent/SpecVersion. Experience settings and Agent versions remain separate; settings changes carry exact mappings.
Existing historical snapshot decoders and unmanaged readers remain. Read boundaries preserve public response shapes.

Operator commands (not executed against a real organization):

```sh
bun scripts/cutover-skills.ts --org <slug>
bun scripts/cutover-skills.ts --org <slug> --apply --inventory-hash <reviewed-hash> --canary-reference <approval-reference>
```

Remote operation additionally requires `--production`. This implementation deliberately requires zero historical gaps,
not just current/required gaps. Review the complete report rather than treating a single batch as coverage.
SQL prevents managed state without nonempty inventory/canary references and verification/approval timestamps.

Do not automatically delete legacy files, history or Chroma records. Current packages and live pins stay indexed;
older indexes can be restored from verified original packages. Index retirement requires separate approval,
drained legacy callers and an elapsed rollback-retention period.

Automatic scenario-item pruning is disabled in both modes. A compatibility publication's delayed Chroma DELETE can
outlive SQL locks/timeouts and cross the cutover boundary, so an in-lock mode check is not sufficient protection.
Compatibility index writes continue; storage grows until an audited retention operation is approved and implemented.
Org-wide ownership locks currently serialize package/settings writers during the bounded provider operations; measure
this throughput tradeoff, as well as strict lookup cardinality reads, during final performance testing.

Once package projections stop being written, a pre-cutover binary is not a safe rollback target. Drain callers and
use the last managed-compatible release. Regenerating legacy projections is a separate rehearsed recovery operation.
