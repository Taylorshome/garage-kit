// Vehicle types (cars, trucks, vans, SUVs, motorcycles, UTVs, ATVs), engine hours, date-only intervals,
// starter schedules, the wet-clutch oil flag, parts sources, VIN decode / recalls mapping. Run: node --test test/vehicle.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { JASO_WARNING, attrsOf, bodyFor, clearNeeds, defaultSchedule, fluidsFor, fromVpic, needsInfo, partsSources, typeOf, usesHours, wetClutch } from '../src/vehicle.js';
import { carSummary, itemStatus, soonHours } from '../src/due.js';
import { hoursPerMonth, parseHoursReply, applyMileageReply } from '../src/mileage.js';
import { estimateFor } from '../src/catchup.js';
import { createService, insertCar, withVehicle } from '../src/api.js';
import { resolveCar, setHours } from '../src/ops.js';
import { carMatch, plansForCar, rankPlans, validatePlan } from '../src/diagnosis.js';
import { GENERIC_PLANS } from '../src/generic-plans.js';
import { carSql } from '../scripts/add-car.mjs';
import { planLoad } from '../scripts/load-research.mjs';
import { backup } from '../scripts/loader-safety.mjs';
import { mileageCheck } from '../src/scheduled.js';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { decodeVin, recallsFor, similarModels } from '../src/recalls.js';
import { shoppingList } from '../src/shopping.js';
import { matchItems } from '../src/receipts.js';

const TODAY = '2026-11-24';
const BIKE = { vehicle_type: 'motorcycle', body_type: 'cruiser', attrs: JSON.stringify({ cooling: 'air', fuel_system: 'carbureted', clutch: 'wet', final_drive: 'shaft', shared_sump: true }) };

function makeEnv({ before } = {}) {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync('migrations').sort()) {
    if (before && f.startsWith('0015')) before(db);   // rows that existed before the vehicle-types migration
    db.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: r.changes } }; },
  });
  return { db, env: { DB: { prepare: sql => stmt(sql), batch: async list => Promise.all(list.map(s => s.all())) } } };
}

// ---------------------------------------------------------------- types
// cars a garage already had before 0015: their type follows the body style they were given
const OLD_CARS = [['old-sedan', 'sedan'], ['old-coupe', 'coupe'], ['old-hatch', 'hatchback'], ['old-van', 'minivan'], ['old-suv', 'suv'], ['old-truck', 'pickup']];
const seedOld = db => { for (const [id, bt] of OLD_CARS) db.prepare("INSERT INTO cars (id, nickname, year, make, model, body_type, color, created_at, updated_at, mileage) VALUES (?, ?, 2015, 'Demo', ?, ?, '#8a8f98', 0, 0, 90000)").run(id, `Old ${bt}`, bt, bt); };

test('existing cars get sensible vehicle types from the migration (miles-only, no hours)', () => {
  const { db } = makeEnv({ before: seedOld });
  const t = Object.fromEntries(db.prepare('SELECT id, vehicle_type FROM cars').all().map(r => [r.id, r.vehicle_type]));
  assert.deepEqual(t, { 'old-sedan': 'car', 'old-coupe': 'car', 'old-hatch': 'car', 'old-van': 'van', 'old-suv': 'suv', 'old-truck': 'truck' });
  assert.ok(db.prepare('SELECT * FROM cars').all().every(c => c.hours === null && c.attrs === null));
  assert.equal(usesHours(db.prepare("SELECT * FROM cars WHERE id = 'old-truck'").get()), false);
});

test('type helpers: typeOf / bodyFor / usesHours / wetClutch', () => {
  assert.equal(typeOf({ body_type: 'minivan' }), 'van');
  assert.equal(typeOf({ vehicle_type: 'utv', body_type: 'sedan' }), 'utv');
  assert.equal(typeOf({ body_type: 'cruiser' }), 'motorcycle');
  assert.equal(typeOf({}), 'car');
  assert.equal(typeOf({ body_type: 'coupe' }), 'car'); assert.equal(typeOf({ body_type: 'hatchback' }), 'car'); assert.equal(typeOf({ body_type: 'pickup' }), 'truck');
  assert.equal(bodyFor('motorcycle'), 'cruiser');
  assert.equal(bodyFor('motorcycle', 'sport'), 'sport');
  assert.equal(bodyFor('utv', 'sport'), 'utv');
  assert.ok(usesHours({ vehicle_type: 'atv' }));
  assert.ok(!usesHours({ vehicle_type: 'car' }));
  assert.ok(usesHours({ vehicle_type: 'car', hours: 12 }));   // anything with an hour meter reading
  assert.ok(wetClutch(BIKE));
  assert.ok(!wetClutch({ vehicle_type: 'motorcycle', body_type: 'scooter' }));
  assert.ok(!wetClutch({ vehicle_type: 'motorcycle', attrs: '{"clutch":"dry"}' }));
  assert.ok(wetClutch({ vehicle_type: 'atv', attrs: { clutch: 'wet' } }));
  assert.deepEqual(attrsOf({ attrs: 'not json' }), {});
});

