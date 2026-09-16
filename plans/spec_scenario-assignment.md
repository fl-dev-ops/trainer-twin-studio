# Scenario Assignment — Requirements

Feature: trainer assigns a scenario (agent) to learners; learner receives and runs an
assigned practice session. Baseline is today's implementation (see "Current state");
each item is marked **[✓ shipped]** or **[ ] to build** so we can diff implementation
against requirements.

## Functional

### F1. Assignment creation
- [ ] Trainer can assign a scenario to 1..100 learners in one action.
      Limit is the TS constant `MAX_ASSIGNMENT_RECIPIENTS` (lib/assignments.ts). **[✓ shipped]**
- [ ] Learner can be identified by email — the system resolves email → existing user;
      unknown email produces a clear, non-crashing error (no partial assignment). **[ ] to build**
      (Today assignment is by memberId/userId only; email is resolved in the dashboard UI.)
- [ ] Assignment is persisted to DB **before** any notification is sent. **[✓ shipped]**
- [ ] Each assigned learner gets a pre-created `assigned` session with a personal
      share code (`/s/{code}` practice URL). **[✓ shipped]**
- [ ] Assigning is idempotent: re-assigning an already-assigned learner must not
      create a duplicate assignment or session. **[✓ shipped]** (unique `agentId+memberId`)
- [ ] Only org members (role `member`) within the trainer's org can be assigned;
      cross-org or non-member targets are rejected with a clear error. **[✓ shipped]**
- [ ] Assignment records who assigned it (`assignedByUserId`) and when. **[✓ shipped]**

### F2. Assignment lifecycle
- [ ] States: `assigned → active → completed | abandoned | revoked`. **[✓ shipped]**
- [ ] Re-PUT (sync) semantics: members not in the new list are de-assigned and their
      assigned session is revoked; newly listed members are assigned. **[✓ shipped]**
- [ ] Learner activation claims the assigned session: `assigned → active`, runtime
      token minted, agent/persona/domain versions stamped, compiled snapshot cached,
      opening prewarmed. **[✓ shipped]**
- [ ] An assigned session cannot be claimed twice or by another user/org
      (shareCode + user + org + status checks). **[✓ shipped]**
- [ ] Revoked/expired share codes fail safely when hit directly. **[✓ shipped]**
- [ ] Session completion or abandonment clears the assignment (one-shot). **[✓ shipped]**
      Multi-session / repeatable assignments: **[ ] to build** (open decision).
- [ ] Trainer can view per-assignment status (who assigned, when, session state). **[✓ shipped]** (via API)

### F3. Notification
- [ ] Assignment email is sent after the DB write succeeds, containing learner name,
      scenario name, objective, practice URL, and trainer name. **[✓ shipped]**
- [ ] Email delivery result is surfaced to the caller (count sent / failed). **[✓ shipped]**
- [ ] Reminder / re-notification for unstarted assignments: **[ ] to build** (open decision).

### F4. Learner experience
- [ ] Learner portal shows "Assigned to you" scenarios with an Assigned badge and a
      direct start link; public library scenarios remain visible below. **[✓ shipped]**
- [ ] Completed/revoked assignments disappear from the assigned section
      (scenario falls back to the library). **[✓ shipped]**
- [ ] Learner can attach/upload context documents (resume, etc.) at activation;
      docs must belong to them. **[✓ shipped]**

### F5. External API (org API keys)
- [ ] `POST /api/v1/assignments` — assign by userId + scenario slug, idempotent. **[✓ shipped]**
- [ ] `GET /api/v1/assignments` — list with filters (userId, scenario, pagination). **[✓ shipped]**
- [ ] `GET /api/v1/sessions` — filter sessions by scenario/status/user. **[✓ shipped]**
- [ ] Scoped permission checks (`assignments:read/write` per API key). **[✓ shipped]**

## Non-functional

### N1. Correctness & integrity
- [ ] All writes are transactional: assignment row + session row + link are all-or-
      nothing; failure rolls back cleanly (no orphan assignment/session). **[✓ shipped]**
- [ ] Versions stamped at activation reflect the then-current agent/persona/domain
      (no stale assignment-time snapshot). **[✓ shipped — decided]**
      DECIDED: no version pinning. Learners always get the latest spec, snapshotted
      at activation; active sessions keep their activation-time compiledSnapshot.
      Validation gate on agent save/publish remains the safety net for spec changes: **[ ] to build**
- [ ] Invalid email / unknown user / revoked scenario return typed 4xx errors, never 500s. **[ ] to build** (email path)

### N2. Scale & performance
- [ ] Bulk assign of 100 learners completes without timeouts (serial session
      creation today — acceptable at 100; parallelize + paginate email sends if it
      exceeds ~2–3s). **[✓ shipped]** — ponytail: serial loop, parallelize when measured.
- [ ] Email sends are resilient: one failed send does not abort the whole batch
      (failures counted, not thrown). **[✓ shipped]**
- [ ] Assignment queries are indexed (`orgId+memberId` index, unique
      `agentId+memberId`). **[✓ shipped]**

### N3. Security
- [ ] All dashboard routes require an authenticated trainer of the org. **[✓ shipped]**
- [ ] All external routes require a scoped API key. **[✓ shipped]**
- [ ] Practice URLs are unguessable (random share code) and activation re-validates
      org + user + status server-side. **[✓ shipped]**
- [ ] Runtime token is one-time: nulled on session end/revocation. **[✓ shipped]**

### N4. Observability
- [ ] Email send failures are visible in the response (`emailFailures`). **[✓ shipped]**
- [ ] Structured logging / metrics for assignment funnel (assigned → activated →
      completed) : **[ ] to build** (open decision).

## Open decisions (not yet made)
1. Repeat assignments: re-assign the same scenario to the same learner after
   completion — allowed always, trainer-controlled, or never?
2. Assign-by-email for unknown users: invite-and-assign flow, or reject?
3. Reminders for assigned-but-unstarted learners?
4. ~~Version pinning~~ — DECIDED: always-latest, no pinning.
5. Expiry: should an assigned session expire if unclaimed after N days?
