# Features

Everything the original single-household garage app does, and where it stands in this kit.

- **Built in**: works after the basic setup (your Cloudflare account, the default password sign-in).
- **Integration**: needs an optional integration, named in the row.
- **Not included**: left out, with the reason.

## Garage, vehicles and 3D

| Feature | Status |
|---|---|
| 3D garage select screen (turntable, swipe between cars, keyboard) | Built in |
| Roll-up garage door intro (once per session, tap to skip, off with reduced motion) | Built in |
| Car models in the owner's paint color | Built in: six procedural body styles (sedan, coupe, hatchback, minivan, SUV, pickup) |
| Vehicle types: cars, trucks, vans, SUVs, **motorcycles, side-by-sides (UTV) and ATVs** (`vehicle_type` drives schedules, fluids warnings, parts sources, recalls and wording; existing cars get theirs from the body style) | Built in (0.2.0) |
| Procedural 3D motorcycles (cruiser, sport, dual-sport, scooter), UTV and ATV in the owner's color; picked by body style, then type and make/model (V Star, Vulcan, Shadow -> cruiser; RZR, Maverick, Talon -> UTV; Grizzly, Sportsman -> ATV) | Built in (0.2.0); the body-style picker on Add / Edit offers them per type |
| Drivetrain facts for bikes / off-road (final drive, cooling, carbs or EFI, clutch, shared sump) and "needs info" placeholders (VIN, mileage, hours, color, variant) | Built in (0.2.0) |
| Exact 3D model of your own car | Built in: upload your own .glb per car (Edit car; stored in KV, size cap `glb_max_mb`, default 15 MB) |
| The original's real-car meshes (two converted third-party STL/GLB models) | **Not included**: third-party models that can't be redistributed |
| The original's three specific cars, VINs, research, history | **Not included**: personal data. The demo car (`npm run demo`) shows everything with made-up data; `node scripts/seed-demo.mjs --bike --utv` adds a demo V Star 650 (real public research for the model) and a demo side-by-side on engine hours |
| SVG fallback without WebGL | Built in (six body styles, plus bike / UTV / ATV art) |
| Add / edit / archive vehicles, VIN, photos ("my car") | Built in; plus "Look up" from the VIN (NHTSA vPIC: motorcycles map automatically; UTVs/ATVs by model name or by hand, since vPIC covers them poorly) |
| Health score, next service, open issues per car | Built in |

## Maintenance

| Feature | Status |
|---|---|
| Schedule items with mile / month intervals, overdue / soon / ok / unknown | Built in |
| **Engine hours**: hours intervals, due by miles, hours or date (whichever comes first), hours log and hours/month | Built in (0.2.0); hours come in through Update hours, + Log, Log service, Set last done, catch-up, receipts, MCP `update_hours` / `log_service` hours, and the monthly check |
| Date-only items (months only: tire age, battery tending, brake fluid) | Built in (0.2.0) |
| "Due now" override, severe-service variants, manual / typical source chips | Built in |
| Catch-up screen (approximate last-done, miles from miles/month) | Built in |
| Quick log (+ Log), service history, files on services | Built in |
| Due list across cars | Built in |
| Mileage log and miles/month | Built in |
| Starter schedule for a new vehicle | Built in, per type, "typical, check your owner's manual": cars 12 generic items; motorcycles by final drive (chain / shaft final gear oil / belt), cooling (coolant only if liquid-cooled) and fuel system (carb sync + stabilizer if carbureted), plus valves, fork oil, brake fluid, battery tending, tire age; UTV / ATV by hours (2024 RZR XP 1000 / 2022 Sportsman 570 charts) with water-crossing notes. Also in the add-car skill / script and MCP `add_car` |
| Owner's-manual schedule | Built in via research (research-car skill, `--schedule`) |

## Symptoms, to-dos, AI mechanic

| Feature | Status |
|---|---|
| "Add a new symptom" (kind/when/where chips, photos/videos, dedupe) | Built in |
| AI "first things to check, cheapest first" note on every new symptom | Built in (Workers AI on your account) |
| Ask the mechanic: per-car chat, streamed, saved, research-aware | Built in (Workers AI) |
| Relevance-chunked research context for the mechanic | Built in |
| Robust answers: continue cut-off answers, retry, fallback model, timeouts, "Tap to continue" | Built in |
| AI failure log | Built in (D1 `ai_failures`; `GET /api/health` with a bearer token) |
| To-dos with priorities, notes, closing into history | Built in |