test('needs-info placeholders: only listed fields still missing; edits clear them', () => {
  const car = { vin: null, mileage: null, attrs: JSON.stringify({ needs_info: ['vin', 'mileage', 'color', 'variant'] }) };
  assert.deepEqual(needsInfo(car).map(n => n.field), ['vin', 'mileage', 'color', 'variant']);
  assert.deepEqual(needsInfo({ ...car, mileage: 12000 }).map(n => n.field), ['vin', 'color', 'variant']);
  const a = clearNeeds(attrsOf(car), { color: '#112233', trim: 'Classic' });
  assert.deepEqual(a.needs_info, ['vin', 'mileage']);
  assert.deepEqual(needsInfo({ attrs: null }), []);   // real cars without the list never show it
});

// ---------------------------------------------------------------- due math
test('date-only intervals: months alone drive the status (tire age, battery)', () => {
  const item = { interval_months: 60, last_done_date: '2021-12-01' };
  const s = itemStatus(item, null, TODAY);   // no mileage needed
  assert.equal(s.status, 'soon'); assert.equal(s.next_due_date, '2026-12-01'); assert.equal(s.miles_left, null);
  assert.equal(itemStatus({ interval_months: 60, last_done_date: '2020-01-01' }, null, TODAY).status, 'overdue');
  assert.equal(itemStatus({ interval_months: 60, last_done_date: '2024-01-01' }, null, TODAY).status, 'ok');
  assert.equal(itemStatus({ interval_months: 60 }, null, TODAY).status, 'unknown');
});

test('hours-based due math: overdue / soon / ok, whichever of miles, hours or date comes first', () => {
  const oil = { interval_hours: 50, interval_miles: 1000, interval_months: 12, last_done_hours: 100, last_done_miles: 1500, last_done_date: '2026-06-01' };
  let s = itemStatus(oil, 1600, TODAY, 140);
  assert.equal(s.status, 'ok'); assert.equal(s.next_due_hours, 150); assert.equal(s.hours_left, 10); assert.match(s.label, /150 h/);
  s = itemStatus(oil, 1600, TODAY, 146);   // 4 h left <= soonHours(50) = 5
  assert.equal(soonHours(50), 5);
  assert.equal(s.status, 'soon'); assert.match(s.label, /4 h/);
  s = itemStatus(oil, 1600, TODAY, 152.5);   // hours first, while miles and date are fine
  assert.equal(s.status, 'overdue'); assert.match(s.label, /2\.5 h over/);
  s = itemStatus(oil, 2600, TODAY, 120);     // miles first
  assert.equal(s.status, 'overdue'); assert.match(s.label, /100 mi over/);
  // hours-only item, no reading yet
  assert.equal(itemStatus({ interval_hours: 25, last_done_hours: 10 }, null, TODAY, null).label, 'Set the engine hours');
  // never done -> unknown, not wildly overdue
  assert.equal(itemStatus({ interval_hours: 25 }, null, TODAY, 400).status, 'unknown');
  assert.equal(soonHours(10), 2); assert.equal(soonHours(1000), 25);
});

test('carSummary uses the vehicle hours; catch-up pending counts hours as history', () => {
  const car = { mileage: 1000, hours: 200 };
  const items = [{ id: 'a', name: 'Oil', interval_hours: 50, last_done_hours: 140 }, { id: 'b', name: 'Belt', interval_hours: 50, last_done_hours: null, last_done_date: null, last_done_miles: null }];
  const s = carSummary(car, items, [], TODAY);
  assert.equal(s.overdue_count, 1); assert.equal(s.catchup_pending, 1); assert.equal(s.next_due.next_due_hours, 190);
});

test('hours replies and hours per month', () => {
  assert.deepEqual(parseHoursReply('145.5 h', 140), { ok: true, hours: 145.5, unchanged: false });
  assert.equal(parseHoursReply('145 hrs', null).hours, 145);
  assert.equal(parseHoursReply('139', 140).ok, false);
  assert.equal(parseHoursReply('900', 140).ok, false);          // > 300 h jump
  assert.equal(parseHoursReply('abc', 1).ok, false);
  assert.equal(hoursPerMonth([{ date: '2026-01-01', hours: 100 }, { date: '2026-07-01', hours: 160 }]), 10.1);
  assert.equal(hoursPerMonth([{ date: '2026-11-01', hours: 100 }, { date: '2026-11-20', hours: 110 }]), null);   // < 60 days
  const e = estimateFor('6mo', { today: TODAY, mileage: null, mpm: null, hours: 200, hpm: 10 });
  assert.equal(e.last_done_hours, 140); assert.equal(e.last_done_miles, null);
  assert.equal(estimateFor('6mo', { today: TODAY, hours: 200, hpm: null }).last_done_hours, null);
});

