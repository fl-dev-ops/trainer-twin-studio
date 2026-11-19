# Olga local port — Phase 1

## Boundary

This phase restores Olga's authored experiences into isolated local services.
Production writes, deployments, ownership cutover and Vasanth conversion are out of scope.
Vasanth's read-only inventory is in `plans/vasanth-roleplay-inventory.md`.

## Local destinations

- PostgreSQL: `trainertwin_olga_local`, Unix socket `/tmp`; all 75 migrations applied explicitly to this new database.
- S3-compatible storage: `http://127.0.0.1:9100`, bucket `olga-local`, fake `S3RVER` credentials.
- Chroma: `http://127.0.0.1:8101`, tenant `default_tenant`.
- LiveKit: `ws://127.0.0.1:7881`, local development credentials, UDP `127.0.0.1:7883`; ICE/TCP disabled to avoid wildcard binding.
- Studio backend: `http://localhost:3100`; isolated public base `olga-local.localhost` through the existing loopback Portless proxy on 8443.
- Sign-in: `https://auth.olga-local.localhost:8443/sign-in`.
- Synthetic administrator: `olga-local-admin@localhost.invalid`; development OTP appears in the local web log, not email.

Original object keys are retained verbatim, including their historical `prod/` prefix.
The source uses two historical storage roots: builder roleplays use `trainertwin/kb/`,
while twin packages use `prod/trainertwin/kb/`. Local aliases and storage-pointer
normalization are required so the existing single-root organization guard can remain unchanged.
That prefix does not select a destination: the explicit loopback endpoint and fake credentials do.
Both ignored web environment files now select the local database, storage, vector service and LiveKit.
Email, payment keys, OAuth, ingestion queue and telemetry keys are disabled.
Model inference remains a separate prerequisite; a local content copy is not a claim of offline inference.

## Source and import contract

Source PostgreSQL connections enforce transaction read-only mode and verify database identity.
Source S3 permits GET only with an explicit AWS endpoint, independent of the target endpoint environment.
Source Chroma reads only the authored `main` collection, not learner-memory collections.
The copy script preserves source IDs, versions, original package bytes, metadata and vectors.
Private snapshots, checksums, vector caches and audit reports remain under ignored `backups/olga-local/`.

Expected authored inventory: 12 Agents, 10 Personas, 23 SpecVersions, 139 knowledge documents,
52 SkillSource rows and no PersonaSource rows. The main twin has no standalone package.
No learner sessions, learner identities, OAuth credentials, billing, assignments or sync jobs are copied.
A synthetic local administrator is created instead.

## Implementation and verification checkpoint — 19 November 2026

- `web/scripts/port-olga-local.ts`: copy complete. **352 objects, 1,564,495,075 bytes**,
  SHA-256 verified; nine optional pattern files absent. Source fingerprints unchanged.
- All expected metadata copied; synthetic admin only, no learner sessions or financial records.
- **183 original vectors** restored. Source `main` contains scenario examples only, not knowledge/persona vectors.
- Embedding coverage is **219/227 package items**. Eight original vectors are missing from
  Objection Handling's historical v1 package (Agent versions v1–v4 share that package).
  Its bytes/history remain available, but managed runtime use of that historical package
  must remain unavailable rather than fabricating vectors or silently re-embedding.
  All current packages have complete original-vector coverage.
- Registry restoration's first preflight refused the mixed storage roots before any registry writes.
  Normalization subsequently created **288 local aliases**, each SHA-256 verified, preserving originals.
  Storage pointers changed only in the local copy: nine Agents, 116 documents, nine voices and ten avatars.
- Restore/check passed: **11 current mappings**, **16 total verified Agent-version mappings**,
  11 skills and 12 unique managed packages. Four historical mappings remain explicitly unavailable.
  Rerunning restoration preserved counts: 11 skills, 12 packages, 16 mappings, 47 managed provenance
  rows, 11 attached Agents and all 52 original source rows.
- Native AWS SDK endpoint behavior: 5 tests passed; no storage adapter changes needed.
- Native imported-vector indexing: 22 scenario-item tests passed; no re-embedding required.
- Missing historical provenance is treated as unknown, allowing verified same-owner, same-package enrichment.
  Known nonempty provenance conflicts still refuse. Focused migration suite: 38 tests passed.
