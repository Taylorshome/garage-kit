// Vehicle types: cars, trucks, vans, SUVs, motorcycles, side-by-sides (UTV) and ATVs.
// vehicle_type drives the logic (starter schedules, fluids warnings, parts sources, wording, hours);
// body_type picks the 3D / SVG model. Pure functions; tested in test/vehicle.test.mjs.

export const VEHICLE_TYPES = { car: 'Car', truck: 'Truck', van: 'Van', suv: 'SUV', motorcycle: 'Motorcycle', utv: 'Side-by-side (UTV)', atv: 'ATV' };
export const BODY_TYPES = ['sedan', 'coupe', 'hatchback', 'minivan', 'suv', 'pickup', 'cruiser', 'sport', 'dualsport', 'scooter', 'utv', 'atv'];
export const DEFAULT_BODY = { car: 'sedan', truck: 'pickup', van: 'minivan', suv: 'suv', motorcycle: 'cruiser', utv: 'utv', atv: 'atv' };
const BODY_TO_TYPE = { minivan: 'van', sedan: 'car', coupe: 'car', hatchback: 'car', pickup: 'truck', suv: 'suv', cruiser: 'motorcycle', sport: 'motorcycle', dualsport: 'motorcycle', scooter: 'motorcycle', utv: 'utv', atv: 'atv' };
const NOUN = { car: 'car', truck: 'truck', van: 'van', suv: 'SUV', motorcycle: 'motorcycle', utv: 'side-by-side', atv: 'ATV' };

export const typeOf = car => (car && VEHICLE_TYPES[car.vehicle_type]) ? car.vehicle_type : (BODY_TO_TYPE[car?.body_type] || 'car');
export const isMotorcycle = car => typeOf(car) === 'motorcycle';
export const isOffroad = car => ['utv', 'atv'].includes(typeOf(car));
/** Hours-serviced vehicles: UTVs and ATVs, plus anything that already has an hour reading. */
export const usesHours = car => isOffroad(car) || (car?.hours != null && car.hours !== '');
export const noun = car => NOUN[typeOf(car)];
/** Body type that fits a vehicle type (keeps the current one when it already fits). */
export function bodyFor(type, body) {
  if (body && BODY_TO_TYPE[body] === type) return body;
  return DEFAULT_BODY[type] || 'sedan';
}

export function attrsOf(car) {
  if (!car?.attrs) return {};
  if (typeof car.attrs === 'object') return car.attrs;
  try { const a = JSON.parse(car.attrs); return a && typeof a === 'object' && !Array.isArray(a) ? a : {}; } catch { return {}; }
}

/** Wet clutch (engine oil also lubricates the clutch): needs JASO MA/MA2 oil. Motorcycles default to wet except scooters (CVT). */
export function wetClutch(car) {
  const a = attrsOf(car);
  if (a.clutch) return a.clutch === 'wet';
  return isMotorcycle(car) && car.body_type !== 'scooter';
}

// ---------- "needs info" placeholders ----------
const NEEDS = { vin: 'VIN', mileage: 'Mileage', hours: 'Engine hours', color: 'Color', variant: 'Variant / trim' };
/** Fields the owner still has to fill in (attrs.needs_info), dropping any that now have a value. */
export function needsInfo(car) {
  const a = attrsOf(car);
  const list = Array.isArray(a.needs_info) ? a.needs_info : [];
  const missing = f => f === 'vin' ? !car.vin : f === 'mileage' ? car.mileage == null : f === 'hours' ? car.hours == null : true;
  return list.filter(f => NEEDS[f] && missing(f)).map(f => ({ field: f, label: NEEDS[f] }));
}
/** attrs after an edit: fields that were set are no longer "needed" (color/variant clear when the owner sets them). */
export function clearNeeds(attrs, changed) {
  if (!Array.isArray(attrs?.needs_info)) return attrs;
  const done = new Set();
  if (changed.vin) done.add('vin');
  if (changed.mileage != null) done.add('mileage');
  if (changed.hours != null) done.add('hours');
  if (changed.color) done.add('color');
  if (changed.trim) done.add('variant');
  const left = attrs.needs_info.filter(f => !done.has(f));
  return { ...attrs, needs_info: left };
}

