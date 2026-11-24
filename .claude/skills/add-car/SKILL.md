---
name: add-car
description: Add a vehicle to the user's garage (car, truck, van, SUV, motorcycle, side-by-side / UTV or ATV) - VIN or year/make/model/engine decoded with the public NHTSA vPIC API, the vehicle type, paint color and 3D body style, current mileage (and engine hours for UTVs/ATVs), drivetrain facts for bikes, known problems in their own words, recalls (NHTSA, or CPSC for off-road), the typical starter maintenance schedule for that type marked "check owner's manual" - then offer to research it. Use when the user says "add a car", "add my truck", "add my bike", "add the side by side", "I got a new car".
---

# Add a car (or a motorcycle, UTV, ATV)

Works against their deployed garage (default) or local dev (`--local`). Ask one thing at a time; keep it friendly.

## 1. Identify the car
- Ask for the **VIN** (17 characters; driver-side windshield corner, door-jamb sticker, registration or insurance
  card). If they don't have it handy, ask **year, make, model**, and engine/trim if they know them.
- Decode a VIN with the public NHTSA vPIC API (no key needed):
  ```bash
  curl -s "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/<VIN>?format=json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).Results[0];console.log(JSON.stringify({year:r.ModelYear,make:r.Make,model:r.Model,trim:r.Trim||r.Series,engine:[r.DisplacementL&&r.DisplacementL+"L",r.EngineConfiguration,r.EngineCylinders&&r.EngineCylinders+"cyl",r.EngineModel].filter(Boolean).join(" "),fuel:r.FuelTypePrimary,trans:[r.TransmissionSpeeds,r.TransmissionStyle].filter(Boolean).join("-speed "),drive:r.DriveType,body:r.BodyClass,error:r.ErrorCode!=="0"?r.ErrorText:null},null,1))})'
  ```
  (The app has the same decoder: "Look up" next to the VIN on Add a vehicle, and the MCP tool `decode_vin`, which also
  returns a suggested `vehicle_type` and `body_type`.) Read back what it found and let them correct it. vPIC is often
  blank on trim/engine for older cars: then ask.
- **Vehicle type** (`vehicle_type`): from vPIC `VehicleType`:
  - `MOTORCYCLE` -> `motorcycle` (body style from `BodyClass`: cruiser, sport, dualsport, scooter);
  - `TRUCK` -> `truck`; `MULTIPURPOSE PASSENGER VEHICLE (MPV)` -> `van` if `BodyClass` says minivan/van, else `suv`;
    `PASSENGER CAR` -> `car`;
  - **UTVs and ATVs: ask.** vPIC coverage of off-road VINs is spotty: often no data, a partial decode, or the machine
    is filed as a MOTORCYCLE / "OFF ROAD VEHICLE" (a Polaris RZR is filed as a motorcycle). If the model name is a
    side-by-side (RZR, Ranger, General, Maverick, Defender, Commander, Talon, Pioneer, Wolverine, Teryx, Mule, ...)
    or a quad (Sportsman, Grizzly, Kodiak, Foreman, Rancher, Outlander, Brute Force, ...), confirm `utv` / `atv` with
    the user and fill in the rest by hand. (Careful with shared names: a Ford Ranger is a truck.)
- Without a VIN: optionally check the make/model/year exist with
  `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeYear/make/<make>/modelyear/<year>?format=json`.

## 2. The rest
- **Nickname** (what the household calls it: "the Civic", "Mom's van").
- **Body style** for the 3D garage: sedan, coupe, hatchback, minivan, suv or pickup (suggest from vPIC `BodyClass`);
  motorcycles cruiser, sport, dualsport or scooter; `utv`; `atv`.
- **Motorcycles, UTVs, ATVs: the drivetrain facts** (`attrs`). They pick the starter schedule items, so ask in plain
  words (or read them off the research/spec sheet) and leave out what they don't know:
  - `final_drive`: chain, shaft or belt ("chain and sprockets, a driveshaft, or a belt to the back wheel?");
  - `cooling`: air, oil-air or liquid ("does it have a radiator?");
  - `fuel_system`: carbureted or efi (older bikes are often carbureted: adds carb sync + fuel stabilizer);
  - `clutch`: wet (most bikes; oil-bathed, needs JASO MA/MA2 oil), dry, or cvt (scooters, UTVs, ATVs);
  - `shared_sump`: true when the engine and gearbox share one oil;
  - `needs_info`: fields they'll fill in later (vin, mileage, hours, color, variant): shown as "needs info" in the app.
- **Paint color**: ask in words and pick a close `#rrggbb` (e.g. silver `#a9adb3`, white `#e9e9e6`, black `#121316`,
  dark blue `#1f3a5f`, red `#9b1c24`). They can fine-tune it in the app (Edit car), or upload their own .glb model there.