- Final database regression suite: **993 passed, 0 failed**, 56 files, isolated `trainertwin_shared_skills_test`.
- Typecheck and focused lint passed before final restoration integration.
- Browser tool connection timed out opening/listing tabs; UI verification is not yet complete.
- Local LiveKit health check passed. The voice worker registered as `olga-local` against
  `ws://127.0.0.1:7881`; no end-to-end voice call is claimed yet.
- Build compilation/prerender completed, then the existing Next.js security advisory gate returned
  failure. A Next.js security upgrade is recommended; no dependency upgrade is included in this port.
- Final focused storage/restore/index/verifier tests: **79 passed, 0 failed**.
- Python voice-agent regression tests: **44 passed**.
- Public sign-in and JavaScript asset return 200; apex and unauthenticated dashboard redirect
  to the isolated sign-in URL. Use native `next dev --hostname localhost --port 3100`;
  `--hostname 127.0.0.1` caused Next URL normalization to misclassify host-aware rewrites.
- Actual OTP send, sign-in and authenticated-session requests passed over CA-verified HTTPS.
  Dashboard `/`, `/agents`, `/twin`, `/personas` and `/twin/knowledge` returned 200.
  API data confirms 12 Agents, ten personas, 139 documents and zero indexed knowledge chunks.
  Private authentication artifacts remain ignored and mode 0600.
- Visual browser verification is blocked: Chromium rejects the untrusted local Portless CA
  (`ERR_CERT_AUTHORITY_INVALID`), and in-app browser tooling timed out. No certificate
  bypass or system trust installation was performed. A trusted local certificate is needed
  for normal browser sign-in; HTTP/API verification is not a visual pass.
- The original Portless `trainertwin → 3000` route is unchanged. No global certificate trust change was made.
- Source documents retain their original state: all 139 were `uploaded`, with Markdown references.
  No missing knowledge index was invented or generated during the copy.
- Native runtime verification passed for **all 12 experiences**, all **16 available mappings**,
  all **11 current packages**, the main twin's **two-skill catalog**, and **147 current twin examples**.
  Verified 43 original package files and queried all 12 managed package scopes with real imported
  vectors. No model calls, invented vectors or new sessions were needed for this check.
  Native catalog helpers perform locking reads, so this target-only verifier uses a read-write
  transaction while making no data changes; it does not weaken the source connection's read-only guard.

## Remaining acceptance checks

1. Finish new-session-pin and real conversation verification; visual browser verification requires local certificate trust.
2. Record conversation checks and exact local test entry points; commit locally only.
3. Return Phase 1 results and Vasanth's existing component breakdown, then stop for Phase 2 direction.

## Commands

From `web/`, the guarded restoration is idempotent:

```sh
bun scripts/restore-olga-local-skills.ts --apply
bun scripts/verify-olga-local.ts --verify
```

The original copy and storage normalization are fresh-copy preparation steps, not reset commands.
They deliberately refuse conflicts rather than overwriting an already-normalized or managed database.
Do not rerun migrations, copy or normalization against the source database.

### Local service restart references

Services are already running. If stopped, start S3 and Chroma from the repository root:

```sh
bunx s3rver --directory backups/olga-local/objects --address 127.0.0.1 --port 9100 --no-vhost-buckets --configure-bucket olga-local
uvx --from chromadb chroma run --path backups/olga-local/chroma --host 127.0.0.1 --port 8101
```

LiveKit uses the verified binary at `backups/olga-local/bin/livekit-server`:

```sh
env -i PATH=/usr/bin:/bin backups/olga-local/bin/livekit-server \
  --dev --bind 127.0.0.1 --node-ip 127.0.0.1 \
  --udp-port 7883 --keys 'devkey: secret' \
  --config-body $'port: 7881\nrtc:\n  tcp_port: 0\n  use_external_ip: false\n  enable_loopback_candidate: true\n  ips:\n    includes:\n      - 127.0.0.0/8'
```

From `web/`, start `bun run dev --hostname localhost --port 3100`.
From `agent/`, start `uv run trainertwin dev`.
The chat bridge uses port 2100 and `STUDIO_URL=http://localhost:3100`.
All use the ignored local configuration; do not substitute the original checkout's credentials.

The isolated Portless alias is `olga-local → 3100`, using the already-running proxy on 8443.
No existing route was replaced. The local CA is `~/.portless/ca.pem`; command-line verification
explicitly trusts that CA per request, without changing system/browser trust.
