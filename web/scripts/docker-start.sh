#!/bin/sh
# Container entrypoint for web/Dockerfile. Migrations are OPT-IN: set RUN_MIGRATIONS=1 only on a database this
# deployment owns (never point a test deployment with RUN_MIGRATIONS=1 at a production database).
set -e
if [ "${RUN_MIGRATIONS:-0}" = "1" ]; then
  echo "[start] prisma migrate deploy"
  ./node_modules/.bin/prisma migrate deploy
fi
exec ./node_modules/.bin/next start -H "${HOSTNAME:-0.0.0.0}" -p "${PORT:-3000}"
