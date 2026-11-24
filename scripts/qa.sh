#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

mode=${1:-full}
case "$mode" in
  full|quick) ;;
  -h|--help)
    echo 'Usage: bash scripts/qa.sh [full|quick]'
    exit 0
    ;;
  *)
    echo 'Usage: bash scripts/qa.sh [full|quick]' >&2
    exit 2
    ;;
esac

if [[ "$mode" == full ]]; then
  if ! curl --silent --max-time 3 --output /dev/null http://127.0.0.1:9100/; then
    echo 'Start the local S3 emulator on port 9100 before running full QA. See README.md.' >&2
    exit 1
  fi
  export E2E_LOCAL_LIVEKIT=0
  export BETTER_AUTH_SECRET=local-qa-only-better-auth-secret-for-tests
  (cd web && bun run test:setup)
fi

(cd chat && bun run typecheck && bun run test)
(cd copilot && bun run typecheck && bun run test)
(cd agent && uv run --locked pytest -q)
(cd web && bun run test:unit)

if [[ "$mode" == full ]]; then
  (cd web && bun run test:db && bun run test:flows && bun run typecheck:e2e)
  (cd web && bun run test:e2e && bun run test:workspace)
fi
