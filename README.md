# Garage

A car-maintenance app for your household, styled like a video-game garage. It runs on **your own** Cloudflare
account, and **your own** Claude sets it up, adds your cars and researches them.

<p>
<img src="docs/images/phone-garage.png" width="220" alt="Garage select screen on a phone">
<img src="docs/images/phone-diagnosis.png" width="220" alt="Guided diagnosis step">
<img src="docs/images/phone-research.png" width="220" alt="Research tab">
</p>
<img src="docs/images/desktop-maintenance.png" width="700" alt="Maintenance schedule on desktop">

*(Screenshots from the built-in demo car; all its data is made up.)*

**What it does:** maintenance schedules with what's due, catch-up for unknown history, one-tap service logging,
symptoms with a quick "first things to check" from an AI mechanic, guided step-by-step diagnosis, receipts read
from a photo, parts and brand alternates with a shopping list, repair guides, researched recalls / TSBs / known issues,
a chat with an AI mechanic that knows your car, and a 3D garage (six body styles in your paint color, or upload your
own .glb). Claude can use all of it through the built-in MCP connector: claude.ai, the Claude phone apps, Claude
Desktop and Claude Code. Full list: [docs/features.md](docs/features.md).

## Get started

1. Clone this repo.
2. Open [Claude Code](https://claude.com/claude-code) in the folder.
3. Say **"set up my garage"**.

Claude checks Node, logs you in to your Cloudflare account (`wrangler login`), asks a few questions (name, sign-in,
optional extras), creates the database, deploys, connects itself to the app, and then helps you add your first car
and research it. Nothing goes through anyone else's account, server or Claude subscription.

Want to look first? `npm ci && npm run demo` runs it locally with a fake demo car (see [docs/development.md](docs/development.md)).

## What it costs

- **Cloudflare Workers free plan** is plenty for a household: 100,000 requests/day, D1 and KV free tiers. The
  Workers Paid plan ($5/month) is only needed for heavy use.
- **Workers AI** (the in-app mechanic, the first-checks note, reading receipt photos) runs on your account. The free
  daily allowance (10,000 neurons/day when this was written;
  [current pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)) covers light use; past it, AI
  calls fail until the next day unless you're on Workers Paid.
- **Research** is done by your own Claude (Claude Code or a Claude app), so it uses your Claude plan.
- A custom domain is optional (only needed for email-in).

## Optional pieces (all off by default)

| Piece | What you need |
|---|---|
| Sign-in: household password (default), Cloudflare Access, your own OIDC provider, or none (with loud warnings) | nothing extra for the password |
| Notifications (web push): due reminders, monthly mileage check, research results | nothing; on iPhone add the app to the Home Screen |
| Email-in: forward receipts and scan-tool reports | your own domain on Cloudflare + Email Routing |
| Home Assistant notifications and a "due" sensor | HA reachable from the internet (Nabu Casa or a Cloudflare Tunnel) |
| Automatic research of every new symptom | an always-on computer (Mac, Linux box, Raspberry Pi) with Claude Code |

Details: [docs/integrations.md](docs/integrations.md), [docs/research-worker.md](docs/research-worker.md).

## Disclaimer

**Not professional advice. This information comes from AI and online research, not a certified mechanic. Verify
before acting, follow safety precautions, and do all work at your own risk.**

The app shows this on every page, asks each person to acknowledge it once, and tells Claude to mention it when
giving repair guidance. Research and AI answers can be wrong, out of date or about a different engine or trim: check
part numbers and specs for your exact vehicle (VIN), use jack stands, and see a professional when in doubt.

## License

[MIT](LICENSE). Provided **as is, without warranty of any kind**; you use it, and do any work on your vehicles, at
your own risk. Third-party components and their licenses: [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
