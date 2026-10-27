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

case "${1:-}" in
  orgs)
    # The local id's own Chroma database; tenant left empty, so the app provisions it on first use.
    port organization 'id, name, slug, logo, "createdAt", metadata, "chromaDatabase", "chromaTenantId", "websiteUrl"' \
      "SELECT $ORG_ID, name, slug, logo, \"createdAt\", metadata, 'org_' || $ORG_ID, NULL, \"websiteUrl\" FROM organization"
    ;;
  *) echo "usage: port-prod.sh orgs" >&2; exit 1 ;;
esac
