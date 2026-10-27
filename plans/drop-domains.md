# Drop domains (v2)

Decision (user): v2 has no domains. Remove them everywhere, the public API included (**breaking change to `/api/v1`, approved**: option A).

## What a domain carried, and where it goes

| Domain field | Used by | Moves to |
|---|---|---|
| `principles` | Runtime prompts (`runDirectionCheck`, `contentDraft`); chat DOMAIN block | `Agent.data.principles` → `AgentSpec.principles` |
| `classifications` | Compiled `DomainSpec` only (no runtime reader); spec generation output | `Agent.data.classifications` (kept as data) |
| `knowledge_bases` | Knowledge lookup when the agent has no `knowledgeBase` | `Agent.data.knowledge_bases` |
| `id`, `name`, `version`, `description` | Pointers and labels only | Dropped. `Agent.data.domain` (the slug) is removed |

Twin and scenario-ingest domains are placeholders (`{ id, name, description }`), so nothing moves for them.

## Phase 1: domains unused (additive)

1. **Migration `drop_domains_1`** (backup first):
   - copy `principles`, `classifications` and `knowledge_bases` from each agent's domain into its `data` (only keys not already set);
   - remove `data.domain`;
   - make these optional:
     - `Agent.domainSlug`;
     - `InterviewSession.domainSlug` and `domainVersion`;
     - `SpecDraft.domainData`.
   - Drafts: merge `domainData` into `agentData` the same way.
2. **Readers:**
   - `getAgentConfigForAgent`: no domain lookup or "no domain → null"; knowledge comes from `knowledgeBase`, else `knowledge_bases`;
   - session start: the snapshot has no domain and writes no domain columns;
   - `session-context`;
   - chat brain: the DOMAIN block goes (principles reach the prompt through the agent spec);
   - compiler: no `DomainSpec` and no domain-match check; `AgentSpec.principles`;
   - runtime prompts.
3. **Writers:**
   - twins, scenario ingest: no domain row;
   - spec drafts: the bundle has no `domain`, its rubric fields live on the agent;
   - spec generation, the generate route, the agent editor and the spec page;
   - copilot studio route (`readSpec` "domain", the domain list);
   - seed: agent YAMLs carry the rubric.
4. **Public API and docs:**
   - `/v1/scenarios` and `/v1/sessions` drop `domainSlug` and `domainVersion`;
   - the portal and bench routes too;
   - update `openapi.yaml`, the guides, `limits.mdx` and Postman.
5. **Verify:**
   - before/after snapshot of what every agent compiles to: same knowledge bases, same principles, same agent spec;
   - tests updated; SQL suites pass.

## Phase 2: delete (separate commit, backup)

Migration `drop_domains_2`:
- drop table `Domain`;
- drop `Agent.domainSlug`;
- drop `InterviewSession.domainSlug` and `domainVersion`;
- drop `SpecDraft.domainData`;
- delete `SpecVersion` rows with `entityType = 'domains'`.

Also delete `data/domains/*.yaml` and update the SQL test fixtures.

## Known limits

- Old `SpecVersion` agent rows keep their `domain` slug and have no rubric. Restoring a pre-migration version brings back an agent without principles.
- Sessions started before the migration keep `domain` inside their frozen snapshot; readers ignore it.
- Dev scripts outside the build (benchmarks, provisioning) that create or read domains are not updated. They fail if run.
