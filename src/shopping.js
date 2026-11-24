// Brand picks per part, and a per-car shopping list built from open to-dos + overdue/due-soon schedule items.
// Cars: RockAuto first (bigger parts are usually cheapest there). Motorcycles: Partzilla / RevZilla / BikeBandit / OEM fiche.
// UTVs / ATVs: Partzilla OEM fiche / Rocky Mountain ATV/MC / SuperATV. Fluids, batteries and parts for urgent
// (high-priority) to-dos are "buy locally" (for bikes and off-road: the local dealer).
import { carSummary } from './due.js';
import { partsSources } from './vehicle.js';
import { HttpError, newId, nowSec, str, todayLocal } from './util.js';

export async function brandsForCar(env, carId, re = RA) {
  const [{ results }, meta] = await Promise.all([
    env.DB.prepare('SELECT idx, part, category, matched_part, data FROM brands WHERE car_id = ?1 ORDER BY idx').bind(carId).all(),
    env.DB.prepare('SELECT meta FROM brands_meta WHERE car_id = ?1').bind(carId).first(),
  ]);
  return { meta: meta ? JSON.parse(meta.meta) : null, parts: results.map(r => ({ ...JSON.parse(r.data), idx: r.idx, matched_part: r.matched_part, options: sortOptions(JSON.parse(r.data).options || [], re) })) };
}
const RA = /rockauto/i;
/** Preferred online store test for a vehicle (RockAuto for cars; bike / off-road stores otherwise). */
export const onlineRe = car => car ? partsSources(car).re : RA;
const isOnline = (o, re = RA) => re.test(`${o.where || ''}`);
export const sortOptions = (opts, re = RA) => [...opts].sort((a, b) => (isOnline(b, re) ? 1 : 0) - (isOnline(a, re) ? 1 : 0));

