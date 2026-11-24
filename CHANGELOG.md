# Changelog

All notable changes to Garage kit. Versions follow [semantic versioning](https://semver.org); each release has a
Docker image at `ghcr.io/taylorshome/garage-kit:<version>` and a GitHub Release with these notes.

## [0.1.0] - 2026-11-24

First versioned release.

### Added
- **Docker / Unraid self-hosting** as a second way to run the garage, next to Cloudflare. The same Worker code runs in
  workerd (Cloudflare's open-source Workers runtime) through Miniflare, with SQLite-backed D1 and KV in `/data`.
  `docker run`, `compose.yaml`, and an Unraid Community Applications template (`unraid/garage-kit.xml`).
  - Database migrations run automatically on start (idempotent), with a copy of `/data/state` taken first when an
    upgrade brings new ones.
  - Configuration by environment variables, or Docker secrets via `*_FILE`. Session key, VAPID keys and the research
    worker token are generated once and kept in `/data/secrets.json`, so restarts don't sign anyone out.
  - Hourly scheduled job (reminders, research queue, receipt notices), `/healthz` and a Docker `HEALTHCHECK`,
    graceful shutdown, non-root image, multi-arch (amd64 + arm64).
  - Outbound filter: fetches to private / LAN / metadata addresses are refused unless you configured that host
    (AI server, Home Assistant, OIDC issuer, `OUTBOUND_ALLOW_HOSTS`), checked again at connect time.
  - `TRUST_PROXY` for reverse proxies and tunnels; secure cookies whenever the request arrives over HTTPS.
  - `garage` helper in the container: `backup`, `run-scheduled`, `email-in`, `hash-password`, `research-token`. The
    kit's scripts (`add-car`, `load-research`, `seed-demo`) work against a container with `GARAGE_DOCKER=<name>`.
- **Pluggable AI** (`AI_PROVIDER`): `openai-compatible` (Ollama, LM Studio, OpenAI, OpenRouter...), `anthropic`
  (Claude API), `cloudflare-rest` (Workers AI over REST on your own account) or `none` (AI features hidden). Separate
  chat, fast and vision models. The retry / continue / fallback wrapper works the same on every provider. The
  Cloudflare deploy keeps the Workers AI binding.
- **Email-in by IMAP** for Docker: polls one mailbox folder and runs the same email handler, sender allowlist and
  DMARC/SPF check as Cloudflare Email Routing. Off by default.
- `AI_FAST_MODEL` (Cloudflare and Docker): an optional cheaper model for symptom first checks and email reading.
- The app version in Settings → About, the page footer, `/api/me` and `/api/health`.
- CI (tests + Docker build and end-to-end test) and a tag-driven release workflow (GitHub Actions, `GITHUB_TOKEN` only).
- Docs: `docs/docker.md` (quick start, settings, HTTPS with Cloudflare Tunnel / Tailscale Funnel / a reverse proxy,
  Ollama models, upgrades, backups, troubleshooting); "Choose how to host" in the README; the setup and update skills
  cover Docker.