- **Current mileage**, and for UTVs / ATVs the **engine hours** (`hours`, the hour meter: they're serviced by hours).
- **Known problems or symptoms, in their own words** ("it squeals when braking in the morning"). Each becomes a
  symptom to-do. Ask "anything else it's doing?" once.
- Anything else worth remembering (recent work, quirks) -> notes.

## 3. Recalls (NHTSA; CPSC for UTVs / ATVs)
```bash
curl -s "https://api.nhtsa.gov/recalls/recallsByVehicle?make=<make>&model=<model>&modelYear=<year>" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const r of JSON.parse(s).results||[])console.log(r.NHTSACampaignNumber,"|",r.Component,"|",String(r.Summary).slice(0,160))})'
```
NHTSA's model name may differ ("V Star 650" is filed as "V STAR"): list them with
`https://api.nhtsa.gov/products/vehicle/models?modelYear=<year>&make=<make>&issueType=r`.
**UTVs and ATVs are recalled through the CPSC, not NHTSA:**
```bash
curl -s "https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallTitle=<model word, e.g. RZR>" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const r of JSON.parse(s))console.log(r.RecallNumber,"|",String(r.RecallDate).slice(0,10),"|",r.Title)})'
```
keep the ones for their make (and year range), and point them to the maker's VIN recall lookup too. Once the vehicle
is added, `get_recalls` (MCP) or "Look up recalls now" on the Research tab does this lookup for them.
Tell them how many recalls exist for that model/year, in plain words, and that **whether their vehicle still needs one
depends on the VIN**: they should check https://www.nhtsa.gov/recalls with the VIN (repairs are free at a dealer).
Add a to-do "Check open recalls by VIN (N recalls exist for this model year)" with the campaign numbers in the notes.
These recalls also go into the research later (research-car).

## 4. Write it
Create `build/new-car.json` (git-ignored) and load it:
```json
{ "car": { "nickname": "...", "year": 2016, "make": "...", "model": "...", "trim": "...", "engine": "...", "transmission": "...",
           "vin": "... or omit", "vehicle_type": "suv", "body_type": "suv", "color": "#334455", "mileage": 81200, "notes": "..." },
  "starter_schedule": true,
  "todos": [ { "title": "Squeal when braking in the morning", "notes": "in their words, plus when/where", "priority": "medium", "symptom": true },
             { "title": "Check open recalls by VIN (3 recalls exist for this model year)", "notes": "15V123000, ...", "priority": "high" } ] }
```
```bash
node scripts/add-car.mjs --file build/new-car.json --dry-run   # shows the SQL
node scripts/add-car.mjs --file build/new-car.json             # prints the new car id (add --local for wrangler dev)
```
A motorcycle / UTV looks like this (no `todos` needed):
```json
{ "car": { "nickname": "The bike", "year": 2007, "make": "Yamaha", "model": "V Star 650", "vehicle_type": "motorcycle", "body_type": "cruiser",
           "color": "#5b6f86", "mileage": 18400, "attrs": { "final_drive": "shaft", "cooling": "air", "fuel_system": "carbureted", "clutch": "wet", "shared_sump": true } },
  "starter_schedule": true }
{ "car": { "nickname": "The side by side", "year": 2020, "make": "Polaris", "model": "RZR XP 1000", "vehicle_type": "utv", "body_type": "utv",
           "color": "#c8102e", "mileage": 1830, "hours": 142.5, "attrs": { "cooling": "liquid", "fuel_system": "efi", "clutch": "cvt" } },
  "starter_schedule": true }
```
The starter schedule depends on the type, each item marked "Typical interval, check your owner's manual". Say so:
they get replaced by the owner's-manual schedule when the vehicle is researched.
- **Cars** (car / truck / van / SUV): 12 generic items.
- **Motorcycles:** oil & filter (JASO MA/MA2 note for a wet clutch), valves, plugs, air filter, brake fluid and pads,
  tire pressure, **tire age** (5 years, date-only), battery tending, fork oil, cables, steering head; then by
  `final_drive`: chain clean/lube (every ~500 mi) + chain & sprockets, **final gear oil** (shaft) or belt inspection;
  coolant only if `cooling` is liquid; carb sync + fuel stabilizer if carbureted. Without `final_drive` it adds a chain
  item that says to set the final drive.
- **UTVs / ATVs:** by miles, **engine hours** or months, whichever comes first: break-in oil, oil (50 h UTV / 100 h ATV),
  CVT belt and clutches, air filter + pre-filter, front diff, transmission / rear gearcase, coolant, grease fittings,
  CV boots, plug, brakes, winch, battery, tire age, with "milky fluid after a water crossing = change it now" notes.
  Every UTV also gets the built-in CVT-belt-slip and overheating diagnosis plans.

If Claude Code has the garage MCP connector, `add_car` does the same (it takes `vehicle_type`, `hours` and `attrs` too;
no starter to-dos: add symptoms with `add_symptom`, which also gets the AI mechanic's first-checks note and queues
research).

## 5. Next
- Tell them where it is (open the app: it's in the garage now), and that **catch up** on the car page asks "roughly when
  was this last done?" for each item, which makes the due list useful right away. For a UTV / ATV: they can log hours
  from the car page ("Update hours"), with every service, or by telling Claude ("rode it 3 hours" -> `update_hours`),
  and the monthly reading check asks for hours instead of miles.
- Offer: "Want me to research it? Recalls and bulletins, common problems at its mileage, the owner's-manual schedule
  and fluids, parts with brand options, repair guides, and the symptoms you mentioned." -> `.claude/skills/research-car/SKILL.md`.
