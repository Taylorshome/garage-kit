// VIN decode (NHTSA vPIC) and open-recall lookups: NHTSA for road vehicles (cars, trucks, motorcycles),
// CPSC (saferproducts.gov) for off-road vehicles (UTVs / ATVs are consumer products, not motor vehicles).
// Every lookup fails soft: on an error or no data the reply carries the official search link instead.
import { HttpError } from './util.js';
import { fromVpic, isOffroad, typeOf } from './vehicle.js';

const UA = { 'User-Agent': 'garage-kit', Accept: 'application/json' };
async function getJson(url, ms = 8000) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  return r.json();
}

/** Decode a (full or partial, `*` for unknown positions) VIN. Off-road VINs are often only partly covered. */
export async function decodeVin(vinIn, { fetchJson = getJson } = {}) {
  const vin = String(vinIn || '').trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9*]{5,17}$/.test(vin)) throw new HttpError(400, 'VIN must be letters/digits (no I, O or Q)');
  let r;
  try { r = (await fetchJson(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`)).Results?.[0]; }
  catch (e) { return { ok: false, vin, error: `The NHTSA VIN decoder didn't answer (${e.message}). Fill in the details by hand.`, manual: true }; }
  if (!r || (!r.Make && !r.Model && !r.ModelYear)) return { ok: false, vin, error: 'NHTSA has no data for this VIN (common for off-road vehicles). Fill in the details by hand.', manual: true };
  const d = fromVpic(r);
  const codes = String(r.ErrorCode || '0').split(/[,\s]+/).filter(c => c && c !== '0');
  const partial = !d.model || !d.year || codes.some(c => ['1', '4', '5', '6', '11', '14'].includes(c));
  // the decoded fields are also at the top level (the shape the app and decode_vin used before vehicle types)
  return { ...d, ok: true, vin, decoded: d, partial, note: partial ? `Partly decoded (${String(r.ErrorText || '').split(';')[0].slice(0, 120)}). Check the fields before saving.` : undefined,
    error: codes.length ? String(r.ErrorText || '').split(';')[0].slice(0, 160) || null : null, source: 'NHTSA vPIC', full_vin: vin.length === 17 && !vin.includes('*') };
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const searchLinks = car => {
  const q = encodeURIComponent(`${car.make || ''} ${car.model || ''}`.trim());
  return isOffroad(car)
    ? { cpsc_search: `https://www.cpsc.gov/Recalls?search_combined_fields=${q}`, maker_lookup: 'Check the maker\'s own VIN recall lookup too (Polaris, Can-Am/BRP, Honda, Yamaha, Kawasaki all have one).' }
    : { nhtsa_vin_check: 'https://www.nhtsa.gov/recalls', note: 'Enter the 17-character VIN at nhtsa.gov/recalls for open recalls on this exact vehicle (repairs are free).' };
};

/** NHTSA model names for make + year that look like ours ("V Star 650" -> "V STAR", "V STAR 650 CLASSIC"). Pure. */
export function similarModels(models, model) {
  const want = norm(model), first = norm(String(model || '').split(/\s+/)[0]);
  const scored = models.map(m => {
    const n = norm(m);
    const sc = n === want ? 3 : (n.includes(want) || want.includes(n)) && n.length >= 2 ? 2 : first.length >= 2 && n.startsWith(first) ? 1 : 0;
    return [sc, m];
  }).filter(([sc]) => sc > 0).sort((a, b) => b[0] - a[0]);
  return [...new Set(scored.map(([, m]) => m))].slice(0, 4);
}

/** Open recalls for a vehicle row. */
export async function recallsFor(car, { fetchJson = getJson } = {}) {
  const type = typeOf(car);
  const links = searchLinks(car);
  if (!car.make || !car.model) return { source: null, results: [], ...links, note: 'Add the make and model to look up recalls.' };
  if (isOffroad(car)) {
    const word = String(car.model).split(/\s+/).find(w => w.length >= 3) || car.model;
    try {
      const rows = await fetchJson(`https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallTitle=${encodeURIComponent(word)}`, 12000);
      const mk = norm(car.make).replace('canam', 'can');
      const hits = (Array.isArray(rows) ? rows : []).filter(r => norm(`${r.Title} ${r.Description}`).includes(mk) || (r.Manufacturers || []).some(x => norm(x.Name).includes(mk)))
        .filter(r => !car.year || !/\b(19|20)\d{2}\b/.test(r.Description || '') || new RegExp(`\\b${car.year}\\b|${car.year - 1}-${car.year + 1}|\\b(19|20)\\d{2}\\s*(-|through|to)\\s*(19|20)\\d{2}`).test(r.Description || ''))
        .sort((a, b) => String(b.RecallDate).localeCompare(String(a.RecallDate))).slice(0, 15)
        .map(r => ({ campaign: r.RecallNumber, date: String(r.RecallDate || '').slice(0, 10), title: r.Title, summary: String(r.Description || '').slice(0, 600),
          hazard: (r.Hazards || []).map(h => h.Name).join(' ').slice(0, 300) || undefined, remedy: (r.Remedies || []).map(h => h.Name).join(' ').slice(0, 300) || undefined, url: r.URL }));
      return { source: 'CPSC', type, query: word, results: hits, ...links, note: 'Off-road vehicles are recalled through the CPSC, not NHTSA. Matches are by model name and may include other years: check the VIN ranges in each recall.' };
    } catch (e) {
      return { source: 'CPSC', type, results: [], error: `CPSC lookup failed (${e.message}); use the search link.`, ...links };
    }
  }
  try {
    const year = car.year;
    const list = year ? (await fetchJson(`https://api.nhtsa.gov/products/vehicle/models?modelYear=${year}&make=${encodeURIComponent(car.make)}&issueType=r`)).results || [] : [];
    const models = similarModels(list.map(x => x.model), car.model);
    if (!models.length) models.push(car.model);
    const out = [], unavailable = [];
    for (const m of models) {
      // recallsByVehicle intermittently answers 400 for some models (seen for YAMAHA "V STAR", Nov 2026): one retry, then report it
      const url = `https://api.nhtsa.gov/recalls/recallsByVehicle?make=${encodeURIComponent(car.make)}&model=${encodeURIComponent(m)}&modelYear=${year || ''}`;
      let r = null;
      for (let i = 0; i < 2 && !r; i++) { try { r = await fetchJson(url); } catch (e) { if (i) unavailable.push(`${m} (${e.message})`); } }
      if (!r) continue;
      for (const x of r.results || []) if (!out.some(o => o.campaign === x.NHTSACampaignNumber))
        out.push({ campaign: x.NHTSACampaignNumber, date: x.ReportReceivedDate, component: x.Component, summary: x.Summary, consequence: x.Consequence, remedy: x.Remedy, model: m,
          url: `https://www.nhtsa.gov/recalls?nhtsaId=${encodeURIComponent(x.NHTSACampaignNumber)}` });
    }
    if (unavailable.length === models.length) return { source: 'NHTSA', type, checked_models: models, results: [], error: `NHTSA didn't answer for ${unavailable.join(', ')}; use the VIN check link.`, ...links };
    return { source: 'NHTSA', type, checked_models: models, results: out, ...(unavailable.length ? { unavailable } : {}), ...links };
  } catch (e) {
    return { source: 'NHTSA', type, results: [], error: `NHTSA lookup failed (${e.message}); use the VIN check link.`, ...links };
  }
}
