# Phase 3 — twin runtime verification

This is an implementation/local-verification checkpoint, not production approval.
Real-provider comparison follows all implementation phases.

## Behavior matrix

| Experience | Required behavior |
| --- | --- |
| Managed single-skill twin | One exact immutable package pin; original instructions/examples survive publish/archive |
| Main twin | Same-org/persona skills, existing ordering, explicit frozen catalog |
| Mixed main twin | Managed version pins and legacy slug/version references remain distinct |
| Empty main twin | Explicit empty catalog, no fabricated package, no discovery of skills added mid-call |
| Existing null-marker session | Existing legacy decoder, no retroactive pinning |
| Calibration | Same settings, feedback/evidence and reporting contracts |
| Resume | Same session, snapshot, catalog and pins |
| Invalid scope | Unknown/wrong-org/wrong-alias refuses; never arbitrary package selection |
| Unavailable managed index | Operational refusal, never cross-version fallback |
| History read | Original format-specific files through verified managed package; legacy history remains readable |

## Local checks

Use only the isolated database:

```sh
DATABASE_URL='postgresql://surya@localhost:5432/trainertwin_shared_skills_test?host=/tmp'
```

Run targeted twin/role-play pin suites, twin playbook/history/runnable tests, all completed-phase DB tests, web flow
tests, chat tests, TypeScript, touched-file lint and build. Provider boundaries are controlled in local tests; do not
describe those as actual S3/Chroma/LiveKit checks. Record exact counts and commands in `shared-skills.md`.

The additive twin-pin migration freezes managed catalog metadata and validates catalog/pin correspondence,
format and persona ownership. Pin insertion validates current ownership; later settings changes must not invalidate
historical sessions. Attachment metadata remains mutable.

## Final live comparison

After all phases: exercise multi-topic turns, inline/Eve skill paths, empty-catalog decline, single-skill and calibration
calls, source display and reports. Publish a revision and another skill mid-call; archive an original skill. Confirm the
old call retains its original catalog and the next call sees the new catalog. Measure activation/context/retrieval
latency, including strict Chroma cardinality-check overhead. Use isolated providers and real-shaped data.

## Rollback

Retain compatibility publication, old snapshot decoders and legacy indexes. Drain new managed sessions before rolling
readers back to a pre-pin binary. No destructive cleanup or production action is part of this checkpoint.
