#!/usr/bin/env bash
# TrainerTwin local setup: Portless proxy + internal CA trust.
# Scope: Portless + TLS only. No installs, migrations, or seeds.
set -euo pipefail

CA_FILE="${HOME}/.portless/ca.pem"
BASE_DOMAIN="trainertwin.localhost"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

# 1. Portless present? (Node 24+ required for npm install path)
if ! command -v portless >/dev/null 2>&1; then
  log "Portless missing, installing globally"
  if command -v bun >/dev/null 2>&1; then
    bun add -g portless
  else
    npm install -g portless
  fi
fi

# 2. CA must exist (generated on first proxy start)
if [ ! -f "$CA_FILE" ]; then
  log "Generating Portless internal CA"
  portless proxy start
  sleep 1
fi

# 3. Trust CA in the system store (macOS Keychain / Linux ca-certificates)
#    `portless trust` handles both platforms; keep env vars for Node/Python.
log "Trusting Portless CA in system trust store"
portless trust

if ! security find-certificate -a -c "Portless" /Library/Keychains/System.keychain >/dev/null 2>&1; then
  log "portless trust did not register the CA; doing it manually"
  sudo security add-trusted-cert -d -r trustRoot \
    -k /Library/Keychains/System.keychain "$CA_FILE"
fi

# Combined bundle: SSL_CERT_FILE *replaces* the system roots, so Python/Node
# clients pointed at it must see portless CA + all public roots (LiveKit,
# Sarvam, AWS would otherwise fail TLS).
SYSTEM_ROOTS="/etc/ssl/certs/ca-certificates.crt"
[ "$(uname)" = "Darwin" ] && SYSTEM_ROOTS="/etc/ssl/cert.pem"
CA_BUNDLE="${HOME}/.portless/ca-bundle.pem"
log "Building combined CA bundle at $CA_BUNDLE"
cat "$SYSTEM_ROOTS" "$CA_FILE" > "$CA_BUNDLE"

# 4. Export NODE_EXTRA_CA_CERTS / SSL_CERT_FILE in the user's shell rc
#    Non-interactive scripts have no ZSH_VERSION; trust the login shell instead.
USER_SHELL=$(basename "${SHELL:-sh}")
RC_FILE="${HOME}/.zshrc"
[ "$USER_SHELL" = "bash" ] && RC_FILE="${HOME}/.bashrc"
if ! grep -q "NODE_EXTRA_CA_CERTS.*portless" "$RC_FILE" 2>/dev/null; then
  log "Adding CA env vars to $RC_FILE"
  cat >> "$RC_FILE" <<'EOF'

# Portless internal CA (added by TrainerTwin setup.sh)
# NODE_EXTRA_CA_CERTS adds to Node's built-in roots; SSL_CERT_FILE replaces the
# default store, so it must be the combined bundle (system roots + portless CA).
export NODE_EXTRA_CA_CERTS="$HOME/.portless/ca.pem"
export SSL_CERT_FILE="$HOME/.portless/ca-bundle.pem"
export PORTLESS_WILDCARD=1
EOF
fi

# 5. System-level proxy: autostart on boot (sudo prompts in-terminal) + hosts for Safari
log "Installing Portless as a system service (autostart on boot)"
portless service install --wildcard || true
if ! portless service status 2>/dev/null | grep -q "Installed: yes"; then
  echo "FAILED: Portless system service not installed." >&2
  echo "Run once in your terminal: sudo portless service install" >&2
  exit 1
fi
log "Portless service installed — proxy autostarts on boot, no manual start needed"
portless hosts sync || echo "hosts sync skipped (needs sudo; only needed for Safari)" >&2

# 5b. Static route: the dev server may be started directly (bun dev / npm run dev)
#     without portless. Alias the URL to the fixed app port so it always resolves.
portless alias trainertwin 3000

# 6. Validation: TLS round-trip must not fail cert verification
log "Validating HTTPS against https://dash.${BASE_DOMAIN}"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://dash.${BASE_DOMAIN}" ) || {
  echo "FAILED: TLS/HTTPS request rejected. Run: portless doctor" >&2
  exit 1
}
log "HTTPS OK (HTTP ${STATUS} — app may not be running yet, TLS trust is what matters)"
echo "Done. Restart your shell (or 'source $RC_FILE') so Node/Python pick up the CA env vars."
