# Agents: twins, role plays and bots

All three are rows of `Agent` with one shape. **Persona** and **Skill** are libraries; an agent connects them.

```
Persona (library) ──< AgentPersona {position, active} >── Agent (kind TWIN | ROLEPLAY | BOT)
Skill   (library) ──  Agent.primarySkillId (main skill)
Skill   (library) ──< AgentSkill {position, active} >──── Agent   (supporting skills)
Agent ──< Deployment {channel api | public}                         (how people reach it)
InterviewSession: the persona it played (personaSlug/version) + SessionSkill pins (exact skill versions)
```

| | Twin | Role play | Bot |
|---|---|---|---|
| Personas | exactly 1 active, the user's own (`isOwn`) | 1 or more active; each session picks one at random | exactly 1 active, any (own or custom) |
| Main skill | its coaching (optional until written) | the scenario package | its purpose (`data.objective`); a `bot` SKILL.md later |
| Supporting skills | topic skills (published `twin` packages), each switchable | optional | chosen topic skills |
| Reached by | assigned learners (`TwinAssignment`, share link) | assigned learners (`RolePlayAssignment` via an `api` deployment) | signed-out visitors (its `public` deployment: widget) |
| Pays | learner minutes | learner minutes | org balance |

## Rules (enforced by the database)

1. Persona counts per kind, checked at commit for live agents (`AgentPersona_kind_check`). `Agent.personaId` is one of
   them (the first active); while older writers set only that column, `agent_persona_sync` keeps the rows in step.
2. A supporting skill is a published twin skill of the same org and is not the agent's main skill (`tt_agent_skill`).
3. A session pins exact skill versions when it starts; later edits never change a call in progress. A twin or bot pins
   a catalog (`compiledSnapshot.twinSkills`) that must match its `SessionSkill` rows; a role play pins its one package.
   Twins draw only on their own persona's skills; a bot's skills may come from any persona.
4. A role play's persona is picked once, at session start (`lib/agent-personas.ts`), re-checked under the session lock,
   and recorded on the session, so reports and replays stay exact. The role-play editor saves the selected personas
   together without republishing the script. It keeps the default if still selected, otherwise uses the first selection.

## Twins: main twin and topic skills

A trainer has one twin: the main twin (`data.source = "twin"`). Its topics are skills, attached as its supporting
skills. Each topic skill's package is still versioned under a topic-twin agent (its record: history, restore, copilot
updates go through it), which stays live but is shown as a skill of the main twin, never as a twin of its own.

- Publishing a **new** twin skill (`ingestTwinSkill`) appends it as active when the trainer's main twin has supporting
  skills (`attachTwinSkillToMainTwin`). Editing an existing topic leaves the trainer's selection and switches alone.
- A twin with nothing attached keeps the older behaviour: every live skill twin of its persona (`resolveTwinCatalog`).
  An org moves over once its skills are in the library (`scripts/migrate-skills.ts`); the merge then attaches each
  topic skill to the main twin.

## Bots

Their own module (`lib/bots.ts`, pages under `/bots`): persona, name, purpose, supporting skills, public calls and
widget. No link to any twin. See [public twins](public-twins.md) and [widgets](widgets.md) for the public channel.

Code: `lib/agent-personas.ts`, `lib/agent-skills.ts`, `lib/bots.ts`, `lib/twins.ts`, `lib/interview-sessions.ts`,
`lib/public-twin-sessions.ts`. Migrations `20261123190000_bot_module`, `20261123200000_agent_personas_supporting_skills`,
`20261123210000_unified_pins`.