// ---------- starter schedules ----------
const T = "Typical interval, check your owner's manual.";
const WATER = 'Severe use (mud / water crossings): check this fluid after every deep crossing; milky or foamy fluid means water got in: change it now.';
const CAR = [
  ['Oil & filter change', 5000, null, 6], ['Tire rotation', 7500, null, 6], ['Engine air filter', 30000, null, 36], ['Cabin air filter', 15000, null, 12],
  ['Coolant flush', 100000, null, 60], ['Transmission fluid', 60000, null, 60], ['Spark plugs', 100000, null, null], ['Brake fluid flush', null, null, 36],
  ['Brake inspection', 12000, null, 12], ['Serpentine belt inspection', 30000, null, 24], ['Battery & terminals check', null, null, 12], ['Wiper blades', null, null, 12],
];

function motorcycleSchedule(car) {
  const a = attrsOf(car), wet = wetClutch(car);
  const out = [
    ['Engine oil & filter', 4000, null, 12, wet ? 'Motorcycle oil rated JASO MA/MA2 (wet clutch). Never energy-conserving car oil: it can make the clutch slip.' : null],
    ['Valve clearance check', 8000, null, null, 'Engine cold. Screw/locknut or shim type: see the service manual.'],
    ['Spark plugs', 8000, null, null],
    ['Air filter', 8000, null, 24, 'Clean or replace sooner in dust.'],
    ['Brake fluid change', null, null, 24, 'DOT type is on the reservoir cap.'],
    ['Brake pads / shoes check', 4000, null, 12],
    ['Tire pressure & tread check', null, null, 1, 'Cold pressures from the owner\'s manual / swingarm label.'],
    ['Tire age check (replace at 5-6 years)', null, null, 60, 'Date-based: replace tires 5-6 years after the DOT date code (last 4 digits = week + year), whatever the tread looks like.'],
    ['Battery tending / storage check', null, null, 6, 'Keep it on a maintainer during storage; check terminals and resting voltage (12.6 V+).'],
    ['Fork oil', null, null, 24, 'Or when the fork seals leak.'],
    ['Clutch & throttle cables: adjust and lube', 4000, null, 12],
    ['Steering head bearings check', 8000, null, 24],
  ];
  const fd = a.final_drive;
  if (fd === 'chain' || !fd) out.push(['Chain clean, lube & adjust', 500, null, null, fd ? 'Every ~500 mi and after riding in rain.' : 'If it has a chain. Set the final drive (chain / shaft / belt) in Edit to get the right items.']);
  if (fd === 'chain') out.push(['Chain & sprockets inspection', 4000, null, 12]);
  if (fd === 'shaft') out.push(['Final gear oil (shaft drive)', 8000, null, 24, 'Check for leaks at the final drive housing each service.']);
  if (fd === 'belt') out.push(['Drive belt inspection', 4000, null, 12, 'Look for cracks, missing teeth, stones; check tension.']);
  if (a.cooling === 'liquid') out.push(['Coolant change', null, null, 24]);
  if (a.fuel_system === 'carbureted') {
    out.push(['Carburetor sync & idle speed', 8000, null, null, 'Needs a carb sync tool (vacuum gauges / manometer).']);
    out.push(['Fuel stabilizer before storage', null, null, 12, 'Carbs clog when ethanol fuel sits: stabilize the tank and run it through, or drain the float bowls.']);
  }
  return out;
}

