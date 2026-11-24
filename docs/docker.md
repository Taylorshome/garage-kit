# Running the garage with Docker (or Unraid)

The second way to host the garage, next to [Cloudflare](../README.md#choose-how-to-host). The image runs the **same
Worker code** as the Cloudflare deploy, in [workerd](https://github.com/cloudflare/workerd) (Cloudflare's
open-source Workers runtime) through [Miniflare](https://github.com/cloudflare/workers-sdk/tree/main/packages/miniflare),
the engine `wrangler dev` uses. A small Node server in front adds what Cloudflare otherwise provides: database
migrations, the hourly job, an outbound network filter, proxy handling, email-in by IMAP and a health check.

Everything lives in one folder mounted at `/data`:

| Path | What |
|---|---|
| `/data/state/` | the database (SQLite, as D1) and stored files (KV): cars, history, receipts, photos, research |
| `/data/secrets.json` | generated session key, VAPID (push) keys, research-worker token (mode 600) |
| `/data/backups/` | automatic copies of `state/` taken before an upgrade migrates the database, and `garage backup` dumps |

Images: `ghcr.io/taylorshome/garage-kit:<version>` (e.g. `0.2.0`), `:<major.minor>` (e.g. `0.2`) and `:latest`,
for linux/amd64 and linux/arm64 (Raspberry Pi 4/5 with a 64-bit OS works).

> **Not professional advice.** This information comes from AI and online research, not a certified mechanic. Verify
> before acting, follow safety precautions, and do all work at your own risk.

## Quick start

### docker run
```bash
mkdir -p garage-data
docker run -d --name garage-kit --restart unless-stopped \
  -p 8787:8787 -v "$PWD/garage-data:/data" \
  -e TZ=America/Chicago -e GARAGE_PASSWORD='choose-a-long-household-password' \
  ghcr.io/taylorshome/garage-kit:0.2
```
Open `http://<this machine>:8787`, sign in with the password, add a car. Want to look around first?
`docker exec garage-kit node scripts/seed-demo.mjs` adds a made-up demo car (`--bike --utv` also a demo motorcycle and side-by-side; delete them in the app afterwards).

The container runs as uid 1000 by default. If the data folder belongs to someone else, it stops with a message
saying how to fix it: `sudo chown -R 1000:1000 garage-data`, or run it as the folder's owner with `--user`.

### Docker Compose
From a clone of this repo (or just download `compose.yaml` and `docker/garage.env.example`):
```bash
cp docker/garage.env.example .env       # edit it: password, time zone, AI, PUBLIC_URL...
docker compose up -d
docker compose logs -f garage           # "listening on 0.0.0.0:8787" when it's ready
```
`.env` holds secrets: keep it out of git (it's in `.gitignore`) and readable only by you (`chmod 600 .env`).
Prefer files? Every secret also works as `NAME_FILE=/run/secrets/name` (see the commented `secrets:` block in
`compose.yaml`).

### Unraid
The template is at `https://raw.githubusercontent.com/Taylorshome/garage-kit/main/unraid/garage-kit.xml`
(it isn't in Community Applications yet).
1. Unraid terminal (the `>_` icon), download it into your user templates:
   ```bash
   wget -O /boot/config/plugins/dockerMan/templates-user/my-garage-kit.xml \
     https://raw.githubusercontent.com/Taylorshome/garage-kit/main/unraid/garage-kit.xml
   ```
   (Alternative: Docker tab → Add Container → **Template repositories** box at the bottom → add
   `https://github.com/Taylorshome/garage-kit` → Save; templates from that repo then show up in the list.)
2. Docker tab → **Add Container** → Template: **garage-kit** (under User templates). Set the household password and time zone, keep Data at `/mnt/user/appdata/garage-kit`,
   choose an AI provider (or leave it at none) and Apply.
3. WebUI from the container's menu. The template runs as `99:100` (Unraid's nobody:users), so appdata permissions
   just work, and gives it 30 seconds to stop cleanly.
4. Back up `/mnt/user/appdata/garage-kit` with your usual appdata backup (it stops the container first).

With Claude Code you can also say **"set up my garage with Docker"** in this repo: the setup skill writes the
compose file and `.env` with you (passwords typed in your own terminal) and walks through HTTPS and connecting Claude.

## Settings

All optional except a password (in password mode). Secrets: also as `NAME_FILE`.

| Variable | Default | What |
|---|---|---|
| `APP_NAME` | `Garage` | Shown in the app and on the phone home screen |
| `TZ` | `UTC` | IANA time zone for dates and the daily reminder (`TIMEZONE` also works) |
| `PUBLIC_URL` | (none) | Your public HTTPS origin, e.g. `https://garage.example.com`. Needed for Claude connectors (OAuth/MCP), phone notifications and links in notifications/emails |
| `TRUST_PROXY` | `0` | `1` when a reverse proxy or tunnel is in front: trust `X-Forwarded-Proto/Host/For`. Leave `0` if clients reach the container directly (they could fake those headers) |
| `PORT` | `8787` | Port inside the container |
| `AUTH_MODE` | `password` | `password`, `oidc`, `cloudflare-access`, or `none` (anyone who reaches it can change everything; the app shows a warning bar) |
| `GARAGE_PASSWORD` | | Household password (hashed at start; never stored in plain text). Changing it and restarting changes the password |
| `PASSWORD_HASH` | | Instead of `GARAGE_PASSWORD`: `docker exec -it garage-kit garage hash-password` prints one |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | | `AUTH_MODE=oidc` ([docs/integrations.md](integrations.md#oidc)); redirect URI `<PUBLIC_URL>/auth/callback`. Also `OIDC_SCOPE`, `OIDC_TOKEN_AUTH=post` |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | | `AUTH_MODE=cloudflare-access` behind a Cloudflare Tunnel + Access app |
| `AI_PROVIDER` | `none` | `openai-compatible`, `anthropic`, `cloudflare-rest`, `none` ([AI](#ai)) |
| `AI_BASE_URL`, `AI_API_KEY` | | `openai-compatible`: e.g. `http://192.168.1.10:11434/v1` (Ollama); key if the server needs one |
| `AI_CHAT_MODEL`, `AI_CHAT_FALLBACK` | per provider | The mechanic (chat, diagnosis plans) and its backup model |
| `AI_FAST_MODEL` | chat model | Cheaper/faster model: symptom first checks, reading emailed scan reports |
| `AI_VISION_MODEL`, `AI_VISION_FALLBACK` | per provider | Reads receipt photos |
| `ANTHROPIC_API_KEY` | | `anthropic` |
| `CF_ACCOUNT_ID`, `CF_API_TOKEN` | | `cloudflare-rest` (token permission: Workers AI Read + Edit) |
| `INTEGRATIONS` | automatic | Comma list (`push,email,home_assistant,research_worker`). Unset = switched on by their settings: push when `PUBLIC_URL` is https, email when `IMAP_HOST` is set, HA when `HA_URL`+`HA_TOKEN` are set, research worker when `RESEARCH_WORKER=on` |
| `VAPID_SUBJECT` | | `mailto:you@example.com` for push services (VAPID keys are generated and kept in `/data`) |
| `IMAP_HOST`, `IMAP_USER`, `IMAP_PASS` | | Email-in ([below](#email-in-imap)). Also `IMAP_PORT` (993), `IMAP_TLS`, `IMAP_FOLDER` (`INBOX`), `IMAP_PROCESSED_FOLDER`, `IMAP_POLL_SECONDS` (120), `MAIL_ADDRESS` (shown in the app; defaults to `IMAP_USER`) |
| `HA_URL`, `HA_TOKEN`, `HA_NOTIFY_TARGETS` | | Home Assistant notifications + due sensor. A LAN address is fine here. Also `HA_POLL_TOKEN`, `HA_MILEAGE_TOKEN` ([integrations.md](integrations.md#home-assistant)) |
| `RESEARCH_WORKER` | `off` | `on` = enable the research queue for the [research worker](#research-worker); token via `garage research-token` |
| `NOTIFY_HOUR` | `8` | Local hour for the daily due reminder |
| `MILEAGE_CHECK` | `on` | Monthly mileage notification |
| `OWNER_TOOLS` | | Your tools, for AI-written diagnosis plans |
| `GLB_MAX_MB` | `15` | Largest uploaded 3D model |
| `OUTBOUND_ALLOW_HOSTS` | | Extra private hosts the app may call (comma list), see [Security](#security) |
| `MAX_UPLOAD_MB` | `60` | Largest request body |
| `BACKUPS_KEEP` | `10` | Automatic pre-migration copies kept |
| `CRON` | `on` | `off` stops the hourly job |
| `LOG_LEVEL` | `info` | `debug` shows workerd's own logs |

## HTTPS

The app works over plain HTTP on your LAN. **Claude connectors** (claude.ai, the Claude apps) and **iPhone
notifications** need a public HTTPS address. Pick one, set `PUBLIC_URL` to it and `TRUST_PROXY=1`. Then connect
Claude with `<PUBLIC_URL>/mcp` (Settings in the app shows the exact steps).

### Option 1: Cloudflare Tunnel (no open ports)
Needs a free Cloudflare account with your domain on it. `docker/compose.cloudflared.yaml` runs `cloudflared`
next to the garage:
1. Cloudflare dashboard → Zero Trust → Networks → Tunnels → **Create a tunnel** (Cloudflared) → copy the token into
   `.env` as `TUNNEL_TOKEN=...`.
2. Add a **public hostname**: `garage.example.com` → service `http://garage:8787`.
3. In `.env`: `PUBLIC_URL=https://garage.example.com`, `TRUST_PROXY=1`.
4. `docker compose -f docker/compose.cloudflared.yaml --env-file .env up -d`.
The garage has no published port in that file; add `ports: ["8787:8787"]` to also reach it on the LAN.
Optional extra lock: put a Cloudflare Access application in front and use `AUTH_MODE=cloudflare-access` (bypass
`/mcp`, `/oauth/*` and `/.well-known/*` for Claude, as in [integrations.md](integrations.md#cloudflare-access)).

### Option 2: Tailscale Funnel
On the Docker host with Tailscale installed: `tailscale funnel --bg 8787`. It prints
`https://<machine>.<tailnet>.ts.net`; set that as `PUBLIC_URL` with `TRUST_PROXY=1`. Funnel must be allowed in
your tailnet's access controls. (Tailscale Serve, without Funnel, is HTTPS inside your tailnet only: fine for your
own devices, but claude.ai can't reach it.)

### Option 3: a reverse proxy (Nginx Proxy Manager or SWAG on Unraid)
- **Nginx Proxy Manager**: Proxy Hosts → Add: domain `garage.example.com`, scheme `http`, forward host = the Unraid
  IP, port `8787`; SSL tab: request a Let's Encrypt certificate, Force SSL. In Advanced add `proxy_buffering off;`
  so the mechanic's answers stream.
- **SWAG**: copy a subdomain sample conf to `garage.subdomain.conf` with `set $upstream_app <unraid-ip>;`
  `set $upstream_port 8787;` `set $upstream_proto http;`, plus `proxy_buffering off;`.
- Forward port 443 on your router to the proxy (or put the proxy behind a Cloudflare Tunnel).
With `TRUST_PROXY=1`, don't also publish 8787 to the whole LAN if you can avoid it (bind it to the proxy's network
or `127.0.0.1:8787:8787`): anyone reaching the port directly could fake the forwarded client address.

## AI

The in-app mechanic, the "first things to check" note on new symptoms, guided diagnosis plans written by AI, and
reading receipts and scan reports use the AI provider. Research (recalls, TSBs, known issues) is always done by your
own Claude, not by this setting.

| `AI_PROVIDER` | Cost | Set |
|---|---|---|
| `none` (default) | free | nothing; AI parts are hidden, receipts are filled in by hand, plans from research only |
| `openai-compatible` | your hardware, or the service's prices | `AI_BASE_URL`, `AI_CHAT_MODEL`, optionally `AI_VISION_MODEL`, `AI_FAST_MODEL`, `AI_API_KEY` |
| `anthropic` | Claude API prices, billed to your key | `ANTHROPIC_API_KEY`; defaults `claude-opus-5-5` (chat, vision), `claude-haiku-5-5` (fast), `claude-sonnet-5-5` (fallback) |
| `cloudflare-rest` | Workers AI free daily allowance, then Workers Paid | `CF_ACCOUNT_ID`, `CF_API_TOKEN`; same default models as the Cloudflare deploy |

Every provider goes through the same safety net as on Cloudflare: a cut-off answer is continued, an empty one
retried, then the fallback model takes over, with timeouts throughout; failures show up in `/api/health`.
PDF receipts and reports are turned into text inside the container (no AI needed); photos need a vision model.

### Ollama (on the same Unraid box or another machine)
```bash
ollama pull qwen3:14b      # the mechanic
ollama pull qwen3:8b       # optional fast model
ollama pull qwen2.5vl:7b   # receipt photos
```
```
AI_PROVIDER=openai-compatible
AI_BASE_URL=http://192.168.1.10:11434/v1     # the Ollama host; the Docker host's LAN IP, not "localhost"
AI_CHAT_MODEL=qwen3:14b
AI_FAST_MODEL=qwen3:8b
AI_VISION_MODEL=qwen2.5vl:7b
```
- Set **`OLLAMA_CONTEXT_LENGTH=16384`** (or more) on the Ollama container: the mechanic's prompt carries the car's
  history and research, and Ollama's small default context silently cuts it.
- Realistic hardware: a 14B model at 4-bit needs about 10-12 GB of GPU memory (e.g. a 12-16 GB NVIDIA card with the
  Unraid NVIDIA driver plugin) and answers in 10-30 seconds. An 8B model fits in about 6-8 GB. **CPU only** works
  for 7-8B models with 16 GB+ RAM but is slow: a few words per second, a minute or two per answer, and receipt
  photos may hit the 2-minute read timeout (type those in, or use a GPU or a hosted provider for vision).
- Thinking models (qwen3) spend tokens reasoning before answering; that's handled, it just takes longer.
- Alternatives: `llama3.1:8b` (chat), `gemma3:12b` (chat + vision in one), `llava:7b` (older, weaker vision).
- LM Studio: `AI_BASE_URL=http://<host>:1234/v1`. OpenAI: `https://api.openai.com/v1` + key + a model id.
  OpenRouter: `https://openrouter.ai/api/v1` + key + any model id.
- The AI server's host is allowed through the outbound filter automatically (it's usually a LAN address).

## Email-in (IMAP)

Forward receipts and scan-tool reports to a mailbox the garage polls; each one goes through the same pipeline as
Cloudflare Email Routing: sender allowlist (Settings → Email-in in the app), DMARC/SPF verdicts from the receiving
provider's `Authentication-Results`, then receipt or scan report.
1. Make a mailbox **only the garage reads** (e.g. a new Gmail/Fastmail/iCloud address, or a folder your filters move
   mail into). Use a provider that adds `Authentication-Results` (Gmail, Fastmail, iCloud, Outlook.com do).
   Gmail/iCloud/Outlook need an **app password** for IMAP.
2. `IMAP_HOST=imap.gmail.com`, `IMAP_USER=...`, `IMAP_PASS=...` (optionally `IMAP_FOLDER`, and
   `IMAP_PROCESSED_FOLDER=Processed` to move handled mail there). Restart.
3. In the app: Settings → Email-in → allow your own sending address(es). Unseen messages are processed every
   `IMAP_POLL_SECONDS` and marked read; rejected ones are also flagged. No email replies are sent in this mode: the
   receipt shows up in the app (and as a notification).
Test without sending mail: `docker exec -i garage-kit garage email-in < message.eml`.

## Research worker

Automatic research of new symptoms runs **outside** the container, on any always-on computer with Python 3 and
Claude Code signed in to your own account (it can be the Docker host if it has those; Unraid itself usually
doesn't, so use a Mac, Linux box or Pi). Claude Code in a container would need your Claude login inside it, so the
kit doesn't do that.
1. `RESEARCH_WORKER=on`, restart.
2. On the worker computer, in a clone of this repo:
   `ssh <docker-host> docker exec garage-kit garage research-token > research-worker/token && chmod 600 research-worker/token`
3. `cp research-worker/worker.conf.example research-worker/worker.conf`, set `GARAGE_BASE` to the garage's address
   (`PUBLIC_URL`, or `http://<docker-host>:8787` on the LAN), then follow [research-worker.md](research-worker.md)
   from "Try one run by hand".

## Upgrade

```bash
docker compose pull && docker compose up -d         # or: docker pull ghcr.io/taylorshome/garage-kit:0.2, re-create
```
Unraid: Docker tab → **Check for Updates** → apply. On start the container compares the database with the image's
migrations; when there are new ones it copies `/data/state` to `/data/backups/<time>-before-<migration>/` first,
then applies them (each in one transaction). Migrations only add tables and columns. Pin `:0.2` (bug fixes) or an
exact version to upgrade on your own schedule; read [CHANGELOG.md](../CHANGELOG.md) before jumping a minor version.

**Roll back**: stop the container, move `/data/state` aside, copy the matching `/data/backups/...-before-.../` back
to `/data/state`, start the previous image tag.

## Backup and restore

- **Whole folder (recommended)**: stop the container, copy `/data` (e.g. `tar czf garage-$(date +%F).tgz garage-data`),
  start it. Unraid's appdata backup does this for you. Restore = put the folder back and start.
- **While running**: `docker exec garage-kit garage backup` writes a full SQL dump to `/data/backups/garage-<time>.sql`
  (rows and schema; uploaded files stay in `/data/state/kv`). Good for a nightly cron and for inspecting data.
- The kit's loaders (`scripts/load-research.mjs`) back up the tables they touch to `/data/backups/d1/` before writing.

## Using the kit's scripts with Docker

`add-car`, `load-research` and `seed-demo` talk to the container's database when `GARAGE_DOCKER` names the
container (they run `docker exec garage-kit garage d1 ...`; `--local`/`--remote` don't matter then):
```bash
GARAGE_DOCKER=garage-kit node scripts/load-research.mjs --car "Civic" --dir research/civic --dry-run
```
Inside the container they work as they are: `docker exec garage-kit node scripts/seed-demo.mjs`.
Also in the container: `garage run-scheduled` (run the hourly job now), `garage hash-password`,
`garage research-token`, `garage backup`, `garage email-in`.

## Security

- Non-root image, no secrets baked in; secrets come from env vars or `*_FILE` and are never logged.
- Password sign-in: PBKDF2 hashes, `HttpOnly; SameSite=Lax` cookies, `Secure` whenever the request arrived over
  HTTPS (your `PUBLIC_URL` host, or `X-Forwarded-Proto: https` with `TRUST_PROXY=1`), and the same per-IP login and
  MCP rate limits as on Cloudflare.
- **Outbound filter**: on Cloudflare, Workers can't reach private networks. In a container on your LAN the garage
  enforces the same: every outbound request (push services, NHTSA, OAuth client metadata, ...) is resolved and
  refused if it points at a private, loopback, link-local (cloud metadata), CGNAT or other special address, and the
  connection uses the address that was checked. Hosts you configure are allowed: `AI_BASE_URL`, `HA_URL`,
  `OIDC_ISSUER`, plus `OUTBOUND_ALLOW_HOSTS`. The IMAP host is contacted by the server itself.
- The same Content-Security-Policy and security headers as on Cloudflare.
- Internal endpoints (`/__garage/*`) and the scripts' admin port (127.0.0.1:8788 inside the container, token in
  `/data/.admin-token`) are not reachable from outside.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Exits with "/data is not writable by uid ..." | `chown` the host folder to that uid, or run with `--user <uid>:<gid>` of the folder's owner |
| "configuration problems: ..." at start | the message names the missing/invalid variable |
| Sign-in loops, or cookies don't stick over HTTPS | set `PUBLIC_URL` to the exact address you open, and `TRUST_PROXY=1` behind a proxy |
| "Cross-origin request refused" | you opened it under a different address than the proxy forwards; check `PUBLIC_URL` and the proxy's Host header |
| Claude connector fails to connect | `PUBLIC_URL` must be public HTTPS; `curl https://<host>/.well-known/oauth-protected-resource/mcp` must show that address |
| Mechanic answers arrive all at once | turn off proxy buffering (`proxy_buffering off;`) |
| AI errors | `docker logs garage-kit`; check `AI_BASE_URL` from inside: `docker exec garage-kit node -e "fetch(process.env.AI_BASE_URL+'/models').then(r=>console.log(r.status))"` |
| "outbound blocked: ... private address" in the log | expected for unknown LAN hosts; add the host to `OUTBOUND_ALLOW_HOSTS` if you meant it |
| Health check unhealthy | `docker logs garage-kit`; `docker exec garage-kit node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>r.text()).then(console.log)"` |
| Migration failed on upgrade | nothing after the failing file was applied; the copy in `/data/backups/` is from just before. Open an issue with the log |
