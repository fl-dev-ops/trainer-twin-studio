# Issue 5: Local Environment Setup Script (`setup.sh`)

## Context & Objectives
Create a lightweight, dedicated `setup.sh` script to automate local environment setup, specifically handling Portless and system-level SSL certificate trust so developers can run local development without HTTPS or certificate rejection issues.

---

## Decisions & Requirements

1. **System-Level Portless Execution**
   - Portless must run at the system level.
   - Individual web/agent applications must not have to manage or configure proxy instances themselves.
   - Applications bind normally to portless aliases (`*.trainertwin.localhost`).

2. **Internal CA & Certificate Trust**
   - Script must detect and install Portless's internal root Certificate Authority (`~/.portless/ca.pem`).
   - Automatically configure environment variables for Node and Python:
     - `NODE_EXTRA_CA_CERTS=~/.portless/ca.pem`
     - `SSL_CERT_FILE=~/.portless/ca.pem`
   - Add Portless root CA to system trust store (macOS Keychain / Linux ca-certificates) so browsers (Chrome, Safari) trust `https://*.trainertwin.localhost` without security warnings.

3. **Minimal Scope**
   - Strictly focused on Portless, SSL certificates, and local proxy configuration.
   - Excludes extraneous steps like database migrations, external seeders, or package installations.

---

## Action Items

- [x] Create `setup.sh` in the repository root.
- [x] Implement Portless check: install if missing (`npm install -g portless` or via bun/brew).
- [x] Generate / verify Portless internal root CA at `~/.portless/ca.pem`.
- [x] Add platform-specific trust command for macOS (`security add-trusted-cert ...`) and Linux (`update-ca-certificates`) — delegated to `portless trust`, with a manual Keychain fallback.
- [x] Export `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE` in shell configuration or local environment.
- [x] Validate round-trip HTTPS requests to `https://dash.trainertwin.localhost` without TLS errors.

## Resolution Notes

Implemented and verified on macOS. Key decisions beyond the original plan:

- **Portless runs as a system service**: installed via `sudo portless service install --wildcard` (LaunchDaemon `sh.portless.proxy.plist`, HTTPS on 443, autostarts on boot). Applications never manage the proxy.
- **Fixed app port**: `web/portless.json` pins the web dev server to port 3000 (`appPort: 3000`); `web/package.json` scripts contain no portless references.
- **Static alias**: `portless alias trainertwin 3000` keeps `https://trainertwin.localhost` resolving even when the dev server is started directly (`bun dev` / `npm run dev`) without portless — dynamic routes vanish when their portless client exits, the alias does not.
- **Combined CA bundle**: `SSL_CERT_FILE` *replaces* the system trust store (unlike `NODE_EXTRA_CA_CERTS` which appends), so `setup.sh` builds `~/.portless/ca-bundle.pem` (system roots + portless CA). This replaces the earlier workaround of setting `SSL_CERT_FILE=agent/.local/ca-bundle.pem` in `agent/.env` (removed); `agent/src/agent.py` now falls back to the global bundle. Verified TLS to both `https://*.trainertwin.localhost` and public hosts (LiveKit, S3) from Python.
