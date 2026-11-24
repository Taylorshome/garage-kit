# Changelog

All notable changes to Garage kit. Versions follow [semantic versioning](https://semver.org); each release has a
Docker image at `ghcr.io/taylorshome/garage-kit:<version>` and a GitHub Release with these notes.

## [0.2.0] - 2026-11-24

Motorcycles, side-by-sides (UTVs) and ATVs, with engine hours.

### Added
- **Vehicle types**: car, truck, van, SUV, motorcycle, UTV and ATV (`cars.vehicle_type`, migration
  `0015_vehicle_types.sql`). Existing cars keep working unchanged: their type comes from the body style they already
  have (sedan / coupe / hatchback -> car, minivan -> van, pickup -> truck, suv -> SUV) and they stay miles-only. The
  type drives the starter schedule, fluids warnings, parts sources, recall source and wording; Add / Edit vehicle
  has a Type picker, and the body-style picker offers the styles that fit it.
- **Engine hours**: hours on the vehicle (`Update hours` on the Overview), on services, receipts and catch-up, an hours
  log with hours/month, and schedule items with `interval_hours`. An item is due by **miles, hours or date, whichever
  comes first** ("soon" = 10% of the hours interval, 2-25 h). **Date-only items** (months only: tire age, battery
  tending, brake fluid) work without any reading. MCP: `update_hours` (meter reading or `add_hours`, never lower by
  accident), `hours` on `log_service`, `update_mileage`, `add_receipt` / `confirm_receipt`, interval_hours on
  `update_schedule_item`.
- **Monthly reading check asks UTVs / ATVs for engine hours** (push, email and Home Assistant; HA's actionable
  notification gets "Enter hours", action `GARAGE_HR_<id>`, at most 300 h above the last reading).
- **Starter schedules per type** (Add a vehicle, the add-car skill / `scripts/add-car.mjs`, MCP `add_car`), each item
  "typical, check your owner's manual":
  - motorcycles by final drive (chain clean/lube + chain & sprockets, shaft final gear oil, or belt inspection),
    cooling (coolant only if liquid-cooled) and fuel system (carb sync + fuel stabilizer if carbureted), plus oil
    (JASO note), valves, plugs, air filter, brake fluid and pads, tire pressure, tire age (5 years, date-only),
    battery tending, fork oil, cables and steering head;
  - UTV (2024 Polaris RZR XP 1000 chart) and ATV (2022 Sportsman 570 chart) by miles, hours or months: break-in oil,
    oil, CVT belt and clutches, air filter + pre-filter, diffs / gearcase, coolant, grease fittings, CV boots, plug,
    brakes, winch, battery, tire age, with "milky fluid after a water crossing = change it now" notes and a
    water-crossing card on Maintenance;
  - cars: the same 12 items as before.
- Drivetrain facts for bikes and off-road (`attrs`: final drive, cooling, fuel system, clutch, shared sump) and
  "needs info" placeholders (VIN, mileage, hours, color, variant) on the garage card, header and Overview.
- **Wet-clutch oil flag**: the fluids card, MCP `get_fluids` and the mechanic prompt mark a wet-clutch bike's engine oil
  **JASO MA/MA2** with "don't use energy-conserving car oil, it can make the clutch slip", plus the shared / separate
  sump note; a bike without parts research gets a generic JASO oil row.
- **Parts sources per type**: bikes Partzilla / RevZilla / BikeBandit / OEM fiche / local dealer; UTVs and ATVs OEM
  dealer fiche / Partzilla / Rocky Mountain ATV/MC / SuperATV. The shopping list groups and the Alternates sort use them
  (cars stay RockAuto first).
- **Recalls**: `GET /api/cars/:id/recalls`, MCP `get_recalls` and "Look up recalls now" on the Research tab: NHTSA for
  cars, trucks and motorcycles (model names matched to NHTSA's list, e.g. "V Star 650" -> "V STAR"; NHTSA's API
  intermittently answers 400 for some models, so it retries once and then returns the nhtsa.gov VIN-check link), and
  the **CPSC** (saferproducts.gov) for UTVs / ATVs, with the cpsc.gov search link and the maker's VIN lookup as the
  fallback.
- **VIN decode** knows motorcycles (vPIC VehicleType MOTORCYCLE -> cruiser / sport / dual-sport / scooter), and
  UTVs / ATVs by model name when vPIC doesn't call it a road vehicle (a Ford Ranger stays a truck); partial VINs
  (`*` for unknown positions) and no-data answers fall back to manual entry. `decode_vin` returns `vehicle_type`.
- **Procedural 3D vehicles** (`public/vehicles3d.js`, in the owner's color): cruiser, sport, dual-sport and scooter
  motorcycles, a UTV (roll cage, bucket seats, long-travel A-arms) and an ATV, plus SVG fallbacks. `specFor()` picks
  them by body style, then type and make/model (V Star, Vulcan, Shadow -> cruiser; RZR, Maverick, Talon -> UTV;
  Grizzly, Sportsman -> ATV); cars map exactly as before.
- **Guided diagnosis**: built-in plans for every UTV, "CVT belt slip / burning smell / loss of power" and
  "overheating" (12 steps each, from the Polaris manuals and owner forums, sources on every step;
  `src/generic-plans.js`). Generic per-type plans (`vehicle: {"type": "utv"}`) also load through
  `load-research.mjs`. AI-generated plans, the mechanic, receipts (hours, and bike / off-road jobs: valves, carb sync,
  final gear oil, chain, fork oil, CVT belt / clutch, diffs, grease) and the research worker know bikes and UTVs.
- Loose names for vehicles in MCP and the app's resolver: "the bike", "the side by side", "the quad", "vstar".
- **Demo vehicles**: `npm run seed-demo -- --bike --utv` (or `npm run demo`, which now seeds all three) adds a 2007
  Yamaha V Star 650 (real public research for the model: specs, fluids with the JASO flag, a 33-item shaft-drive
  schedule, known issues, parts, brand alternates and a hard-starting diagnosis plan; no VIN or mileage, so it shows
  "needs info") and a side-by-side with hours history, next to the demo sedan.
- research-car skill: bike and UTV sources (model forums, OEM fiche, Partzilla / RevZilla / Rocky Mountain, CPSC),
  what to capture for a bike (final drive, cooling, carbs, wet clutch, JASO oil) and hours-based schedules
  (`interval_hours` in `research.json`). add-car skill: vehicle types, vPIC mapping (UTV / ATV confirmed by hand),
  drivetrain facts, hours, CPSC recalls.

### Fixed
- Loader backups (`load-research.mjs` via `loader-safety.mjs`) export one table per wrangler call. Older wrangler
  releases that this kit allows (e.g. 4.69, the minimum in package.json, or a global install the scripts fall back to)
  take a single `--table`, so every multi-table pre-write backup failed there with exit 4.

### Upgrade notes
- The migration runs by itself on Docker; on Cloudflare the update skill (or `npm run deploy`) applies it.
- Home Assistant actionable mileage replies: update the automation's condition to the one in
  `docs/integrations.md` so "Enter hours" replies from UTVs / ATVs reach the garage.
- `decode_vin` / `GET /api/vin/<vin>` now answer `ok: false` with `manual: true` instead of an error when NHTSA has no
  data; the decoded fields are still at the top level and also under `decoded`.

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