/** The option the "pick" text names (brand mentioned in it), preferring the vehicle's online store; else the first best-value / pick option. */
export function pickedOption(p, re = RA) {
  const pick = String(p.pick || '').toLowerCase();
  const isRA = o => isOnline(o, re);
  const opts = sortOptions(p.options || [], re).filter(o => !/avoid|overpriced/i.test(o.verdict || ''));
  const named = opts.filter(o => { const b = String(o.brand || '').toLowerCase().split(/[\s/(]+/)[0]; return b.length > 2 && pick.includes(b); });
  const pn = opts.find(o => o.part_number && pick.includes(String(o.part_number).toLowerCase().split(/[\s(/]+/)[0]));
  return pn || named.find(isRA) || named[0] || opts.find(o => /best value|^pick$/i.test(o.verdict || '')) || opts[0] || null;
}
export const priceOf = o => { const m = String(o?.price_usd ?? '').replace(/,/g, '').match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; };

// what a to-do / schedule item needs: [regex on its text, regex on brand part names]
const NEEDS = [
  [/overheat|coolant|cooling|radiator|thermostat|water pump/i, /coolant|thermostat|water pump|radiator|hose|cap|reservoir|surge|tee|fan|crossover/i],
  [/tick|lifter|rocker|valvetrain/i, /oil filter|engine oil|rocker|lash|lifter|valve cover|exhaust (flange|manifold)|flange stud|manifold bolt/i],
  [/rattle|mount/i, /heat shield|mount|tensioner|idler|crossunder/i],
  [/hvac|actuator|air door|blend|mode door/i, /actuator/i],
  [/oil change|engine oil|\boil\b.*filter/i, /^engine oil|oil filter/i],
  [/brake line|brake, fuel|cooler line/i, /brake line|cooler line|brake fluid/i],
  [/front-end|ball joint|tie rod|idler arm/i, /front-end/i],
  [/air filter/i, /engine air filter/i], [/cabin/i, /cabin/i], [/spark plug/i, /spark plug|plug wire/i],
  [/transmission fluid|transaxle|automatic transmission/i, /transmission fluid|atf|automatic transmission fluid|filter \+ pan|filter kit/i],
  [/transfer case/i, /transfer case/i], [/differential|axle fluid/i, /differential/i], [/fuel filter/i, /fuel filter/i],
  [/brake fluid/i, /brake fluid/i], [/brake (pad|inspection)|brakes/i, /brake pads|rotors/i], [/wiper/i, /wiper/i],
  [/battery/i, /battery/i], [/belt/i, /serpentine belt|tensioner/i],
];
  // motorcycles / off-road
NEEDS.push(
  [/valve/i, /valve|shim|tappet|feeler|cover gasket/i], [/carb|idle|sync/i, /carb|jet|float|sync|gasket/i],
  [/final gear|shaft drive|final drive/i, /final gear|gear oil|hypoid|drain washer|crush washer/i], [/chain/i, /chain|sprocket|lube/i],
  [/drive belt|cvt belt|belt (inspection|replacement)/i, /drive belt|cvt belt/i], [/clutch/i, /clutch|roller|weight|button/i],
  [/fork/i, /fork|seal/i], [/charging|stator|rectifier|battery drain/i, /stator|rectifier|regulator|battery/i],
  [/grease/i, /grease/i], [/cv boot/i, /cv boot|axle/i], [/winch/i, /winch|rope|cable/i], [/tire age|tire/i, /tire|tyre/i],
);
const LOCAL = /oil|fluid|coolant|atf|battery|tire|tyre|wiper|bulb/i;

export async function shoppingList(env, car) {
  const src = partsSources(car);
  const [{ parts }, items, todos] = await Promise.all([
    brandsForCar(env, car.id, src.re),
    env.DB.prepare('SELECT * FROM schedule_items WHERE car_id = ?1').bind(car.id).all().then(r => r.results),
    env.DB.prepare("SELECT * FROM todos WHERE car_id = ?1 AND status = 'open'").bind(car.id).all().then(r => r.results),
  ]);
  const sum = carSummary(car, items, todos, todayLocal());
  const reasons = [
    ...sum.items.filter(i => i.status === 'overdue' || i.status === 'soon').map(i => ({ kind: 'due', text: i.name, label: `${i.name} (${i.label})`, urgent: i.status === 'overdue' })),
    ...todos.map(t => ({ kind: 'todo', text: t.title, label: t.title, urgent: t.priority === 'high', todo_id: t.id })),
  ];
  const lines = new Map();
  for (const r of reasons) {
    for (const [src, want] of NEEDS) {
      if (!src.test(r.text)) continue;
      for (const p of parts.filter(p => want.test(p.part))) {
        const o = pickedOption(p, src.re);
        if (!o) continue;
        const key = p.idx;
        const ln = lines.get(key) || { part: p.part, category: p.category, pick: p.pick, option: { brand: o.brand, part_number: o.part_number, price_usd: o.price_usd, where: o.where, verdict: o.verdict, tier: o.tier },
          est_price: priceOf(o), for: [], default_selected: false, local: false };
        ln.for.push(r.label);
        if (r.kind === 'due') ln.default_selected = true;          // due maintenance: buy it; diagnosis parts: only if the checks point there
        if (LOCAL.test(`${p.part} ${p.category}`) || r.urgent || !isOnline(o, src.re)) ln.local = true;
        lines.set(key, ln);
      }
    }
  }
  const all = [...lines.values()].map(l => ({ ...l, for: [...new Set(l.for)] }));
  const rockauto = all.filter(l => !l.local), local = all.filter(l => l.local);
  const total = list => Math.round(list.filter(l => l.default_selected && l.est_price).reduce((n, l) => n + l.est_price, 0) * 100) / 100;
  const extras = await extrasForCar(env, car.id);
  // "rockauto" keeps its name for older clients: it is the vehicle's preferred online store (see online_label)
  return { car: car.nickname, rockauto, local, extras, online_label: src.online_label, local_label: src.local_label, online_store: src.online,
    est_total_selected: { rockauto: total(rockauto), local: total(local), extras: Math.round(extras.reduce((n, x) => n + (priceOf(x) || 0), 0) * 100) / 100 },
    note: `Estimated from the brand research picks, one unit each, before shipping/tax. Due maintenance is pre-selected; parts for open problems are listed but only worth buying once the checks point to them. ${src.online === 'RockAuto' ? 'Local prices/stock were mostly not verifiable online: call ahead.' : 'Check fitment on the OEM parts fiche (diagrams) for your VIN / model code, and call the local dealer for stock.'}` };
}

// ---------- hand-added items (tools, supplies) ----------
const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export async function extrasForCar(env, carId) {
  const { results } = await env.DB.prepare("SELECT * FROM shopping_extras WHERE car_id = ?1 AND status = 'open' ORDER BY created_at").bind(carId).all();
  return results.map(r => ({ id: r.id, name: r.name, kind: r.kind, brand: r.brand, part_number: r.part_number, price_usd: r.price_usd, where: r.where_buy, url: r.url, note: r.note, added_by: r.created_by }));
}

/** Add an item unless the car's list already has it (same name, same part number, or a computed line for the same part). */
export async function addExtra(env, car, b, member) {
  const name = str(b.name, 160, { required: true, name: 'Name' });
  const kind = ['part', 'tool', 'supply'].includes(b.kind) ? b.kind : 'part';
  const pn = str(b.part_number, 60);
  const url = str(b.url, 500);
  if (url && !/^https:\/\/[^\s]+$/.test(url)) throw new HttpError(400, 'url must be an https link');
  const list = await shoppingList(env, car);
  const n = normName(name);
  const dup = list.extras.find(x => normName(x.name) === n || (pn && normName(x.part_number) === normName(pn)))
    || [...list.rockauto, ...list.local].find(l => normName(l.part) === n || (pn && normName(l.option.part_number).split(' ')[0] === normName(pn)));
  if (dup) return { duplicate: true, item: dup, note: 'Already on the shopping list; nothing added.' };
  const id = newId();
  await env.DB.prepare(`INSERT INTO shopping_extras (id, car_id, name, kind, brand, part_number, price_usd, where_buy, url, note, status, created_by, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'open', ?11, ?12)`)
    .bind(id, car.id, name, kind, str(b.brand, 80), pn, str(b.price_usd, 40), str(b.where, 120), url, str(b.note, 1000), member?.name || null, nowSec()).run();
  return { duplicate: false, id };
}

export async function removeExtra(env, id, status = 'removed') {
  const r = await env.DB.prepare("UPDATE shopping_extras SET status = ?1 WHERE id = ?2 AND status = 'open'").bind(status === 'bought' ? 'bought' : 'removed', id).run();
  if (!r.meta?.changes) throw new HttpError(404, 'Shopping item not found');
  return { ok: true };
}
