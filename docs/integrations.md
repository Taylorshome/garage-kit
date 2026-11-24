# Optional integrations and sign-in modes

Everything here is off by default. Turn a piece on in `garage.config.json`, then `npm run configure`,
`npm run secrets`, and `npm run deploy`. The setup-garage skill walks through each one.

## Sign-in modes (`auth.mode`)

### password (default)
One household password, stored only as a PBKDF2 hash in the Worker secret `PASSWORD_HASH`. Each device signs in
once (60-day session) and can add a name, so the history shows who logged what. The MCP connector's sign-in page is the
same form. Change it: `npm run set-password` (typed in your terminal). Login attempts are rate-limited per IP.

### none
No sign-in. Anyone with the URL can read, change and delete everything, upload files into your storage, run the AI
mechanic and receipt reading on your Workers AI allowance (your bill on a paid plan), allow new email senders, and
connect their own Claude. `workers.dev` addresses are easy to guess. The app shows a red bar on every page and the
connector consent page warns too. Only for a short private test.

### cloudflare-access
For people already on Cloudflare Zero Trust who want per-person logins (Google, GitHub, one-time email codes...).
1. Zero Trust -> Access -> Applications -> **Add a self-hosted application** for your garage's hostname (a custom
   domain, or the `*.workers.dev` name). Policy: Allow, the emails of your household.
2. Add a second self-hosted application for the **same hostname** with these **paths**: `mcp`, `oauth/*`,
   `.well-known/*` and a **Bypass** policy (Everyone). Claude's connector can't log in to Access; those paths are
   protected by the garage's own OAuth instead (which sends people to the Access-protected consent page).
3. Copy the first application's **Application Audience (AUD) tag** -> `auth.access.aud`, and your team domain
   (`<team>.cloudflareaccess.com`) -> `auth.access.team_domain`.
4. Configure + deploy. Everyone Access lets in becomes a member (owner) automatically; Settings lists them.

### oidc
Any OpenID Connect provider with discovery (`<issuer>/.well-known/openid-configuration`): Google, Microsoft Entra,
Auth0, Authentik, Keycloak, Pocket ID, ...
1. Create a confidential web client with redirect URI `https://<your app>/auth/callback`, scopes `openid profile email`.
2. `auth.oidc.issuer`, `auth.oidc.client_id` (and `token_auth: "post"` if the provider wants the secret in the body).
3. `npm run secrets -- --oidc-secret` (paste the client secret in your terminal).
4. Add yourself as the first member (owner) - the setup skill has the one-line D1 command - then add others in
   Settings -> Sign-in. A member is matched by email (verified) on first sign-in, then by the provider's subject.

## Notifications (web push)
`integrations.push.enabled`, `subject: "mailto:you@example.com"`. `npm run secrets` creates the VAPID keys.
Each device opts in: Settings -> Notifications -> Turn on for this device. iPhone/iPad (iOS 16.4+): only the app added
to the Home Screen can receive push. Pushes carry no content (so no encryption is needed); the app's service worker
fetches the text from the garage when one arrives.

What gets sent (also listed in Settings -> Notifications):
- due / overdue maintenance at `notify_hour` local time (each item at most once a week unless its status changes);
- on the 1st of the month, a mileage check per vehicle (tap -> its odometer box; UTVs and ATVs are asked for their
  engine hours instead, tap -> the hours box); `mileage_check: false` turns it off;
- research results and research failures (once);
- receipts that arrived by email (once each);
- health alerts from the optional health check.
An hourly cron trigger runs this (added to `wrangler.jsonc` only when a notification integration is on).