// Off-road starter schedules: UTV = 2024 Polaris RZR XP 1000 owner's manual chart, ATV = 2022 Polaris Sportsman 570 chart
// (whichever of miles / hours / months comes first; severe use = half the interval per Polaris). Not model-exact.
const SEVERE_HALF = 'Severe use (mud, water, sand, high rpm, heavy loads, lots of idling): half the interval.';
function offroadSchedule(car) {
  const utv = typeOf(car) === 'utv';
  const rows = utv ? [
    ['Engine oil & filter (break-in, once)', 500, 25, 1, 'One-time change after break-in.'],
    ['Engine oil & filter', 1000, 50, 12, null, SEVERE_HALF],
    ['CVT drive belt inspect / clean', 1000, 50, 12, 'Glazing, hourglassing, cords, missing cogs; measure the width against the manual. No fixed replacement interval: replace on inspection and carry a spare.', 'Check after any water in the CVT housing (drain plug).'],
    ['CVT clutches clean & inspect (primary / secondary)', 1000, 50, 12, 'Weights, rollers, bushings, buttons, sheave wear.', SEVERE_HALF],
    ['Air filter, ducts & pre-filter inspect / clean', 500, 25, 6, 'Dust dependent: check after every dusty ride.', 'Water crossings: check the air box for water.'],
    ['Front differential / gearcase fluid', 1000, 50, 12, null, WATER],
    ['Transmission / rear gearcase fluid', 1000, 50, 12, null, WATER],
    ['Coolant change', 5000, null, 60, 'Clean the radiator fins (garden hose, not a pressure washer) after mud rides.'],
    ['Grease fittings: A-arms, ball joints, prop shaft U-joints / carrier bearing', 500, 25, 6, null, 'After water / mud: grease until clean grease pushes out.'],
    ['CV boots inspection', 500, 25, 6, 'A torn boot kills the CV joint fast: replace the boot right away.'],
    ['Spark plug inspect', 1000, 50, 12],
    ['Brake fluid change', 2000, null, 24],
    ['Brake pads & hoses inspect', 500, 25, 6],
  ] : [
    ['Engine oil & filter (break-in, once)', null, 25, 1, 'One-time change after break-in.'],
    ['Engine oil & filter', 1000, 100, 6, null, SEVERE_HALF],
    ['CVT drive belt inspect', 500, 50, 6, 'No fixed replacement interval: replace on inspection.', 'Check after any water in the CVT housing (drain plug).'],
    ['CVT clutches clean & inspect', 1000, 100, 12],
    ['Air filter pre-filter clean', null, 10, 1, 'Daily in dust.', 'Water crossings: check the air box for water.'],
    ['Air filter inspect / replace', 500, 50, 6],
    ['Front differential / gearcase fluid', 2000, 200, 24, null, WATER],
    ['Transmission fluid', 2000, 200, 24, 'Where separate from the engine oil.', WATER],
    ['Rear gearcase / final drive fluid', 2000, 200, 24, null, WATER],
    ['Coolant change', null, null, 24, 'Liquid-cooled models.'],
    ['Grease fittings: A-arms, pivots, prop shaft', 500, 50, 3, null, 'After water / mud: grease until clean grease pushes out.'],
    ['CV boots inspection', 500, 50, 6],
    ['Spark plug inspect', 1000, 100, 12],
    ['Brake fluid change', 2000, 200, 24],
    ['Brake pads inspect', 100, 10, 1],
  ];
  rows.push(
    ['Winch inspection (rope / cable, hook, fairlead, mount, wiring)', null, null, 6, 'If fitted. Also before each use.'],
    ['Battery tending / storage check', null, null, 6, 'Test and clean the terminals; keep it on a maintainer during storage.'],
    ['Tire age check (replace at 5-6 years)', null, null, 60, 'Date-based: 5-6 years after the DOT / date code regardless of tread.'],
  );
  return rows;
}
/** The "after mud / water crossings" check: not on a timer, shown with the off-road schedule. */
export const OFFROAD_NOTE = 'After every deep mud or water crossing: check the front diff, rear diff / transmission / gearcase, the CVT housing (drain plug) and the air box for water. Milky or creamy fluid means water got in: change it now.';

/** Starter schedule rows for a new vehicle: { name, interval_miles, interval_hours, interval_months, notes, severe_note }. */
export function defaultSchedule(car) {
  const t = typeOf(car);
  const rows = t === 'motorcycle' ? motorcycleSchedule(car) : (t === 'utv' || t === 'atv') ? offroadSchedule(car) : CAR;
  return rows.map(([name, mi, h, mo, note, severe]) => ({ name, interval_miles: mi ?? null, interval_hours: h ?? null, interval_months: mo ?? null,
    notes: [note, T].filter(Boolean).join(' '), severe_note: severe || null }));
}

