#!/bin/sh
# Ports prod data into the local database, one step at a time, to build a local prod replica for testing v2.
# Source: a local restore of a prod dump with the v2 migrations applied (plans/prod-migration.md), never prod itself.
#
#   SOURCE_URL=postgresql://localhost/trainertwin_prod_rehearsal TARGET_URL=postgresql://localhost/trainertwin \
#     sh scripts/port-prod.sh orgs
#
# Replica orgs get new ids, md5('local:' || prod id): each org's Chroma database (org_<orgId>, same Chroma tenant as
# prod) and S3 prefix then can't collide with prod's. Every step is idempotent (ON CONFLICT DO NOTHING).
set -eu

SOURCE_URL=${SOURCE_URL:-postgresql://localhost:5432/trainertwin_prod_rehearsal}
TARGET_URL=${TARGET_URL:-postgresql://localhost:5432/trainertwin}
case "$TARGET_URL" in *neon.tech*|*amazonaws.com*) echo "refusing: TARGET_URL must be a local database" >&2; exit 1 ;; esac
LOCAL_S3_BASE=${LOCAL_S3_BASE:-trainertwin-dev/kb}   # must match web/.env S3_BASE_PREFIX

# port <table> <column list> <select returning those columns, in order, from the source>
port() {
  table=$1 cols=$2 query=$3
  psql "$TARGET_URL" -q -v ON_ERROR_STOP=1 -c "CREATE SCHEMA IF NOT EXISTS port; DROP TABLE IF EXISTS port.\"$table\"; CREATE TABLE port.\"$table\" AS SELECT $cols FROM public.\"$table\" WITH NO DATA;"
  psql "$SOURCE_URL" -q -v ON_ERROR_STOP=1 -c "COPY ($query) TO STDOUT" |
    psql "$TARGET_URL" -q -v ON_ERROR_STOP=1 -c "COPY port.\"$table\" ($cols) FROM STDIN"
  psql "$TARGET_URL" -q -At -v ON_ERROR_STOP=1 -c "WITH ins AS (INSERT INTO public.\"$table\" ($cols) SELECT $cols FROM port.\"$table\" ON CONFLICT DO NOTHING RETURNING 1)
    SELECT '$table: ' || (SELECT count(*) FROM port.\"$table\") || ' in source, ' || count(*) || ' inserted' FROM ins; DROP TABLE port.\"$table\";"
}

ORG_ID="md5('local:' || id)::uuid::text"
local_org() { echo "md5('local:' || \"$1\")::uuid::text"; }

case "${1:-}" in
  orgs)
    # The local id's own Chroma database; tenant left empty, so the app provisions it on first use.
    port organization 'id, name, slug, logo, "createdAt", metadata, "chromaDatabase", "chromaTenantId", "websiteUrl"' \
      "SELECT $ORG_ID, name, slug, logo, \"createdAt\", metadata, 'org_' || $ORG_ID, NULL, \"websiteUrl\" FROM organization"
    ;;
  users)
    port user 'id, name, email, "emailVerified", image, "createdAt", "updatedAt"' \
      "SELECT id, name, email, \"emailVerified\", image, \"createdAt\", \"updatedAt\" FROM \"user\""
    # Password hashes kept (people sign in with their prod password); prod OAuth tokens are not copied.
    port account 'id, "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", scope, password, "createdAt", "updatedAt", issuer' \
      "SELECT id, \"accountId\", \"providerId\", \"userId\", NULL, NULL, NULL, NULL, NULL, scope, password, \"createdAt\", \"updatedAt\", issuer FROM account"
    # One admin per org: the earliest admin keeps the role, any later one becomes team (prod's careerwithvasanth had
    # both an owner and an ADMIN, which the org_roles migration both maps to admin).
    port member 'id, "organizationId", "userId", role, "createdAt", "disabledAt"' \
      "SELECT id, $(local_org organizationId), \"userId\",
         CASE WHEN role = 'admin' AND row_number() OVER (PARTITION BY \"organizationId\", role ORDER BY \"createdAt\") > 1 THEN 'team' ELSE role END,
         \"createdAt\", \"disabledAt\" FROM member"
    # Org API keys: referenceId is the org id.
    port apikey 'id, "configId", name, start, "referenceId", prefix, key, "refillInterval", "refillAmount", "lastRefillAt", enabled, "rateLimitEnabled", "rateLimitTimeWindow", "rateLimitMax", "requestCount", remaining, "lastRequest", "expiresAt", "createdAt", "updatedAt", permissions, metadata' \
      "SELECT id, \"configId\", name, start, $(local_org referenceId), prefix, key, \"refillInterval\", \"refillAmount\", \"lastRefillAt\", enabled, \"rateLimitEnabled\", \"rateLimitTimeWindow\", \"rateLimitMax\", \"requestCount\", remaining, \"lastRequest\", \"expiresAt\", \"createdAt\", \"updatedAt\", permissions, metadata FROM apikey"
    ;;
  kb)
    # Knowledge bases, sources and documents. Files are copied from prod's S3 prefix to the replica org's local one
    # (prod objects are only read), so a local delete can never remove a prod file. Documents become "uploaded": their
    # prod vectors live in prod's Chroma, and the replica orgs' Chroma databases are empty.
    # Skipped: Notion/YouTube connections (tokens encrypted with prod's key) and ingestion job history.
    # Prod keys are <base>/<prod org id>/...; the base is usually prod's, but prod's latencytest was created from a dev
    # environment and its files sit under the dev base. Whatever follows /<prod org id>/ is kept.
    newkey() { echo "CASE WHEN $1 IS NULL THEN NULL ELSE '$LOCAL_S3_BASE/' || md5('local:' || kb.\"orgId\")::uuid::text || substr($1, strpos($1, '/' || kb.\"orgId\" || '/') + length(kb.\"orgId\") + 1) END"; }
    docs="FROM \"KnowledgeDocument\" d JOIN \"KnowledgeBase\" kb ON kb.id = d.\"kbId\""
    bad=$(psql "$SOURCE_URL" -At -c "SELECT count(*) $docs WHERE NOT (strpos(d.\"s3SourceKey\", '/' || kb.\"orgId\" || '/') > 0
      AND strpos(coalesce(d.\"s3MarkdownKey\", '/' || kb.\"orgId\" || '/'), '/' || kb.\"orgId\" || '/') > 0 AND d.\"s3QuestionsKey\" IS NULL)")
    [ "$bad" = 0 ] || { echo "refusing: $bad documents have keys outside <base>/<their org id>/ (or questions files)" >&2; exit 1; }
    psql "$SOURCE_URL" -q -v ON_ERROR_STOP=1 -c "COPY (
        SELECT DISTINCT k, $(newkey k) FROM (SELECT kb.\"orgId\", unnest(array[d.\"s3SourceKey\", d.\"s3MarkdownKey\"]) k $docs) kb
        WHERE k IS NOT NULL) TO STDOUT" | bun scripts/port-prod-s3.ts
    port KnowledgeBase 'id, slug, name, "createdAt", "orgId"' \
      "SELECT id, slug, name, \"createdAt\", $(local_org orgId) FROM \"KnowledgeBase\""
    port KnowledgeSource 'id, "orgId", "kbId", connector, "externalId", "identityKey", "sourceUrl", status, "lastSyncedAt", error, "createdAt", "updatedAt"' \
      "SELECT id, $(local_org orgId), \"kbId\", connector, \"externalId\", \"identityKey\", \"sourceUrl\", status, \"lastSyncedAt\", error, \"createdAt\", \"updatedAt\" FROM \"KnowledgeSource\""
    port KnowledgeDocument 'id, "kbId", slug, title, "createdAt", "updatedAt", error, ext, "indexedAt", "s3MarkdownKey", "s3SourceKey", size, status, "sourceId", "externalId", "externalUpdatedAt", "parentExternalId", "s3QuestionsKey"' \
      "SELECT d.id, d.\"kbId\", d.slug, d.title, d.\"createdAt\", d.\"updatedAt\", d.error, d.ext, NULL, $(newkey 'd."s3MarkdownKey"'), $(newkey 'd."s3SourceKey"'), d.size,
         CASE WHEN d.status = 'failed' THEN 'failed' ELSE 'uploaded' END, d.\"sourceId\", d.\"externalId\", d.\"externalUpdatedAt\", d.\"parentExternalId\", NULL $docs"
    ;;
  *) echo "usage: port-prod.sh orgs|users|kb" >&2; exit 1 ;;
esac
