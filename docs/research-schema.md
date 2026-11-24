# Research files

Research for one car lives in `research/<car-slug>/` (git-ignored: it's your data). Every file is optional. Load with:

```bash
node scripts/load-research.mjs --car "<nickname or id>" --dir research/<car-slug> --dry-run      # always first
node scripts/load-research.mjs --car "<nickname or id>" --dir research/<car-slug> [--schedule] [--todos]
```

`--schedule` applies `research.json` `schedule` (replacing the generic starter items; last-done dates carry over by
category, items with history are never dropped). `--todos` turns `"priority": "now"` recommendations into to-dos.
Add `--local` for a local `wrangler dev` database. From a Claude app the same data goes in with the MCP tools
`save_research_bundle` (first load) and `save_research` (add entries). A complete fake example: `demo/research/`;
a real one for a motorcycle (2007 Yamaha V Star 650): `demo/bike/research/`.

**Rules for every file:** every claim has a source URL (in `url`, `sources` or `source_urls`); anything not confirmed
says so (`"verify": true`, or "unverified" / "general knowledge" in the text: the app shows these as tags); part,
TSB and recall numbers only when you actually saw them for this vehicle.

## research.json -> Research tab, AI mechanic, schedule

```jsonc
{
  "vehicle": {                       // shown as "Specs (researched)"; any extra keys are shown too
    "year": 2015, "make": "...", "model": "...", "trim": "...", "engine": "...", "transmission": "...",
    "oil": "0W-20, 4.4 qt with filter", "sources": ["https://..."]
  },
  "recalls": [ { "campaign": "15V123000", "date": "2015-06-01", "component": "...", "summary": "...", "remedy": "...", "url": "https://www.nhtsa.gov/..." } ],
  "tsbs":    [ { "number": "...", "title": "...", "summary": "...", "url": "https://..." } ],
  "schedule": [                      // owner's-manual schedule; rows without an interval are shown on the Research tab only
    { "item": "Oil & filter change", "interval_miles": 7500, "interval_months": 12,
      "interval_hours": 50,          // optional: engine hours (UTVs, ATVs); due at miles, hours or months, whichever comes first
                                     // months only = a date-based item (tire age, battery, brake fluid)
      "severe": false,               // true = severe-service variant (its own row); a string = a severe-service note
      "source": "manual",            // manual (owner's manual) | typical (common practice)
      "notes": "Fluid spec, amount, page or URL" }
  ],
  "known_issues": [
    { "title": "...", "mileage_range": "80k-120k",   // "80k+", "60-100k", "any"; drives the mileage timeline
      "symptoms": "...", "fix": "...", "cost_diy": "$", "cost_shop": "$", "urgency": "low|medium|high", "sources": ["https://..."] }
  ],
  "symptom_diagnosis": [             // "live-symptom" checklists, cheapest first
    { "symptom": "Squeal when braking", "likely_causes": [
        { "cause": "...", "likelihood": "high|medium|low", "how_to_check": "...", "fix": "...", "cost": "$0" } ],
      "scan_tool_checks": ["..."] }
  ],
  "recommendations": [ { "priority": "now|soon|decision|watch|skip", "item": "...", "why": "...", "cost": "$" } ],
  "questions": ["Things the owner should find out (e.g. check the VIN for open recalls)"]
}
```

`research.md`: the written report (markdown with source links). Shown as "Full research report" and used, section by
section, as context for the AI mechanic.

## fluids.json -> Fluids card (Overview, Parts), AI mechanic, MCP get_fluids

```jsonc
[ { "fluid": "Engine oil (with filter)", "buy": "SAE 0W-20, API SP", "example": "brand + product",
    "amount": "4.4 quarts", "liters": "4.2 L", "amount_label": "drain-and-fill",   // optional
    "total": "about 9 quarts", "total_label": "dry fill",                          // optional
    "notes": "...", "source": "https://...", "verify": true } ]                    // verify = not confirmed
```
Order: oil, coolant, transmission, transfer case, front/rear differential, brake, power steering, washer.

## parts-guides.json -> Parts and Guides tabs, MCP get_parts / get_guides

```jsonc
{
  "vehicle": "2015 ...", "research_date": "YYYY-MM-DD",
  "parts": [ { "category": "Filters", "name": "Oil filter", "spec": "...", "part_numbers": ["OEM ...", "Brand ..."],
               "price_usd": "$6-12", "price_as_of": "YYYY-MM", "links": [{ "title": "...", "url": "https://..." }],
               "notes": "...", "source_urls": ["https://..."] } ],
  "guides": [ { "title": "...", "related_issue": "brake squeal", "difficulty": 1-5, "time": "1 hour",
                "tools": ["..."], "steps": ["..."], "safety": ["..."],
                "videos": [{ "title": "...", "channel": "...", "url": "https://..." }], "articles": [{ "title": "...", "url": "https://..." }] } ],
  "additives": [ { "product": "...", "use_for": "...", "verdict": "use|maybe|skip", "why": "...", "sources": ["https://..."] } ],
  "scan_tool": { "name": "Your OBD-II reader", "summary": "...", "free_without_subscription": ["..."], "requires_subscription": ["..."], "sources": ["https://..."] },  // optional
  "pressure_tester": { "name": "...", "fits": "yes|no|with adapter", "adapter": "...", "notes": "...", "sources": ["https://..."] }   // optional
}
```
`parts-guides.md`: the written parts report.

## brands.json -> "Compare brands", Alternates tab, Shopping list

```jsonc
{
  "vehicle": "...", "as_of": "YYYY-MM", "notes": ["..."],
  "parts": [
    { "part": "Oil filter", "category": "Filters",            // matched to a parts-guides part by name
      "in_parts_list": true,                                   // false = brand-only part (added to the Parts tab)
      "pick": "Brand A",                                       // "what I'd buy"
      "options": [ { "brand": "Brand A", "tier": "oem|oe-supplier|premium|standard|economy", "part_number": "...",
                     "price_usd": "$9", "where": "RockAuto / local store", "warranty": "...", "reputation": "...",
                     "verdict": "buy|ok|avoid", "fitment": "verify fitment", "sources": ["https://..."] } ],
      "avoid": [ { "brand": "...", "why": "...", "sources": ["https://..."] } ] }
  ]
}
```
`brands.md`: the written brand comparison.

## diagnosis-plans.json -> guided diagnosis (app + MCP start_diagnosis)

```jsonc
{ "plans": [ {
  "id": "civic-brake-squeal",        // unique across ALL your cars: prefix it with the car
  "version": 1,                      // bump it when you change a plan (running sessions keep their copy)
  "vehicle": { "year": 2016, "make": "Honda", "model": "Civic" },   // optional: also matches other cars of that year/make/model
                                     // { "type": "utv" } alone (no year/make/model) = a generic plan for every vehicle of that
                                     // type (car, truck, van, suv, motorcycle, utv, atv); the loader keeps it generic
  "symptom": "Squeal when braking", "title": "Civic: brake squeal",
  "aliases": ["brake squeal", "squeaky brakes"],    // words people use; matched fuzzily
  "todo_match": ["squeal", "brak"],                 // links the session to a matching symptom to-do
  "intro": "...", "safety_overview": "...",
  "causes": [ { "id": "pads_worn", "name": "...", "likelihood": "high|medium|low", "fix": "...", "cost": "$", "parts": ["parts-guides part names"], "keywords": ["..."] } ],
  "steps": [ {                       // cheapest and most likely first; 20 at most
    "id": "pad_look", "title": "...", "minutes": 10, "tools": ["..."], "safety": ["..."],
    "do": "what to do, in plain words", "look_for": "what to look for",
    "tests": ["cause ids this step tests"], "sources": ["https://..."],   // at least one URL per step
    "options": [ { "key": "thin", "label": "what they'd see", "means": "what it means",
                   "effects": { "pads_worn": "confirm|up|down|rule_out" },
                   "found": "pads_worn", "confidence": "high|medium|low" } ]   // found only when it really settles it
  } ]
} ] }
```
A "not sure" option is added to every step automatically. The loader validates plans with the Worker's own
`validatePlan()` and refuses the whole file if any plan is invalid. Built-in generic plans (every UTV gets the CVT
belt slip and overheating plans) are in `src/generic-plans.js`; a plan you load with the same id replaces one.

## Symptom research reports (one to-do)

What the background research worker produces, and what `save_symptom_report` (MCP) or
`node scripts/load-research.mjs --symptom-report <todo-id> --file report.json` save. JSON schema:
`research-worker/schema.json`.

```jsonc
{ "summary": "3-5 plain sentences, most likely first",
  "likely_causes": [ { "cause": "...", "likelihood": "high|med|low", "why": "...", "how_to_check": "...", "fix": "...",
                       "diy_difficulty": 1-5, "cost_diy": "$20-60", "cost_shop": "$150-250" } ],
  "check_order": ["cheapest first"],
  "safe_to_drive": { "verdict": "yes|caution|no", "why": "..." },
  "parts": [ { "name": "...", "part_numbers": "only if seen for this vehicle, else empty", "approx_price": "...", "link": "https://... or empty" } ],
  "videos": [ { "title": "...", "channel": "...", "url": "https://..." } ],
  "sources": [ { "title": "...", "url": "https://..." } ],   // at least one; only pages actually visited
  "questions_for_owner": ["..."] }
```
