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

- [ ] Create `setup.sh` in the repository root.
- [ ] Implement Portless check: install if missing (`npm install -g portless` or via bun/brew).
- [ ] Generate / verify Portless internal root CA at `~/.portless/ca.pem`.
- [ ] Add platform-specific trust command for macOS (`security add-trusted-cert ...`) and Linux (`update-ca-certificates`).
- [ ] Export `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE` in shell configuration or local environment.
- [ ] Validate round-trip HTTPS requests to `https://dash.trainertwin.localhost` without TLS errors.
