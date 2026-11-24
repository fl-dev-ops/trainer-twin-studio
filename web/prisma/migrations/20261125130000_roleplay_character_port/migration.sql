-- Port every role play to stage + characters: each (role play, persona) pair without a character gets one, written
-- from the fields that moved out of the stage (specs/agents.md rule 5). Every persona of a role play starts with the
-- same text, so nothing plays differently; trainers then edit each one. Sessions already pinned keep their snapshot.
-- Same rendering as lib/roleplay/brief.ts characterFromLegacyBrief (briefs) and the builder's old SKILL.md sections.

CREATE FUNCTION pg_temp.tt_bullets(items jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT string_agg('- ' || btrim(value), E'\n' ORDER BY ord)
  FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(items) = 'array' THEN items ELSE '[]'::jsonb END) WITH ORDINALITY AS t(value, ord)
  WHERE btrim(value) <> ''
$$;

CREATE FUNCTION pg_temp.tt_text(value jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(value) = 'string' AND btrim(value #>> '{}') <> '' THEN btrim(value #>> '{}') END
$$;

-- A builder role play's client fields (scenario.json "roleplay").
CREATE FUNCTION pg_temp.tt_from_builder(r jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(concat_ws(E'\n\n',
    CASE WHEN pg_temp.tt_text(r->'howTheyTalk') IS NOT NULL THEN '## How you talk on this call' || E'\n\n' || pg_temp.tt_text(r->'howTheyTalk') END,
    CASE WHEN pg_temp.tt_text(r->'situation'->'hiddenTruth') IS NOT NULL THEN '## What is really going on' || E'\n\n' || pg_temp.tt_text(r->'situation'->'hiddenTruth')
      || E'\n\n' || 'Never volunteer this. Reveal one piece at a time, only when the learner asks a question that genuinely earns it.' END,
    CASE WHEN pg_temp.tt_text(r->'opening') IS NOT NULL THEN '## Your opening line' || E'\n\n' || '"' || pg_temp.tt_text(r->'opening') || '"' END,
    CASE WHEN pg_temp.tt_bullets(r->'guardedIf') IS NOT NULL OR pg_temp.tt_bullets(r->'opensUpIf') IS NOT NULL THEN concat_ws(E'\n',
      '## Reactions',
      CASE WHEN pg_temp.tt_bullets(r->'guardedIf') IS NOT NULL THEN '### You get more guarded when the learner:' || E'\n' || pg_temp.tt_bullets(r->'guardedIf') END,
      CASE WHEN pg_temp.tt_bullets(r->'opensUpIf') IS NOT NULL THEN '### You open up when the learner:' || E'\n' || pg_temp.tt_bullets(r->'opensUpIf') END) END,
    CASE WHEN pg_temp.tt_text(r->'situation'->'agreesWhen') IS NOT NULL OR pg_temp.tt_text(r->'situation'->'declinesWhen') IS NOT NULL THEN concat_ws(E'\n',
      '## How you end the call',
      CASE WHEN pg_temp.tt_text(r->'situation'->'agreesWhen') IS NOT NULL THEN '- Agree: ' || pg_temp.tt_text(r->'situation'->'agreesWhen') END,
      CASE WHEN pg_temp.tt_text(r->'situation'->'declinesWhen') IS NOT NULL THEN '- Decline: ' || pg_temp.tt_text(r->'situation'->'declinesWhen') END) END
  ), '')
$$;

-- A brief's persona fields (ai.who, wants, concerns, start.openingLine, reactions, style).
CREATE FUNCTION pg_temp.tt_from_brief(b jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(concat_ws(E'\n\n',
    CASE WHEN pg_temp.tt_text(b->'ai'->'who') IS NOT NULL THEN '## Who you are here' || E'\n\n' || pg_temp.tt_text(b->'ai'->'who') END,
    CASE WHEN pg_temp.tt_text(b->'wants') IS NOT NULL OR jsonb_array_length(CASE WHEN jsonb_typeof(b->'concerns') = 'array' THEN b->'concerns' ELSE '[]' END) > 0 THEN
      '## What you want and your concerns' || E'\n\n' || concat_ws(E'\n\n', pg_temp.tt_text(b->'wants'), (
        SELECT string_agg(concat_ws(E'\n',
          '- ' || CASE WHEN (c->>'hidden')::boolean IS TRUE THEN '(hidden until earned) ' ELSE '' END || coalesce(pg_temp.tt_text(c->'concern'), ''),
          CASE WHEN pg_temp.tt_text(c->'comesUpWhen') IS NOT NULL THEN '  - Comes up when: ' || pg_temp.tt_text(c->'comesUpWhen') END,
          CASE WHEN pg_temp.tt_text(c->'resolvedWhen') IS NOT NULL THEN '  - Eased when: ' || pg_temp.tt_text(c->'resolvedWhen') END), E'\n' ORDER BY ord)
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b->'concerns') = 'array' THEN b->'concerns' ELSE '[]' END) WITH ORDINALITY AS t(c, ord))) END,
    CASE WHEN pg_temp.tt_text(b->'start'->'openingLine') IS NOT NULL THEN
      CASE WHEN b->'start'->>'who' = 'learner' THEN '## Your first reply' ELSE '## Your opening line' END || E'\n\n' || '"' || pg_temp.tt_text(b->'start'->'openingLine') || '"' END,
    CASE WHEN pg_temp.tt_bullets(b->'reactions'->'opensUpWhen') IS NOT NULL OR pg_temp.tt_bullets(b->'reactions'->'pullsBackWhen') IS NOT NULL THEN
      '## How you react' || E'\n\n' || 'You open up when the learner:' || E'\n' || coalesce(pg_temp.tt_bullets(b->'reactions'->'opensUpWhen'), '')
      || E'\n\n' || 'You pull back when the learner:' || E'\n' || coalesce(pg_temp.tt_bullets(b->'reactions'->'pullsBackWhen'), '') END,
    CASE WHEN pg_temp.tt_bullets(b->'style') IS NOT NULL THEN '## How you talk on this call' || E'\n\n' || pg_temp.tt_bullets(b->'style') END
  ), '')
$$;

WITH source AS (
  SELECT a.id,
    a.data->'roleplayBrief' AS brief,
    coalesce(sv.manifest->'roleplay', a.data->'scenario'->'roleplay') AS builder,
    coalesce(pg_temp.tt_text(sv.manifest->'trainer_role'), pg_temp.tt_text(a.data->'scenario'->'trainer_role')) AS role
  FROM "Agent" a
  LEFT JOIN "AgentSkillVersion" asv ON asv."agentId" = a.id AND asv."agentVersion" = a.version
  LEFT JOIN "SkillVersion" sv ON sv.id = asv."skillVersionId"
  WHERE a.kind = 'ROLEPLAY'
)
UPDATE "AgentPersona" ap
SET "character" = coalesce(
  CASE WHEN jsonb_typeof(s.brief) = 'object' THEN pg_temp.tt_from_brief(s.brief) END,
  CASE WHEN jsonb_typeof(s.builder) = 'object' THEN pg_temp.tt_from_builder(s.builder) END,
  -- An authored skill (built from recordings) already holds who the AI is on the call.
  '## Who you are here' || E'\n\n' || 'You play the ' || coalesce(s.role, 'role described in the skill')
    || ' on this call. The published skill describes who you are, what you know and how you behave; follow it.'
)
FROM source s
WHERE ap."agentId" = s.id AND (ap."character" IS NULL OR btrim(ap."character") = '');
