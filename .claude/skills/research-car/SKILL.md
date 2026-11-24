---
name: research-car
description: Research one of the user's cars on the web with WebSearch/WebFetch, in rounds - recalls/TSBs/NHTSA complaints, common problems by mileage from owner forums, the owner's-manual schedule and fluids, parts with brand alternates, repair guides and videos, live-symptom diagnosis ranked cheapest first, and guided-diagnosis plans - write it to the research schema and load it with the safe loader. Also researches symptoms waiting in the garage's research queue. Use when the user says "research my car", "research the waiting symptoms", "what usually breaks on ...".
---

# Research a car

The output goes into the user's garage, where the AI mechanic, the Research/Parts/Guides tabs and guided diagnosis
use it. Quality matters more than volume.

## Quality rules (non-negotiable)
- **Cite a URL for every claim** (owner's manual page, NHTSA, a bulletin, a forum thread, a parts listing). If you
  can't find a source, either leave it out or mark it `"general knowledge"` / `"verify": true`.
- **Never invent** part numbers, TSB numbers, recall campaign numbers, torque specs or capacities. Only write numbers
  you actually saw for this exact vehicle (year, engine, drivetrain). When sources disagree, say so.
- **Mark unverified items** (`"verify": true`, "unverified" in the text, `"fitment": "verify fitment"`).
- **Respect robots.txt and blocks.** If a site refuses automated access (403, a bot challenge, a login wall, a
  paywall), skip it and use another source. Never try to get around a block (no other user agents, no caches or
  mirrors of blocked pages, no scraping tricks).
- Prefer sources specific to the year/make/model/**engine**; note when something applies to a different engine or trim.
- Plain language for the owner; safety notes whenever a check involves heat, pressure, lifting, fuel, airbags or brakes.
- The app's disclaimer applies: research can be wrong. Say "verify by VIN / with the parts counter" where it matters.

## Before you start
1. Which car: `npx wrangler d1 execute DB --remote --command "SELECT id, nickname, year, make, model, trim, engine, transmission, vin, mileage FROM cars WHERE archived = 0"`
   (or the MCP `list_cars` / `get_car` if the garage connector is set up). Note open symptoms: `get_car` or
   `SELECT title, notes FROM todos WHERE car_id = '<id>' AND status = 'open'`.
2. Make the folder `research/<car-slug>/` (git-ignored). A complete fake example to copy the shapes from:
   `demo/research/`. Schema: `docs/research-schema.md`.
3. **Use sub-agents, one per research area**, to keep the context small: each gets the vehicle facts, its area, the
   quality rules above and the exact JSON shape to return, and writes its own file. Then you merge and check.

## The rounds

**Round 1 - safety and official sources** -> `research.json` `recalls`, `tsbs`, `questions`
- NHTSA recalls: `https://api.nhtsa.gov/recalls/recallsByVehicle?make=..&model=..&modelYear=..`
- NHTSA complaints (patterns, mileage): `https://api.nhtsa.gov/complaints/complaintsByVehicle?make=..&model=..&modelYear=..`
- Technical service bulletins: NHTSA's manufacturer communications (search `site:static.nhtsa.gov <make> <model> <year> TSB`), plus forum threads that quote bulletin numbers. Only list a TSB number you saw.
- Add "check open recalls by VIN at https://www.nhtsa.gov/recalls" to `questions` if there's no VIN.

**Round 2 - common problems by mileage** -> `known_issues` (with `mileage_range`), `recommendations`
- Owner forums for this model/generation, NHTSA complaint clusters, reputable repair sites. Record the mileage window,
  symptoms, fix, DIY vs shop cost, urgency, sources. Relate each to the car's current mileage
  (`recommendations.priority`: now / soon / decision / watch / skip).

**Round 3 - owner's manual: schedule and fluids** -> `schedule`, `vehicle`, `fluids.json`
- Find the owner's manual (manufacturer owner sites often host PDFs; manualsdir-type sites; cite the page). Normal and
  severe-service intervals (`"severe": true` rows), `"source": "manual"`; common-practice items as `"typical"`.
- Fluids: spec + an example product + amount (quarts and liters), with `verify` where unsure.

**Round 4 - parts and brands** -> `parts-guides.json` `parts`, `brands.json`
- The usual wear parts (filters, plugs, belts, brakes, wipers, bulbs, battery group, tires) plus parts for the known
  issues and the open symptoms. OEM number first, then good alternates. **RockAuto first** where useful (it lists OEM
  and aftermarket by exact vehicle), then local stores. Prices with an as-of month. "verify fitment" when the
  listing's fitment notes don't clearly match.

**Round 5 - guides and videos** -> `parts-guides.json` `guides`, `additives`
- Step-by-step DIY guides for the likely jobs and checks: difficulty 1-5, time, tools, safety, steps, video and article
  links you actually opened.

**Round 6 - live symptoms** -> `symptom_diagnosis`, `diagnosis-plans.json`, and per-symptom reports
- For each open symptom: likely causes ranked **cheapest and easiest to check first**, then by likelihood; how to check,
  fix, cost; scan-tool checks. "OK to drive?" with a reason (be conservative with brakes, steering, overheating, fuel
  smell, smoke).
- If the user wants guided diagnosis for it, also write a plan in `diagnosis-plans.json` (id prefixed with the car,
  version 1, every step with a source URL, `found` only when a result really settles it). See the schema.

**Waiting symptoms (research queue).** Symptoms added in the app or by Claude are queued for deep research. To do
them by hand: `list_research_requests` (MCP) or
`npx wrangler d1 execute DB --remote --command "SELECT j.todo_id, c.nickname, t.title, t.notes FROM research_jobs j JOIN todos t ON t.id = j.todo_id JOIN cars c ON c.id = j.car_id WHERE j.status IN ('queued','running') AND c.archived = 0"`.
For each, write a report (shape in docs/research-schema.md, "Symptom research reports") and save it with
`save_symptom_report` or `node scripts/load-research.mjs --symptom-report <todo-id> --file research/<car>/report-<todo>.json`.
(If the household runs the background research worker, it does these automatically.)

**Finally** write `research.md` (and optionally `parts-guides.md`, `brands.md`): the readable report with links, a
short "what to do now" list at the top.

## Load it (safe loader)
```bash
node scripts/load-research.mjs --car "<nickname>" --dir research/<car-slug> --dry-run
```
Read the plan out to the user in plain words. First load = all NEW/UPDATE. Then:
```bash
node scripts/load-research.mjs --car "<nickname>" --dir research/<car-slug> --schedule --todos
```
- `--schedule` replaces the generic starter schedule with the researched one (last-done dates carry over).
- `--todos` turns "now" recommendations into to-dos.
- If it says **REFUSED (overwrite)**: something in the garage differs from your files (an earlier load). Show the
  plan, and use `--force` only after the user agrees (it backs up to `backups/d1/` first).
- If it says **REFUSED (drift)**: the garage has entries your files don't (added from a Claude app with
  `save_research`, or in the app). Copy those into your files first; `--force --accept-drift` only if the user wants
  them gone.

From claude.ai / the phone instead of Claude Code: `save_research_bundle` (first load) and `save_research` (add entries).

## Wrap up
Tell the user the top findings (recalls to check, what's due now by the manual, the likeliest cause of each symptom
and whether it's OK to drive), where to see it (Research, Parts, Guides tabs), and remind them once:
"Not professional advice: verify part numbers by VIN and follow the safety notes."
