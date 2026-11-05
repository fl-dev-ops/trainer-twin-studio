#!/bin/sh
# Vercel build (vercel.json buildCommand, which may be at most 256 characters). Production only: apply the migrations
# over Neon's direct connection (a failed migration fails the deploy, so code never ships ahead of its schema), then
# the idempotent data backfills (non-fatal: their readers fall back until they run). Previews have no database.
set -e
if [ "$VERCEL_ENV" = "production" ]; then
  DATABASE_URL="${DATABASE_URL_UNPOOLED:?DATABASE_URL_UNPOOLED is not set}" bunx prisma migrate deploy
  bun scripts/backfill-scenario-item-versions.ts || echo "scenario item version backfill failed: searches fall back to any version until it runs"
  bun scripts/backfill-skill-sources.ts || echo "skill sources backfill failed: skills show sources not recorded until it runs"
fi
bun run build
