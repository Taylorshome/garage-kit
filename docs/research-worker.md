# Automatic research (optional)

Every new symptom (from the app or from Claude), and every "Research this" on a to-do, goes into a research queue.
Without this integration the queue waits for you: ask Claude Code "research the waiting symptoms" (research-car
skill) or a Claude app with the garage connected (`list_research_requests` + `save_symptom_report`). With it, a
computer of yours that's always on does it within about 10 minutes and the answer arrives as a notification.

## How it works
- `research-worker/run.sh` runs every 5 minutes (launchd on macOS, cron on Linux / Raspberry Pi).
- An idle run is one small HTTPS request: `GET /api/research-jobs/next` with the per-install token. Nothing else
  happens until a job is queued.
- For a job, it runs **your** signed-in Claude Code headless (`claude -p`) with **only** WebSearch and WebFetch
  (every other tool disallowed, no MCP servers, no settings, no session saved), in an empty temp folder, with a JSON
  schema for the answer (`research-worker/schema.json`). The symptom text and web pages are treated as untrusted data.
- The report is validated (exact keys, a safe-to-drive verdict, at least one real source URL, size cap) here and again
  on the server, then shown on the to-do, fed to the AI mechanic, and announced through your notification integration.
- A failed job is retried once by the server, then marked failed and announced once.

## Guards
| Guard | Default | Change |
|---|---|---|
| Jobs per day | 6 | `GARAGE_DAILY_MAX` in `worker.conf` |
| Time per job | 12 min | `GARAGE_TIMEOUT_MIN` |
| One run at a time | file lock | `GARAGE_LOCK` |
| Pause | `touch research-worker/PAUSED` | `rm research-worker/PAUSED` to resume |
| Heartbeat | every run, `~/.local/state/garage-research/research-heartbeat.json` | `python3 research-worker/worker.py status` |

Cost: it uses your Claude plan (one headless Claude Code run per symptom, typically 5-15 web searches/fetches).

## Install
(Docker install: the container gives you the token with `garage research-token`; see
[docker.md](docker.md#research-worker), then continue here from step 2.)
1. In `garage.config.json`: `"research_worker": { "enabled": true }`; then `npm run configure && npm run secrets && npm run deploy`.
   `npm run secrets` stores `RESEARCH_WORKER_TOKEN` on Cloudflare and writes the same token to
   `research-worker/token` (mode 600, git-ignored).
2. On the always-on computer: the kit checked out, Python 3, and Claude Code installed and signed in (`claude` works in
   a terminal). If that's a different computer, copy `research-worker/token` to it securely.
3. `cp research-worker/worker.conf.example research-worker/worker.conf` and set `GARAGE_BASE=https://<your garage>`.
   If cron/launchd can't find `claude`, set `GARAGE_CLAUDE=/full/path/to/claude`.
4. Test: `research-worker/run.sh; python3 research-worker/worker.py status` -> `"result": "idle"`.
5. `research-worker/install.sh` (uninstall: `research-worker/install.sh --uninstall`).
   - macOS: a launchd agent `com.garage.research-worker` (log: `~/Library/Logs/garage-research.log`). The Mac must stay
     awake (System Settings -> Energy: prevent automatic sleeping).
   - Linux / Pi: a crontab line (log: `research-worker/worker.log`).

## Health check and backups (same computer, optional)
- `research-worker/run-health.sh` daily (e.g. cron `35 8 * * *`): checks the site, the MCP endpoint, `/api/health`,
  the worker heartbeat and the newest backup, and sends one notification listing any problems (nothing when all is well).
- `npm run backup` nightly (cron `17 3 * * * cd /path/to/kit && npm run backup`) keeps 30 daily exports in
  `backups/d1/`; restore a table with `node scripts/d1-restore.mjs <backup> --table <name>` (dry run first, then `--apply`).
  Note: `npm run backup` needs `npx wrangler login` on that computer.