// ---------- fluids ----------
export const JASO_WARNING = "Use motorcycle oil rated JASO MA or MA2: this bike has a wet clutch. Don't use energy-conserving car oil (\"Resource Conserving\" / ILSAC starburst), it can make the clutch slip.";
/** The fluids table for a vehicle, with the motorcycle / wet-clutch flags added. rows = parts research fluids (may be empty). */
export function fluidsFor(car, rows = []) {
  const out = (rows || []).map(r => ({ ...r }));
  const t = typeOf(car), a = attrsOf(car);
  const wet = wetClutch(car);
  if (t !== 'motorcycle' && !wet) return out;
  let oil = out.find(r => /engine oil|motor oil/i.test(r.fluid || ''));
  if (!oil && t === 'motorcycle') {
    oil = { fluid: 'Engine oil (with filter)', buy: wet ? 'Motorcycle 4-stroke oil, JASO MA/MA2, grade per the owner\'s manual' : 'Grade per the owner\'s manual', example: '', amount: "See the owner's manual", liters: '', notes: '', verify: true, generic: true };
    out.unshift(oil);
  }
  if (oil && wet) { oil.jaso = 'MA/MA2'; oil.warning = JASO_WARNING; }
  if (oil && a.shared_sump === true) oil.sump = 'One sump: the engine, clutch and gearbox share this oil.';
  if (oil && a.shared_sump === false) oil.sump = 'Separate transmission / primary oil: see its own row.';
  return out;
}

// ---------- where to buy ----------
const SOURCES = {
  car: { online: 'RockAuto', re: /rockauto/i, online_label: 'Order on RockAuto', local_label: 'Buy locally', stores: ['RockAuto', 'AutoZone', "O'Reilly", 'NAPA'] },
  motorcycle: { online: 'Partzilla / RevZilla / BikeBandit', re: /partzilla|revzilla|bike ?bandit|fiche|yamaha ?parts|oem parts|boats\.net|cyclegear|cycle gear|denniskirk|dennis kirk|amazon/i,
    online_label: 'Order online (Partzilla / RevZilla / BikeBandit, OEM fiche)', local_label: 'Local dealer / buy locally', stores: ['Partzilla (OEM fiche)', 'RevZilla', 'BikeBandit', 'local dealer'] },
  offroad: { online: 'Partzilla / Rocky Mountain ATV/MC / SuperATV', re: /partzilla|rocky ?mountain|superatv|super atv|fiche|oem parts|denniskirk|dennis kirk|amazon/i,
    online_label: 'Order online (Partzilla OEM fiche / Rocky Mountain ATV/MC / SuperATV)', local_label: 'Local dealer / buy locally', stores: ['OEM dealer fiche (Polaris, Can-Am, Honda, Yamaha, Kawasaki)', 'Partzilla', 'Rocky Mountain ATV/MC', 'SuperATV'] },
};
export function partsSources(car) {
  return isMotorcycle(car) ? SOURCES.motorcycle : isOffroad(car) ? SOURCES.offroad : SOURCES.car;
}