// ---------------------------------------------------------------- starter schedules
test('motorcycle schedule follows the bike: shaft drive, carbs, air-cooled; no car-only items', () => {
  const rows = defaultSchedule(BIKE), names = rows.map(r => r.name).join(' | ');
  assert.match(names, /Final gear oil \(shaft drive\)/);
  assert.doesNotMatch(names, /Chain/);
  assert.match(names, /Valve clearance/); assert.match(names, /Carburetor sync/); assert.match(names, /Fork oil/); assert.match(names, /Brake fluid/);
  assert.match(names, /Spark plugs/); assert.match(names, /Air filter/); assert.match(names, /Battery tending/);
  assert.doesNotMatch(names, /Coolant/);                        // air-cooled
  assert.doesNotMatch(names, /Cabin|Tire rotation|Wiper|Serpentine/i);
  const age = rows.find(r => /Tire age/.test(r.name));
  assert.equal(age.interval_months, 60); assert.equal(age.interval_miles, null);   // date-only
  assert.match(rows.find(r => /Engine oil/.test(r.name)).notes, /JASO MA/);
  // chain bike, liquid-cooled, fuel injected
  const sport = defaultSchedule({ vehicle_type: 'motorcycle', body_type: 'sport', attrs: { final_drive: 'chain', cooling: 'liquid', fuel_system: 'efi' } }).map(r => r.name).join(' | ');
  assert.match(sport, /Chain clean, lube & adjust/); assert.match(sport, /Coolant/); assert.doesNotMatch(sport, /Carburetor|Final gear/);
  assert.match(defaultSchedule({ vehicle_type: 'motorcycle', attrs: { final_drive: 'belt' } }).map(r => r.name).join(), /Drive belt inspection/);
});

