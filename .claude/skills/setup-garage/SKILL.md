---
name: setup-garage
description: Set up this Garage kit for the user, end to end - check prerequisites, log in to THEIR Cloudflare account, choose the name, sign-in mode and integrations, create D1/KV, set secrets, deploy, connect Claude (claude.ai, mobile, Claude Code), then add their first car. Also covers turning on or changing one piece later (password, sign-in mode, notifications, email-in, Home Assistant, automatic research, custom domain). Use when the user says "set up my garage", "install", "deploy this", or asks to change any of those settings.
---

# Set up the garage

You are installing the user's **own** copy on **their own** Cloudflare account. Talk to them in plain words, one
decision at a time, and recommend a default for each. Each numbered part below also works on its own (e.g. "turn on
notifications" = parts 2, 4 and 8c only).

Rules for the whole setup:
- Never print or echo secrets. Never ask the user to paste a password into the chat: the password is typed in **their
  own terminal** (`npm run set-password`), because your shell can't show a hidden prompt.
- Ask before: deploying (it creates real resources on their account), adding a custom domain, turning sign-in off.
- If a command fails, show the important line of the error, explain it, and fix it; don't plough on.
- Keep a short checklist in the conversation so they can see progress.

## 0. Show the disclaimer first

Before anything else, show this and ask them to confirm they understand (the app will also ask each person once):

> **Not professional advice. This information comes from AI and online research, not a certified mechanic. Verify
> before acting, follow safety precautions, and do all work at your own risk.**

Also mention the kit is MIT-licensed and provided as-is, with no warranty.

## 1. Prerequisites

Run these and fix what's missing:

```bash
node -v            # needs v22.5 or newer (https://nodejs.org); `node:sqlite` is used by the tests
git --version
npm ci             # installs wrangler locally, exact versions from package-lock.json (no global install needed)
npx wrangler --version
```

Cloudflare account: they need a free one (https://dash.cloudflare.com/sign-up). Then:

```bash
npx wrangler login      # opens their browser; they approve access to THEIR account
npx wrangler whoami     # shows the account name and id
```

If `whoami` lists more than one account, ask which one to use and remember its **account id** for the config.
If they've never used Workers, `workers.dev` needs a subdomain: Dashboard -> Workers & Pages -> it asks for one on
first visit (pick anything, e.g. their name). Mention that the app will live at `https://<worker-name>.<subdomain>.workers.dev`.

## 2. The interview (write `garage.config.json`)

Start from the example: `cp garage.config.example.json garage.config.json`, then fill it in from their answers.

1. **App name** (shown in the app and on the phone home screen). Default "Garage". -> `app_name`. Also `worker_name`
   (lowercase-dashes, e.g. `garage` or `smith-garage`; it's part of the URL).
2. **Time zone**: detect with `node -e "console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)"` and confirm. -> `timezone`.
3. **Sign-in** -> `auth.mode`. Explain the four options and **recommend the household password**:
   - `password` (recommended): one password for the household; everyone types it once per device and adds their name
     so the app shows who logged what. Claude connectors use the same sign-in.
   - `cloudflare-access`: if they already use Cloudflare Zero Trust and want per-person Google/email logins. More setup
     (docs/integrations.md#cloudflare-access).
   - `oidc`: they have their own identity provider (Google Workspace, Microsoft, Authentik, Pocket ID, Keycloak...).
     Needs issuer URL, client id and secret (docs/integrations.md#oidc).
   - `none`: **warn clearly**: anyone who finds the address can see the household's cars and change or delete
     anything, upload files, use their Workers AI allowance (their bill on a paid plan), and connect their own
     Claude to it. Only for a quick private test. The app shows a red warning bar.
     If they still want it, ask them to confirm in so many words.
4. **Address**: `workers.dev` (default, free, nothing to set up) or a **custom domain** they already have on Cloudflare
   (e.g. `garage.example.com`). Custom domain -> `domain.custom_domain`; needed anyway for email-in.
5. **Tools they own** (for AI-written diagnosis plans): e.g. "basic hand tools, jack stands, multimeter, cheap OBD-II
   reader". -> `my_tools`.
6. **Optional integrations** -> `integrations.*.enabled`. **Default: none.** Offer briefly, they can add any later:
   - **Notifications (web push)**: reminders when maintenance comes due, a monthly "what's the mileage?" nudge,
     research results, emailed receipts. Works on Android/desktop, and on iPhone once the app is added to the Home
     Screen. Recommended if they'll use it on a phone. (part 8a)
   - **Email-in**: forward receipts and scan-tool reports to `garage@their-domain`. Needs their own domain on
     Cloudflare + Email Routing. (part 8b)
   - **Home Assistant**: notifications through HA + a "garage due" sensor. Only if their HA is reachable from the
     internet (Nabu Casa, or a Cloudflare Tunnel). A LAN-only HA won't work: the app runs on Cloudflare, not at home. (part 8c)
   - **Automatic research**: "Do you have a computer that's always on (a Mac that stays awake, a Linux box, a
     Raspberry Pi)? Then I can set up automatic research: every new symptom gets researched on the web by your Claude
     Code within about 10 minutes, and you get the answer as a notification." Uses their Claude subscription (about
     one research run per symptom, capped per day). Without it, research still works on demand (research-car skill,
     or a Claude app). (part 8d)
7. **AI models**: keep the defaults in the example unless they ask. Mention: the in-app mechanic, the first-checks
   note on new symptoms and receipt reading use **Workers AI on their account**. The free plan includes a daily
   allowance of Workers AI "neurons" (10,000/day at the time of writing; check
   https://developers.cloudflare.com/workers-ai/platform/pricing/). Light household use fits; heavy chatting with the
   mechanic can run past it (then calls fail until the next day unless they're on Workers Paid).

Set `account_id` from `wrangler whoami`.

## 3. Create the database and storage (their account)

Ask first ("I'll create a D1 database and two KV namespaces on your Cloudflare account; all free-tier"), then:

```bash
npx wrangler d1 create garage                 # copy "database_id" -> resources.d1_id
npx wrangler kv namespace create garage-files # copy "id" -> resources.files_kv_id
npx wrangler kv namespace create garage-oauth # copy "id" -> resources.oauth_kv_id
```

(If the names are taken because they set up before, `npx wrangler d1 list` / `npx wrangler kv namespace list` show
the existing ids; reuse them only if it's really their earlier garage.) Put the ids in `garage.config.json`.

## 4. Configure

```bash
npm run configure      # writes wrangler.jsonc and lists the secrets this setup needs
```

Fix anything it reports and re-run until it's clean.

## 5. Deploy (ask first)

```bash
npm run deploy         # = configure + D1 migrations on their account + wrangler deploy
```

Note the URL it prints (`https://<worker>.<subdomain>.workers.dev`, or their custom domain). If it says the
workers.dev subdomain isn't registered, send them to Dashboard -> Workers & Pages to pick one, then re-run.
If it complains about the `ratelimits` bindings on their plan, explain, then delete the `ratelimits` block from the
`buildWrangler()` output in `scripts/configure.mjs` and deploy again (the app works without it; the limits only slow
down password guessing and runaway MCP clients).

## 6. Secrets

```bash
npm run secrets        # sets SESSION_SECRET and any generated keys (VAPID, research token); never prints them
```

Then, for the password mode, ask them to run this **in their own terminal** (not through you), in this folder:

```bash
npm run set-password   # type the household password twice (hidden)
```

Check with `npm run secrets` again: it ends with "all secrets set: ..." or lists what's missing.

**OIDC**: they run `npm run secrets -- --oidc-secret` in their terminal and paste the client secret there. Then add
the first member (the owner), using the email their provider sends:

```bash
npx wrangler d1 execute DB --remote --command "INSERT INTO members (id, email, name, is_owner, created_at) VALUES (lower(hex(randomblob(8))), 'THEIR@EMAIL', 'THEIR NAME', 1, strftime('%s','now'))"
```

The provider's redirect URI is `https://<their app>/auth/callback`. More members: Settings -> Sign-in in the app.

**Cloudflare Access**: follow docs/integrations.md#cloudflare-access (the app, the bypass for `/mcp`, `/oauth/*` and
`/.well-known/*`, and the AUD tag). Every email Access lets in becomes a member.

## 7. Check it works, then connect Claude

1. `curl -sI https://<their app>/ | head -3` should show a redirect to `/auth/login` (password/oidc) - or 200 for none.
2. Ask them to open the URL, sign in, and tell you what they see (an empty garage with "Add a car").
3. On a phone: open it in the browser -> Share -> **Add to Home Screen** (iPhone) / Install app (Android).
4. **Connect Claude** (the MCP server is at `https://<their app>/mcp`; sign-in is the same as the app):
   - **claude.ai** (and the Claude phone apps, which use the same connectors): Settings -> Connectors -> Add custom
     connector -> name "Garage", URL `https://<their app>/mcp` -> Add -> Connect -> sign in -> Allow.
   - **Claude Desktop**: Settings -> Connectors -> the same.
   - **Claude Code** (this one, so the other skills can use it too):
     ```bash
     claude mcp add --transport http --scope user garage https://<their app>/mcp
     ```
     then they type `/mcp`, pick `garage`, **Authenticate**, sign in, Allow. (No client id or secret: the server does
     dynamic client registration.)
   - They can disconnect any app later in Settings -> Connected Claude apps.
5. Optional quick test, in a Claude chat with the connector: "what's due in my garage?".

## 8. Optional integrations (each can be done later on its own)

After changing `garage.config.json`: `npm run configure`, `npm run secrets`, then `npm run deploy` (ask first).

### 8a. Notifications (web push)
1. `integrations.push.enabled = true`, `integrations.push.subject` = `mailto:<their email>` (push services want a contact).
2. `npm run secrets` generates the VAPID key pair (private key -> Worker secret; public key -> garage.config.json).
3. `npm run configure && npm run deploy`.
4. On each phone/computer: open the app -> Settings -> Notifications -> **Turn on for this device** -> allow.
   iPhone/iPad (iOS 16.4+): only from the Home Screen app, not a Safari tab. Then **Send a test**.
5. Reminders go out at `notify_hour` (default 8:00 their time): due/overdue maintenance (each item at most weekly),
   and on the 1st of the month a mileage check per car (tap -> straight to the odometer box). `mileage_check: false`
   turns that off.

### 8b. Email-in (receipts and scan reports by email)
Needs a domain on their Cloudflare account and Email Routing. Full steps: docs/integrations.md#email-in. In short:
1. `integrations.email = { enabled: true, address: "garage@their-domain", notify_to: ["their@verified-address"] }`
   (`notify_to` is optional: email notifications go to addresses verified in Email Routing).
2. Dashboard -> their domain -> Email -> Email Routing -> enable; Routing rules -> custom address `garage@...` ->
   action **Send to a Worker** -> their garage Worker.
3. Configure + deploy. In the app: Settings -> Email-in -> **allow their own sending address(es)** (anything else is
   rejected, as is mail failing DMARC).
4. Test: forward a receipt; they get a reply with a link to check it.

### 8c. Home Assistant
Only if HA is reachable over HTTPS from the internet (Nabu Casa URL `https://xxxx.ui.nabu.casa`, or their own
Cloudflare Tunnel). Otherwise say so and skip it.
1. `integrations.home_assistant = { enabled: true, url: "https://...", notify_targets: ["mobile_app_their_phone"] }`
   (targets are the `notify.*` service names without `notify.`; find them in HA -> Developer tools -> Actions).
2. In their terminal: `npm run secrets -- --ha-token` and paste a long-lived token (HA -> Profile -> Security).
3. Configure + deploy. The app then sends notifications through HA and keeps `sensor.garage_due_count` updated daily.
4. Optional: type the mileage right in the monthly notification: `npm run secrets -- --ha-mileage-token` (in their
   terminal), deploy, and add the automation + rest_command from docs/integrations.md#home-assistant to HA.
5. Optional: an HA REST sensor can poll `GET /api/due` with a bearer token: `npx wrangler secret put HA_POLL_TOKEN`
   (they paste a random string, and put the same in HA).

### 8d. Automatic research (always-on computer)
On the always-on machine (can be this one), which needs Python 3 and Claude Code signed in to their own account:
1. `integrations.research_worker.enabled = true`; `npm run configure && npm run secrets && npm run deploy`.
   `npm run secrets` writes the per-install token to `research-worker/token` (mode 600).
2. If the worker runs on a different computer: clone the kit there too and copy just that token file over securely
   (e.g. `scp`), or re-run `npm run secrets -- --rotate-research-token` there after `npx wrangler login`.
3. `cp research-worker/worker.conf.example research-worker/worker.conf` and set `GARAGE_BASE=https://<their app>`.
   Check `claude --version` works in a plain shell; set `GARAGE_CLAUDE=` to its full path if cron/launchd can't find it.
4. Try one run by hand: `research-worker/run.sh && python3 research-worker/worker.py status` (expect "idle").
5. Install the schedule: `research-worker/install.sh` (launchd on macOS, a crontab line on Linux/Pi). Show them the
   result (`launchctl list | grep garage` or `crontab -l`).
6. Offer the daily health check and nightly backup on the same computer (docs/research-worker.md, last section).
7. Explain the guards: max 6 jobs a day (`GARAGE_DAILY_MAX`), 12 minutes each, one at a time, `touch
   research-worker/PAUSED` to pause, heartbeat in `~/.local/state/garage-research/`. Details: docs/research-worker.md.

### Change the password / sign-in later
- New password: `npm run set-password` in their terminal (old sign-ins stay until they sign out or expire).
- Switch mode: change `auth.mode` (+ its settings), `npm run configure && npm run secrets`, deploy. Turning a
  no-sign-in garage into a password one: set `password`, have them run `npm run set-password`, deploy.

### Backups
`npm run backup` exports the whole database to `backups/d1/` (git-ignored). D1 also keeps 30 days of point-in-time
history (`npx wrangler d1 time-travel info garage`). If they have the always-on computer, offer a nightly cron for
`npm run backup` there.

## 9. Hand off

Say what's done (URL, sign-in mode, what's enabled, Claude connected where), then: "Want to add your first car?"
-> follow `.claude/skills/add-car/SKILL.md`.

For local testing with fake data first (no deploy): `docs/development.md` (`npm run demo`).