// ---------- VIN decode (NHTSA vPIC) ----------
const UTV_RE = /\b(rzr|ranger|general|maverick|commander|defender|talon|pioneer|wolverine|viking|rhino|yxz|teryx|mule|krx|prowler|wildcat|havoc|uforce|zforce|side.?by.?side|utv|rov)\b/i;
const ATV_RE = /\b(sportsman|scrambler|outlander|renegade|grizzly|kodiak|raptor|foreman|rancher|rubicon|recon|trx|fourtrax|brute ?force|prairie|kfx|alterra|cforce|atv|all.?terrain|quad)\b/i;
/** vPIC DecodeVinValues result -> { vehicle_type, body_type, year, make, model, trim, engine, attrs } (empty fields omitted). */
export function fromVpic(raw) {
  const r = Object.fromEntries(Object.entries(raw || {}).map(([k, v]) => [k, v === 'Not Applicable' || v == null ? '' : typeof v === 'string' ? v.trim() : v]));
  const vt = String(r.VehicleType || '').toUpperCase(), bc = String(r.BodyClass || ''), name = `${r.Make || ''} ${r.Model || ''} ${r.Series || ''} ${bc}`;
  let type = 'car', body = 'sedan';
  // by name only when vPIC doesn't call it a road vehicle ("Ford Ranger" is a pickup, "Polaris Ranger" a UTV)
  const road = /TRUCK|PASSENGER CAR|MULTIPURPOSE|MPV|BUS|TRAILER|INCOMPLETE/.test(vt);
  if (/OFF ROAD|LOW SPEED/.test(vt) || (!road && (UTV_RE.test(name) || ATV_RE.test(name))) || /all.terrain|off-?road vehicle|recreational off/i.test(bc)) {
    type = ATV_RE.test(name) || /all terrain/i.test(bc) ? 'atv' : 'utv'; body = type;
  } else if (vt === 'MOTORCYCLE') {
    type = 'motorcycle';
    body = /scooter|moped/i.test(bc) ? 'scooter' : /dual|enduro|motocross|off/i.test(bc) ? 'dualsport' : /sport|street|naked|standard/i.test(bc) && !/cruiser|touring/i.test(bc) ? 'sport' : 'cruiser';
  } else if ((/TRUCK/.test(vt) && !/MPV|MULTIPURPOSE/.test(vt)) || /pickup/i.test(bc)) { type = 'truck'; body = 'pickup'; }
  else if (/minivan|\bvan\b/i.test(bc)) { type = 'van'; body = 'minivan'; }
  else if (/MULTIPURPOSE|MPV|BUS/.test(vt) || /sport utility|suv|crossover/i.test(bc)) { type = 'suv'; body = 'suv'; }
  else if (/hatchback|liftback|wagon/i.test(bc)) body = 'hatchback';
  else if (/coupe|convertible/i.test(bc)) body = 'coupe';
  const attrs = {};
  if (r.CoolingType) attrs.cooling = /air/i.test(r.CoolingType) ? 'air' : /liquid|water/i.test(r.CoolingType) ? 'liquid' : undefined;
  if (/carb/i.test(`${r.FuelInjectionType || ''} ${r.OtherEngineInfo || ''}`)) attrs.fuel_system = 'carbureted';
  else if (r.FuelInjectionType) attrs.fuel_system = 'efi';
  for (const k of Object.keys(attrs)) if (attrs[k] === undefined) delete attrs[k];
  const cc = Number(r.DisplacementCC);
  const moto = type === 'motorcycle' || type === 'utv' || type === 'atv';
  const cfg = r.EngineConfiguration && r.EngineCylinders ? `${String(r.EngineConfiguration).replace(/-Shaped/i, '')}${r.EngineCylinders}` : r.EngineCylinders ? `${r.EngineCylinders}-cyl` : '';
  const fuel = r.FuelTypePrimary && !/^gasoline$/i.test(r.FuelTypePrimary) ? r.FuelTypePrimary : '';
  const engine = [moto && cc ? `${Math.round(cc)}cc` : r.DisplacementL ? `${Number(r.DisplacementL).toFixed(1)}L` : cc ? `${Math.round(cc)}cc` : '', cfg, r.EngineModel, fuel].filter(Boolean).join(' ');
  const transmission = [r.TransmissionSpeeds && `${r.TransmissionSpeeds}-speed`, r.TransmissionStyle].filter(Boolean).join(' ');
  const out = { vehicle_type: type, body_type: body, year: Number(r.ModelYear) || null, make: titleCase(r.Make), model: r.Model || null, trim: [r.Series, r.Trim].filter(Boolean).join(' ') || null, engine: engine || null,
    transmission: transmission || null, drive: r.DriveType || null, attrs, body_class: bc || null, vpic_type: vt || null };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v != null && v !== '' && !(typeof v === 'object' && !Object.keys(v).length)));
}
const titleCase = s => s ? String(s).toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()).replace(/\bBmw\b|\bKtm\b|\bGmc\b|\bBrp\b/g, m => m.toUpperCase()) : null;