test('UTV / ATV schedules are by hours, with the water-crossing notes', () => {
  const u = defaultSchedule({ vehicle_type: 'utv' });
  const oil = u.find(r => r.name === 'Engine oil & filter');
  assert.equal(oil.interval_hours, 50); assert.equal(oil.interval_miles, 1000); assert.equal(oil.interval_months, 12);
  const names = u.map(r => r.name).join(' | ');
  for (const re of [/CVT drive belt/, /CVT clutches/, /pre-filter/, /Front differential/, /rear gearcase/i, /Coolant/, /Grease fittings/, /CV boots/, /Spark plug/, /Brake fluid/, /Brake pads/, /Winch/, /Battery/, /Tire age/]) assert.match(names, re);
  assert.match(u.find(r => /Front differential/.test(r.name)).severe_note, /milky/);
  for (const r of u) assert.ok(r.interval_miles || r.interval_hours || r.interval_months, `${r.name} has an interval`);
  const a = defaultSchedule({ vehicle_type: 'atv' });
  assert.equal(a.find(r => r.name === 'Engine oil & filter').interval_hours, 100);
  const car = defaultSchedule({ vehicle_type: 'car' });
  assert.equal(car.length, 12);   // cars unchanged (the kit's 12 starter items)
  assert.ok(car.every(r => r.interval_hours === null && /check your owner's manual/.test(r.notes)));
  assert.deepEqual(car.map(r => r.name).slice(0, 3), ['Oil & filter change', 'Tire rotation', 'Engine air filter']);
});

// ---------------------------------------------------------------- fluids: wet-clutch oil flag
test('fluids: wet-clutch bikes get the JASO MA/MA2 flag and the sump note; cars do not', () => {
  const rows = [{ fluid: 'Engine oil (with filter)', buy: '10W-40', amount: '2.96 qt' }, { fluid: 'Final gear oil', buy: 'SAE 80 GL-4', amount: '0.20 qt' }];
  const f = fluidsFor(BIKE, rows);
  assert.equal(f[0].jaso, 'MA/MA2'); assert.equal(f[0].warning, JASO_WARNING);
  assert.match(f[0].warning, /energy-conserving car oil/); assert.match(f[0].warning, /clutch slip/);
  assert.match(f[0].sump, /share this oil/);
  assert.equal(f[1].warning, undefined);
  assert.equal(rows[0].warning, undefined);                     // input not mutated
  const generic = fluidsFor({ vehicle_type: 'motorcycle' }, []);
  assert.equal(generic.length, 1); assert.ok(generic[0].generic); assert.match(generic[0].buy, /JASO MA/);
  assert.deepEqual(fluidsFor({ vehicle_type: 'car' }, rows), rows);
  assert.equal(fluidsFor({ vehicle_type: 'motorcycle', body_type: 'scooter' }, rows)[0].warning, undefined);
  assert.match(fluidsFor({ ...BIKE, attrs: { shared_sump: false } }, rows)[0].sump, /Separate/);
});

test('parts sources: RockAuto for cars, bike and off-road stores otherwise', () => {
  assert.equal(partsSources({ vehicle_type: 'car' }).online, 'RockAuto');
  assert.ok(partsSources(BIKE).re.test('Partzilla')); assert.ok(partsSources(BIKE).re.test('RevZilla')); assert.ok(!partsSources(BIKE).re.test('RockAuto'));
  assert.ok(partsSources({ vehicle_type: 'utv' }).re.test('Rocky Mountain ATV/MC')); assert.ok(partsSources({ vehicle_type: 'atv' }).re.test('SuperATV'));
});

// ---------------------------------------------------------------- VIN decode / recalls
test('vPIC mapping: motorcycles, UTVs, ATVs and road vehicles', () => {
  let d = fromVpic({ Make: 'YAMAHA', Model: 'V Star 650', ModelYear: '2007', VehicleType: 'MOTORCYCLE', BodyClass: 'Motorcycle - Cruiser', DisplacementCC: '649', Series: 'XVS650A/AT' });
  assert.equal(d.vehicle_type, 'motorcycle'); assert.equal(d.body_type, 'cruiser'); assert.equal(d.make, 'Yamaha'); assert.equal(d.year, 2007); assert.match(d.engine, /649cc/); assert.equal(d.trim, 'XVS650A/AT');
  d = fromVpic({ Make: 'POLARIS', Model: 'RZR XP 1000', ModelYear: '2020', VehicleType: 'MOTORCYCLE', BodyClass: '' });
  assert.equal(d.vehicle_type, 'utv');
  assert.equal(fromVpic({ Make: 'YAMAHA', Model: 'Grizzly 700', VehicleType: 'OFF ROAD VEHICLE' }).vehicle_type, 'atv');
  assert.equal(fromVpic({ Make: 'KTM', Model: '500 EXC', VehicleType: 'MOTORCYCLE', BodyClass: 'Motorcycle - Dual Sport / Adventure / Supermoto / On/Off-road' }).body_type, 'dualsport');
  assert.equal(fromVpic({ Make: 'HONDA', Model: 'Odyssey', VehicleType: 'MULTIPURPOSE PASSENGER VEHICLE (MPV)', BodyClass: 'Minivan' }).vehicle_type, 'van');
  assert.equal(fromVpic({ Make: 'TOYOTA', Model: 'RAV4', VehicleType: 'MULTIPURPOSE PASSENGER VEHICLE (MPV)', BodyClass: 'Sport Utility Vehicle (SUV)/Multi-Purpose Vehicle (MPV)' }).vehicle_type, 'suv');
  assert.equal(fromVpic({ Make: 'FORD', Model: 'Ranger', VehicleType: 'TRUCK', BodyClass: 'Pickup' }).body_type, 'pickup');
  // cars keep the kit's body styles and engine wording
  const acc = fromVpic({ ModelYear: '2003', Make: 'HONDA', Model: 'Accord', DisplacementL: '3.0', EngineConfiguration: 'V-Shaped', EngineCylinders: '6', BodyClass: 'Coupe', VehicleType: 'PASSENGER CAR', Series: 'Not Applicable' });
  assert.equal(acc.vehicle_type, 'car'); assert.equal(acc.body_type, 'coupe'); assert.equal(acc.engine, '3.0L V6'); assert.equal(acc.trim, undefined);
  assert.equal(fromVpic({ Make: 'MAZDA', Model: '3', VehicleType: 'PASSENGER CAR', BodyClass: 'Hatchback/Liftback/Notchback' }).body_type, 'hatchback');
});

test('decodeVin falls back to manual entry; recalls go to NHTSA or CPSC and fail soft', async () => {
  const none = await decodeVin('4XAVAE99XLB000000', { fetchJson: async () => ({ Results: [{ Make: '', Model: '', ModelYear: '' }] }) });
  assert.equal(none.ok, false); assert.ok(none.manual);
  const down = await decodeVin('JYAVM01E*7A', { fetchJson: async () => { throw new Error('timeout'); } });
  assert.equal(down.ok, false); assert.match(down.error, /by hand/);
  const ok = await decodeVin('JYAVM01E*7A', { fetchJson: async () => ({ Results: [{ Make: 'YAMAHA', Model: 'V Star 650', ModelYear: '2007', VehicleType: 'MOTORCYCLE', BodyClass: 'Motorcycle - Cruiser', ErrorCode: '6', ErrorText: '6 - Incomplete VIN' }] }) });
  assert.equal(ok.ok, true); assert.ok(ok.partial); assert.equal(ok.decoded.vehicle_type, 'motorcycle');
  assert.equal(ok.make, 'Yamaha'); assert.equal(ok.vehicle_type, 'motorcycle');   // also flat (the app's / decode_vin's older shape)
  await assert.rejects(decodeVin('IOQ'), /VIN/);

  assert.deepEqual(similarModels(['FJR1300', 'V STAR', 'ROAD STAR', 'V STAR 1100'], 'V Star 650'), ['V STAR']);   // not the 1100
  const urls = [];
  const nhtsa = await recallsFor({ vehicle_type: 'motorcycle', year: 2007, make: 'Yamaha', model: 'V Star 650' }, { fetchJson: async u => { urls.push(u); return u.includes('products') ? { results: [{ model: 'V STAR' }, { model: 'FZ1' }] } : { results: u.includes('V%20STAR') ? [{ NHTSACampaignNumber: '07V123000', Component: 'FUEL', Summary: 's', Remedy: 'r' }] : [] }; } });
  assert.equal(nhtsa.source, 'NHTSA'); assert.equal(nhtsa.results.length, 1); assert.deepEqual(nhtsa.checked_models, ['V STAR']); assert.ok(nhtsa.nhtsa_vin_check);
  const cpsc = await recallsFor({ vehicle_type: 'utv', year: 2020, make: 'Polaris', model: 'RZR XP 1000' }, { fetchJson: async u => {
    assert.match(u, /saferproducts\.gov.*RecallTitle=RZR/);
    return [{ RecallNumber: '20-1', RecallDate: '2020-05-01T00:00:00', Title: 'Polaris Recalls RZR XP 1000', Description: 'Model year 2020 RZR XP 1000', URL: 'https://www.cpsc.gov/x', Manufacturers: [{ Name: 'Polaris' }] },
      { RecallNumber: '99-1', RecallDate: '2015-01-01T00:00:00', Title: 'Other Co recalls RZR toy', Description: 'toy', Manufacturers: [{ Name: 'Other' }] }];
  } });
  assert.equal(cpsc.source, 'CPSC'); assert.equal(cpsc.results.length, 1); assert.equal(cpsc.results[0].campaign, '20-1'); assert.ok(cpsc.cpsc_search);
  const fail = await recallsFor({ vehicle_type: 'atv', year: 2020, make: 'Honda', model: 'Rancher' }, { fetchJson: async () => { throw new Error('503'); } });
  assert.match(fail.error, /CPSC lookup failed/); assert.ok(fail.cpsc_search);
});

// ---------------------------------------------------------------- DB flows
test('add a motorcycle with its starter schedule; loose names resolve; hours flow through services', async () => {
  const { env, db } = makeEnv();
  const id = await insertCar(env, { nickname: 'V Star', year: 2007, make: 'Yamaha', model: 'V Star 650', vehicle_type: 'motorcycle', body_type: 'cruiser', color: '#8a8f98', mileage: null,
    attrs: JSON.stringify({ cooling: 'air', fuel_system: 'carbureted', clutch: 'wet', final_drive: 'shaft', shared_sump: true, needs_info: ['vin', 'mileage'] }) }, { defaultSchedule: true, id: 'car-test-bike' });
  assert.equal(id, 'car-test-bike');
  const items = db.prepare('SELECT name, interval_miles, interval_months FROM schedule_items WHERE car_id = ?').all(id);
  assert.ok(items.some(i => /Final gear oil/.test(i.name)));
  await insertCar(env, { nickname: 'Work truck', year: 2012, make: 'Ford', model: 'F-150', vehicle_type: 'truck', body_type: 'pickup' }, { id: 'car-test-truck' });
  await insertCar(env, { nickname: 'Family hauler', year: 2016, make: 'Honda', model: 'Odyssey', body_type: 'minivan' }, { id: 'car-test-van' });
  await insertCar(env, { nickname: 'Zippy', year: 2014, make: 'Mazda', model: 'MX-5', body_type: 'coupe' }, { id: 'car-test-coupe' });
  for (const ref of ['the bike', 'vstar', 'yamaha', 'V Star', 'motorcycle']) assert.equal((await resolveCar(env, ref)).id, id, ref);
  assert.equal((await resolveCar(env, 'the truck')).id, 'car-test-truck');
  assert.equal((await resolveCar(env, 'van')).id, 'car-test-van');
  assert.equal((await resolveCar(env, 'the coupe')).id, 'car-test-coupe');
  const v = withVehicle(db.prepare('SELECT * FROM cars WHERE id = ?').get(id));
  assert.deepEqual(v.needs_info.map(n => n.field), ['vin', 'mileage']); assert.equal(v.uses_hours, false);

  // a UTV: hours set, a service at 145 h marks the oil done by hours
  const u = await insertCar(env, { nickname: 'Test RZR', year: 2020, make: 'Polaris', model: 'RZR XP 1000', vehicle_type: 'utv', body_type: 'utv', color: '#c8102e', mileage: 1800, hours: 120 }, { defaultSchedule: true, id: 'car-test-utv' });
  assert.equal((await resolveCar(env, 'the side by side')).id, u);
  const oil = db.prepare("SELECT id FROM schedule_items WHERE car_id = ? AND name = 'Engine oil & filter'").get(u);
  await createService(env, u, { date: '2026-11-20', hours: '145', mileage: 1830, title: 'Oil change', item_ids: [oil.id] }, { name: 't' });
  const it = db.prepare('SELECT last_done_hours, last_done_miles FROM schedule_items WHERE id = ?').get(oil.id);
  assert.equal(it.last_done_hours, 145); assert.equal(it.last_done_miles, 1830);
  const car = db.prepare('SELECT hours, mileage FROM cars WHERE id = ?').get(u);
  assert.equal(car.hours, 145); assert.equal(car.mileage, 1830);
  assert.equal(db.prepare('SELECT count(*) n FROM hours_log WHERE car_id = ?').get(u).n, 2);   // insert + service bump
  const st = itemStatus({ ...db.prepare('SELECT * FROM schedule_items WHERE id = ?').get(oil.id) }, 1830, TODAY, 196);
  assert.equal(st.status, 'overdue');
  await setHours(env, u, '150.25 h', 'mcp');
  assert.equal(db.prepare('SELECT hours FROM cars WHERE id = ?').get(u).hours, 150.3);
  // the monthly HA reply for hours
  let r = await applyMileageReply(env, { car_id: u, reply: '152', kind: 'hours' });
  assert.equal(r.saved, true); assert.equal(r.hours, 152);
  r = await applyMileageReply(env, { car_id: u, reply: '100', kind: 'hours' });
  assert.equal(r.saved, false);
  // shopping list labels for off-road
  const sl = await shoppingList(env, db.prepare('SELECT * FROM cars WHERE id = ?').get(u));
  assert.match(sl.online_label, /Partzilla|Rocky Mountain/);
});

test('built-in UTV plans match UTVs only; the demo bike plan and data validate', async () => {
  assert.deepEqual(GENERIC_PLANS.map(p => p.id).sort(), ['utv-cvt-belt-slip', 'utv-overheating']);
  for (const p of GENERIC_PLANS) {
    assert.deepEqual(validatePlan(p), [], p.id);
    assert.equal(p.car_id, null);
    assert.ok(carMatch(p, { id: 'x', vehicle_type: 'utv' }));
    assert.ok(!carMatch(p, { id: 'car-sedan', vehicle_type: 'car', year: 2015, make: 'Demo', model: 'Sedan' }));
    assert.ok(!carMatch(p, { id: 'b', vehicle_type: 'motorcycle' }));
    assert.ok(!carMatch(p, { id: 'a', vehicle_type: 'atv' }));
    for (const st of p.steps) assert.ok(st.sources.every(u => /^https:\/\//.test(u)) && st.sources.length, `${p.id}/${st.id} cites sources`);
  }
  // a UTV added to an empty garage gets them at once (no loader needed); a car doesn't
  const { env } = makeEnv();
  await insertCar(env, { nickname: 'Side by side', vehicle_type: 'utv' }, { id: 'car-u' });
  await insertCar(env, { nickname: 'Sedan', vehicle_type: 'car' }, { id: 'car-s' });
  const u = await plansForCar(env, { id: 'car-u', vehicle_type: 'utv' });
  assert.deepEqual(u.map(p => p.id).sort(), ['utv-cvt-belt-slip', 'utv-overheating']);
  assert.equal(rankPlans(u, { id: 'car-u', vehicle_type: 'utv' }, 'burning belt smell, slipping')[0].plan.id, 'utv-cvt-belt-slip');
  assert.equal(rankPlans(u, { id: 'car-u', vehicle_type: 'utv' }, 'running hot, temp light')[0].plan.id, 'utv-overheating');
  assert.deepEqual(await plansForCar(env, { id: 'car-s', vehicle_type: 'car' }), []);

  const dir = 'demo/bike/research';
  const plans = JSON.parse(readFileSync(`${dir}/diagnosis-plans.json`, 'utf8')).plans;
  for (const p of plans) assert.deepEqual(validatePlan(p), []);
  assert.equal(plans[0].id, 'vstar-hard-start');
  assert.ok(carMatch(plans[0], { id: 'other', year: 2007, make: 'Yamaha', model: 'V Star 650' }));
  assert.ok(JSON.parse(readFileSync(`${dir}/fluids.json`, 'utf8')).some(f => /JASO/.test(`${f.buy} ${f.notes}`)));
});

test('demo vehicles are generic: nothing personal in demo/', () => {
  const files = [];
  const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
  walk('demo');
  for (const f of files) {
    const t = readFileSync(f, 'utf8');
    assert.doesNotMatch(t, /\b[A-HJ-NPR-Z0-9]{17}\b/, `${f}: looks like a VIN`);
    assert.doesNotMatch(t, /[\w.+-]+@[\w-]+\.[\w.]+/, `${f}: an email address`);
    assert.doesNotMatch(t, /\b(10|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+/, `${f}: a private IP`);
  }
  for (const f of ['demo/bike/demo-car.json', 'demo/utv/demo-car.json']) {
    const c = JSON.parse(readFileSync(f, 'utf8')).car;
    assert.equal(c.vin, undefined, f);
    const { sql, vehicle_type } = carSql(JSON.parse(readFileSync(f, 'utf8')), { id: 'x' });
    assert.ok(sql.length > 10 && ['motorcycle', 'utv'].includes(vehicle_type));
  }
});

test('receipts know bike and off-road jobs', () => {
  const items = [{ id: 'fg', name: 'Final gear oil (shaft drive)' }, { id: 'cs', name: 'Carburetor sync & idle speed' }, { id: 'vc', name: 'Valve clearance check' }, { id: 'af', name: 'Air filter' },
    { id: 'fd', name: 'Front differential / gearcase fluid' }, { id: 'bt', name: 'CVT drive belt inspect / clean' }];
  const draft = { kind: 'service', line_items: [{ description: 'Final drive oil change', type: 'service' }, { description: 'Carb sync', type: 'labor' }, { description: 'Valve adjustment', type: 'labor' },
    { description: 'K&N air filter YA-6598', type: 'part' }, { description: 'Front diff fluid service', type: 'service' }], schedule_items: [] };
  assert.deepEqual(matchItems(draft, items).map(m => m.id).sort(), ['af', 'cs', 'fd', 'fg', 'vc']);
});

// ---------------------------------------------------------------- monthly reading check, loaders, add-car script
test('monthly check: UTVs / ATVs are asked for engine hours (HA "Enter hours"), road vehicles for mileage', async () => {
  const { env, db } = makeEnv();
  env.HA_MILEAGE_TOKEN = 'x'; env.APP_ORIGIN = 'https://garage.example';
  await insertCar(env, { nickname: 'Sedan', vehicle_type: 'car', mileage: 50000 }, { id: 'car-s' });
  await insertCar(env, { nickname: 'RZR', vehicle_type: 'utv', hours: 42 }, { id: 'car-u' });
  await insertCar(env, { nickname: 'Quad', vehicle_type: 'atv' }, { id: 'car-a' });
  assert.equal(await mileageCheck(env, '2026-12'), 3);
  const n = Object.fromEntries(db.prepare('SELECT url, title, body FROM notifications').all().map(r => [r.url, r]));
  assert.match(n['#/car/car-s/mileage'].title, /monthly mileage check \(Sedan\)/);
  assert.match(n['#/car/car-u/hours'].title, /engine hours check \(RZR\)/); assert.match(n['#/car/car-u/hours'].body, /hour meter.*42 h/);
  assert.ok(n['#/car/car-a/hours']);
  assert.equal(await mileageCheck(env, '2026-12'), 0);   // once a month
  // the HA reply for an hours prompt: GARAGE_HR_<id> -> kind hours (index.js); applyMileageReply checks it like mileage
  let r = await applyMileageReply(env, { car_id: 'car-u', reply: '45.5 hrs', kind: 'hours' });
  assert.equal(r.saved, true); assert.equal(db.prepare("SELECT hours FROM cars WHERE id = 'car-u'").get().hours, 45.5);
  r = await applyMileageReply(env, { car_id: 'car-u', reply: '40', kind: 'hours' });
  assert.equal(r.saved, false); assert.match(r.reason, /lower/);
});

test('load-research: hours intervals in a researched schedule, generic per-type plans stay generic', () => {
  const { db } = makeEnv();
  const q = sql => db.prepare(sql).all();
  const dir = mkdtempSync(join(tmpdir(), 'gk-utv-'));
  try {
    db.exec(carSql({ car: { nickname: 'RZR', vehicle_type: 'utv', hours: 140 } }, { id: 'car-u' }).sql.join('\n'));
    writeFileSync(join(dir, 'research.json'), JSON.stringify({ vehicle: { year: 2020 }, schedule: [
      { item: 'Engine oil & filter (manual)', interval_hours: 50, interval_miles: 1000, interval_months: 12, source: 'manual' },
      { item: 'Tire age replacement', interval_months: 60, source: 'typical' },
      { item: 'Belt hours only', interval_hours: 25.5, source: 'manual' } ] }));
    writeFileSync(join(dir, 'diagnosis-plans.json'), JSON.stringify({ plans: [{ ...GENERIC_PLANS[0], id: 'utv-belt-copy' }] }));
    const { sql } = planLoad({ car: { id: 'car-u', nickname: 'RZR' }, dir, opts: { schedule: true }, q });
    db.exec(sql.join('\n'));
    const items = Object.fromEntries(q("SELECT name, interval_hours, interval_miles, interval_months, source FROM schedule_items WHERE car_id = 'car-u' AND source <> 'starter'").map(r => [r.name, r]));
    assert.equal(items['Engine oil & filter (manual)'].interval_hours, 50);
    assert.equal(items['Belt hours only'].interval_hours, 25.5);   // one decimal kept
    assert.equal(items['Tire age replacement'].interval_months, 60); assert.equal(items['Tire age replacement'].interval_miles, null);
    const p = q("SELECT car_id FROM diag_plans WHERE id = 'utv-belt-copy'")[0];
    assert.equal(p.car_id, null);   // generic: matches every UTV
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('load-research: the demo bike loads (schedule replaces starter items, JASO fluids, plan for its model)', () => {
  const { db } = makeEnv();
  const q = sql => db.prepare(sql).all();
  db.exec(carSql(JSON.parse(readFileSync('demo/bike/demo-car.json', 'utf8')), { id: 'car-demo-bike' }).sql.join('\n'));
  assert.ok(q("SELECT 1 FROM schedule_items WHERE car_id = 'car-demo-bike' AND source = 'starter' AND name LIKE 'Final gear oil%'").length);
  const { plan, sql } = planLoad({ car: { id: 'car-demo-bike', nickname: 'V Star' }, dir: 'demo/bike/research', opts: { schedule: true, todos: true }, q });
  assert.equal(plan.count('overwrite') + plan.count('delete') + plan.count('drift'), 0);
  db.exec(sql.join('\n'));
  const names = q("SELECT name, source FROM schedule_items WHERE car_id = 'car-demo-bike'");
  assert.ok(names.some(n => n.name === 'Final gear oil: change (shaft drive)' && n.source === 'manual'));
  assert.equal(names.filter(n => n.source === 'starter').length, 0);
  assert.equal(q("SELECT car_id FROM diag_plans WHERE id = 'vstar-hard-start'")[0].car_id, 'car-demo-bike');
  const fl = fluidsFor({ vehicle_type: 'motorcycle', attrs: q("SELECT attrs FROM cars WHERE id = 'car-demo-bike'")[0].attrs }, JSON.parse(q("SELECT fluids FROM parts_guides WHERE car_id = 'car-demo-bike'")[0].fluids));
  assert.equal(fl[0].jaso, 'MA/MA2');
});

test('add-car script: starter schedule per type, hours and attrs stored', () => {
  const { db } = makeEnv();
  const bike = carSql({ car: { nickname: 'Ninja', vehicle_type: 'motorcycle', body_type: 'sport', attrs: { final_drive: 'chain', cooling: 'liquid', fuel_system: 'efi' } } }, { id: 'b' });
  const utv = carSql({ car: { nickname: 'RZR', make: 'Polaris', model: 'RZR XP 1000', vehicle_type: 'utv', hours: '142.5 h', mileage: '1,830' } }, { id: 'u' });
  const coupe = carSql({ car: { nickname: 'Zippy', body_type: 'coupe' } }, { id: 'c' });
  db.exec([...bike.sql, ...utv.sql, ...coupe.sql].join('\n'));
  const car = id => db.prepare('SELECT vehicle_type, body_type, hours, attrs FROM cars WHERE id = ?').get(id);
  assert.deepEqual({ ...car('c') }, { vehicle_type: 'car', body_type: 'coupe', hours: null, attrs: null });
  assert.equal(car('u').vehicle_type, 'utv'); assert.equal(car('u').body_type, 'utv'); assert.equal(car('u').hours, 142.5);
  assert.equal(JSON.parse(car('b').attrs).final_drive, 'chain');
  const names = id => db.prepare('SELECT name FROM schedule_items WHERE car_id = ?').all(id).map(r => r.name).join(' | ');
  assert.match(names('b'), /Chain clean/); assert.match(names('b'), /Coolant/); assert.doesNotMatch(names('b'), /Carburetor/);
  assert.equal(db.prepare("SELECT interval_hours FROM schedule_items WHERE car_id = 'u' AND name = 'Engine oil & filter'").get().interval_hours, 50);
  assert.equal(db.prepare("SELECT count(*) n FROM hours_log WHERE car_id = 'u'").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM schedule_items WHERE car_id = 'c'").get().n, 12);
  assert.throws(() => carSql({ car: { nickname: 'x', vehicle_type: 'boat' } }), /vehicle_type/);
  assert.throws(() => carSql({ car: { nickname: 'x', attrs: { final_drive: 'rope' } } }), /final_drive/);
});

test('loader backups export one table per wrangler call (older wrangler refuses a repeated --table)', () => {
  const root = mkdtempSync(join(tmpdir(), 'gk-bak-'));
  try {
    const calls = [];
    // stands in for wrangler 4.69, whose d1 export takes a single --table
    const run = args => {
      calls.push(args);
      const tables = args.flatMap((a, i) => (a === '--table' ? [args[i + 1]] : []));
      if (tables.length > 1) throw new Error(`The argument "--table" expects a single value, but received multiple: ${JSON.stringify(tables)}.`);
      writeFileSync(args[args.indexOf('--output') + 1], `CREATE TABLE ${tables[0]} (id TEXT);\nINSERT INTO ${tables[0]} VALUES ('x');\n`);
    };
    const r = backup({ tables: ['research', 'schedule_items', 'diag_plans'], loader: 't', remote: true, dbName: 'garage', root, run, log: () => {} });
    assert.ok(r.path && existsSync(r.path), JSON.stringify(r));
    assert.equal(calls.length, 3);
    const txt = readFileSync(r.path, 'utf8');
    for (const t of ['research', 'schedule_items', 'diag_plans']) assert.match(txt, new RegExp(`CREATE TABLE ${t} `));
    assert.deepEqual(readdirSync(join(root, 'backups', 'd1')).filter(f => f.endsWith('.part')), []);   // parts cleaned up
    // a failing table export fails the whole backup (exit 4, nothing written by the loader)
    const bad = backup({ tables: ['research', 'brands'], loader: 't', remote: true, dbName: 'garage', root, run: a => { if (a.includes('brands')) throw new Error('boom'); run(a); }, log: () => {} });
    assert.equal(bad.exit, 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