## Email-in
Forward receipts (shop invoices, parts orders, photos) and scan-tool reports to an address on your own domain.
(Docker: no domain needed; the container polls a mailbox over IMAP instead. See [docker.md](docker.md#email-in-imap).
Settings in this file are for the Cloudflare deploy; Docker takes environment variables, listed in docker.md.)
1. Your domain must be on Cloudflare. Dashboard -> the domain -> **Email** -> **Email Routing** -> enable (it adds MX
   and SPF records).
2. `integrations.email = { "enabled": true, "address": "garage@yourdomain.com" }`. Configure + deploy.
3. Email Routing -> Routing rules -> **Create address** `garage@...` -> action **Send to a Worker** -> your garage Worker.
4. In the app (owners): Settings -> Email-in -> allow your own sending address(es). Mail counts as from you when the
   **From** address is on that list and doesn't fail DMARC, or (auto-forwarded mail, where From is the shop) when the
   envelope sender is on the list and SPF passed for it. Everything else is rejected.
   Limit: email has no strong sender proof. Allowlist addresses at big providers (Gmail, Outlook, iCloud) or on a
   domain that publishes a DMARC record; a From address on a domain without DMARC can be forged. Forged mail can only
   add pending receipts (nothing is saved until someone taps Save) and scan reports.
5. Optional email **notifications**: add verified destination addresses (Email Routing -> Destination addresses) to
   `integrations.email.notify_to`; configure + deploy (adds a `send_email` binding limited to those addresses).

Receipts become "receipts to check" (nothing reaches the history until someone taps Save). Scan reports are matched to
a car by VIN or year/make/model; unmatched ones wait in the Inbox.

## Home Assistant
The garage runs on Cloudflare, so it can only reach a Home Assistant that is **reachable over HTTPS from the
internet**: a Nabu Casa Remote UI URL (`https://xxxx.ui.nabu.casa`) or your own Cloudflare Tunnel. A LAN-only HA
(`http://homeassistant.local:8123`, `192.168.x.x`) won't work; skip this integration then (web push does the same job).
1. `integrations.home_assistant = { "enabled": true, "url": "https://...", "notify_targets": ["mobile_app_your_phone"] }`
   (targets = `notify.*` service names without the `notify.` prefix; HA -> Developer tools -> Actions).
2. `npm run secrets -- --ha-token` and paste a long-lived access token (HA -> your profile -> Security).
3. Configure + deploy. You get the same notifications as push, through HA, plus `sensor.garage_due_count` (state =
   items due; attributes `overdue`, `due_soon`, `open_todos`, `url`) refreshed daily.

**Reply with the mileage right in the notification** (optional): the monthly check then carries an "Enter mileage"
text box ("Enter hours" for UTVs / ATVs, action `GARAGE_HR_<id>`). `npm run secrets -- --ha-mileage-token` creates the token (copy it from `.ha-mileage-token` into HA's
`secrets.yaml` as `garage_mileage_token`, then delete the file), deploy, and add to HA's `configuration.yaml`:

```yaml
rest_command:
  garage_mileage:
    url: "https://YOUR-GARAGE/api/ha/mileage"
    method: POST
    headers:
      Authorization: !secret garage_mileage_bearer   # in secrets.yaml: garage_mileage_bearer: "Bearer <the token>"
    content_type: "application/json"
    payload: '{"action": "{{ action }}", "reply": "{{ reply }}"}'

automation:
  - alias: "Garage: mileage reply"
    trigger:
      - platform: event
        event_type: mobile_app_notification_action
    condition:
      - "{{ trigger.event.data.action is string and (trigger.event.data.action.startswith('GARAGE_MI_') or trigger.event.data.action.startswith('GARAGE_HR_')) }}"
    action:
      - service: rest_command.garage_mileage
        data:
          action: "{{ trigger.event.data.action }}"
          reply: "{{ trigger.event.data.reply_text }}"
```
The garage accepts numbers only (commas, spaces and "mi" are fine), never lower than the current reading and at most
5,000 above it, and sends a confirmation back through HA. Hours replies (`GARAGE_HR_`): one decimal ("145.5", "145 h"),
never lower, at most 300 h above the last reading. If you set this up before 0.2.0, update the automation's condition
to the one above so hours replies reach the garage.

Polling instead (a REST sensor in HA): `npx wrangler secret put HA_POLL_TOKEN` (any long random string), then
`GET https://YOUR-GARAGE/api/due` with `Authorization: Bearer <that string>`.

## Automatic research (research worker)
See [research-worker.md](research-worker.md).
