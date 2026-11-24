---
name: add-car
description: Add a car to the user's garage - VIN or year/make/model/engine decoded with the public NHTSA vPIC API, paint color and 3D body style, current mileage, known problems in their own words, NHTSA recalls, a generic starter maintenance schedule marked "typical, check owner's manual" - then offer to research it. Use when the user says "add a car", "add my truck", "I got a new car".
---

# Add a car

Works against their deployed garage (default) or local dev (`--local`). Ask one thing at a time; keep it friendly.

## 1. Identify the car
- Ask for the **VIN** (17 characters; driver-side windshield corner, door-jamb sticker, registration or insurance
  card). If they don't have it handy, ask **year, make, model**, and engine/trim if they know them.
- Decode a VIN with the public NHTSA vPIC API (no key needed):
  ```bash
  curl -s "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/<VIN>?format=json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).Results[0];console.log(JSON.stringify({year:r.ModelYear,make:r.Make,model:r.Model,trim:r.Trim||r.Series,engine:[r.DisplacementL&&r.DisplacementL+"L",r.EngineConfiguration,r.EngineCylinders&&r.EngineCylinders+"cyl",r.EngineModel].filter(Boolean).join(" "),fuel:r.FuelTypePrimary,trans:[r.TransmissionSpeeds,r.TransmissionStyle].filter(Boolean).join("-speed "),drive:r.DriveType,body:r.BodyClass,error:r.ErrorCode!=="0"?r.ErrorText:null},null,1))})'
  ```
  (The app has the same decoder: "Fill in from the VIN" on Add a car, and the MCP tool `decode_vin`.)
  Read back what it found and let them correct it. vPIC is often blank on trim/engine for older cars: then ask.
- Without a VIN: optionally check the make/model/year exist with
  `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeYear/make/<make>/modelyear/<year>?format=json`.

## 2. The rest
- **Nickname** (what the household calls it: "the Civic", "Mom's van").
- **Body style** for the 3D garage: sedan, coupe, hatchback, minivan, suv or pickup (suggest from vPIC `BodyClass`).
- **Paint color**: ask in words and pick a close `#rrggbb` (e.g. silver `#a9adb3`, white `#e9e9e6`, black `#121316`,
  dark blue `#1f3a5f`, red `#9b1c24`). They can fine-tune it in the app (Edit car), or upload their own .glb model there.
- **Current mileage**.
- **Known problems or symptoms, in their own words** ("it squeals when braking in the morning"). Each becomes a
  symptom to-do. Ask "anything else it's doing?" once.
- Anything else worth remembering (recent work, quirks) -> notes.

## 3. Recalls (NHTSA)
```bash
curl -s "https://api.nhtsa.gov/recalls/recallsByVehicle?make=<make>&model=<model>&modelYear=<year>" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const r of JSON.parse(s).results||[])console.log(r.NHTSACampaignNumber,"|",r.Component,"|",String(r.Summary).slice(0,160))})'
```
Tell them how many recalls exist for that model/year, in plain words, and that **whether their car still needs one
depends on the VIN**: they should check https://www.nhtsa.gov/recalls with the VIN (repairs are free at a dealer).
Add a to-do "Check open recalls by VIN (N recalls exist for this model year)" with the campaign numbers in the notes.
These recalls also go into the research later (research-car).

## 4. Write it
Create `build/new-car.json` (git-ignored) and load it:
```json
{ "car": { "nickname": "...", "year": 2016, "make": "...", "model": "...", "trim": "...", "engine": "...", "transmission": "...",
           "vin": "... or omit", "body_type": "suv", "color": "#334455", "mileage": 81200, "notes": "..." },
  "starter_schedule": true,
  "todos": [ { "title": "Squeal when braking in the morning", "notes": "in their words, plus when/where", "priority": "medium", "symptom": true },
             { "title": "Check open recalls by VIN (3 recalls exist for this model year)", "notes": "15V123000, ...", "priority": "high" } ] }
```
```bash
node scripts/add-car.mjs --file build/new-car.json --dry-run   # shows the SQL
node scripts/add-car.mjs --file build/new-car.json             # prints the new car id (add --local for wrangler dev)
```
The starter schedule is 12 generic items, each marked "Typical interval, check your owner's manual". Say so: they
get replaced by the owner's-manual schedule when the car is researched.

If Claude Code has the garage MCP connector, `add_car` does the same (no starter to-dos; add symptoms with `add_symptom`,
which also gets the AI mechanic's first-checks note and queues research).

## 5. Next
- Tell them where it is (open the app: it's in the garage now), and that **catch up** on the car page asks "roughly when
  was this last done?" for each item, which makes the due list useful right away.
- Offer: "Want me to research it? Recalls and bulletins, common problems at its mileage, the owner's-manual schedule
  and fluids, parts with brand options, repair guides, and the symptoms you mentioned." -> `.claude/skills/research-car/SKILL.md`.