## Research

| Feature | Status |
|---|---|
| Research tab: specs, recommendations, known-issues mileage timeline, recalls, TSBs, symptom checklists, schedule, questions, full report | Built in; filled by your Claude (research-car skill, or `save_research_bundle` from a Claude app) |
| Live recall lookup: NHTSA for cars, trucks and motorcycles (model names matched to NHTSA's list, one retry, nhtsa.gov VIN link as the fallback), **CPSC** (saferproducts.gov) for UTVs / ATVs | Built in (0.2.0): Research tab "Look up recalls now", MCP `get_recalls`, `GET /api/cars/:id/recalls` |
| Research for bikes and off-road (bike / UTV forums, OEM fiche, Partzilla / RevZilla, CPSC, hours-based schedules) | Built in (research-car skill and the research worker's prompt) |
| Multi-round web research process (recalls/TSBs, forums, manual, parts, guides, symptoms) | Built in as the research-car skill (your Claude Code, WebSearch/WebFetch) |
| Deep research per symptom ("Research this", auto-queued for new symptoms) | Built in queue; fulfilled by **Integration: research worker** automatically, or on demand by your Claude (`list_research_requests` + `save_symptom_report`, or the research-car skill) |
| Background research worker (cron, headless Claude Code, daily cap, lock, heartbeat, pause file, validated report) | **Integration: research worker** (your always-on computer, your Claude Code login) |
| Notification when research lands / fails (once) | Built in (stored and listed in Settings); pushed with **Integration: push, Home Assistant or email** |
| `save_research` (MCP): add entries with dry run and optimistic lock | Built in (owners; everyone in password mode) |
| Safe loaders: plan, dry run, refuse overwrite without --force, drift detection, backup before write | Built in (`scripts/load-research.mjs`, one loader for all research files; hours intervals and per-type plans load too). Backups export one table per wrangler call, since older wrangler (4.69) refuses a repeated `--table` |
| Table-level restore from a backup (UPSERT, never deletes, dry run, pre-restore export) | Built in (`node scripts/d1-restore.mjs`); whole-database restore: D1 Time Travel (30 days) |
| Nightly D1 backup | Built in script (`npm run backup`); running it nightly needs an always-on computer (same as the research worker) |

## Parts, brands, guides

| Feature | Status |
|---|---|
| Fluids card (spec, amount, verify tags) | Built in (from research) |
| Wet-clutch motorcycles: **JASO MA/MA2** flag and "no energy-conserving car oil" warning on the oil row, shared / separate sump note (also in MCP `get_fluids` and the mechanic prompt) | Built in (0.2.0); a bike with no parts research gets a generic JASO oil row |
| Parts tab (part numbers with Copy, prices with as-of date, buy links) | Built in (from research) |
| Compare brands, "what I'd buy", avoid list | Built in (from research) |
| Alternates tab (OEM first, then good alternates, filter) | Built in (bike / off-road stores sorted first for those vehicles) |
| Shopping list (RockAuto vs buy locally, totals, copy part numbers, tools and extras) | Built in; bikes group by Partzilla / RevZilla / BikeBandit / OEM fiche, UTVs and ATVs by OEM dealer fiche / Partzilla / Rocky Mountain ATV/MC / SuperATV, with "local dealer" for urgent parts (0.2.0) |
| Guides tab (difficulty, time, tools, safety, steps, videos) | Built in (from research) |
| Scan tool / pressure tester / additives sections | Built in when the research includes them (generic `scan_tool`, `pressure_tester`, `additives`) |

## Guided diagnosis

| Feature | Status |
|---|---|
| Step-by-step plans per car + symptom, one check at a time, safety first, re-ranking causes, skip / resume / change answers | Built in |
| Finish -> history summary, notes on related to-dos, fix to-do with parts only after a yes | Built in |
| Research-built plans | Built in (research-car skill writes `diagnosis-plans.json`; the loader validates and versions them) |
| Generic per-type plans: **UTV CVT belt slip / burning smell** and **UTV overheating** (12 steps each, from the Polaris manuals and forums) for every side-by-side | Built in (0.2.0, `src/generic-plans.js`); the demo bike adds a V Star 650 hard-starting plan |
| AI-generated plans for symptoms without one (marked "check before trusting") | Built in (Workers AI; uses your `my_tools`) |
| Diagnosis from Claude (MCP) | Built in |

## Receipts and scan reports

| Feature | Status |
|---|---|
| Scan a receipt in the app (camera, multi-page, HEIC -> JPEG), AI read, confirm card, save to history | Built in (Workers AI vision); reads engine hours too and asks for them on UTV / ATV receipts; matches bike / off-road jobs (valves, carb sync, final gear oil, chain, fork oil, CVT belt / clutch, diffs, grease) |
| Receipts from Claude (`add_receipt` with fields / transcription / files, `confirm_receipt`) | Built in |
| Dedupe, validation, schedule matching, to-do candidates | Built in |
| Receipts and scan-tool reports **by email** (allowlisted senders, DMARC check, reply) | **Integration: email-in** (your domain + Cloudflare Email Routing) |
| Phone notification for an emailed receipt | **Integration: push, Home Assistant or email** |
| Upload a scan-tool report (PDF/HTML) by hand, DTC to-dos, unmatched inbox | Built in (the Inbox tab only shows when email-in is on) |

## Notifications and Home Assistant

| Feature | Status |
|---|---|
| Daily "due / overdue" reminders (each item at most weekly) | **Integration: push, Home Assistant or email** (hourly cron, sent at `notify_hour`) |
| `sensor.garage_due_count` in Home Assistant | **Integration: Home Assistant** (HA reachable from the internet) |
| HA polling `/api/due` with a bearer token | **Integration: Home Assistant** (`HA_POLL_TOKEN`) |
| Monthly mileage check | **Integration: push, Home Assistant or email**: a notification per vehicle that opens its odometer box; UTVs / ATVs are asked for **engine hours** instead (opens the hours box) |
| Type the mileage (or hours) right in the notification (HA actionable notification, reply checked and saved, confirmation back) | **Integration: Home Assistant** (an HA automation posts the reply; YAML in docs/integrations.md; "Enter hours" for UTVs / ATVs, at most 300 h above the last reading, never lower). Replaces the original's always-running websocket listener on a home server |
| Daily health check (site, MCP challenge, database, AI failures, stuck research, worker heartbeat, backup age) -> one notification listing problems | **Integration: research worker** computer (`research-worker/run-health.sh`, daily cron) |

## Sign-in and Claude

| Feature | Status |
|---|---|
| Members-only sign-in | Built in: household password (default), Cloudflare Access, or any OIDC provider; "none" possible with warnings |
| The original's private identity provider | **Not included**: personal. Use `oidc` with your own provider |
| MCP server (OAuth 2.1, DCR, PKCE, consent page, per-grant rate limit, instant disconnect) | Built in, in every sign-in mode |
| Connect claude.ai, Claude mobile, Claude Desktop, Claude Code | Built in (Settings -> Connect your Claude) |
| All MCP tools (cars, research, parts, alternates, shopping, due, history, symptoms, to-dos, services, mileage, hours, recalls, receipts, diagnosis, save_research) | Built in (`update_hours`, `get_recalls`, hours on `log_service` / `update_mileage` / receipts, loose names like "the bike" or "the side by side": 0.2.0); plus `add_car` (vehicle type, hours, drivetrain facts), `decode_vin`, `update_schedule_item` (hours intervals), `list_research_requests`, `save_symptom_report`, `save_research_bundle` |
| Server instructions so phone Claude uses the tools well | Built in (lists your cars; includes the disclaimer) |
| "Not professional advice" disclaimer: footer, one-time acknowledgement, under AI answers, Research/Guides/diagnosis | Built in |

## Security

| Feature | Status |
|---|---|
| CSP pinned to one three.js version, HSTS (https), nosniff, frame-deny, same-origin writes, JSON-only writes | Built in |
| Login rate limit, MCP rate limit | Built in (Workers rate-limit bindings) |
| Secrets only as Worker secrets, never in files or logs | Built in (`npm run secrets` / `set-password`) |
