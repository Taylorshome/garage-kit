// Alternates: per part, the OEM / first-choice part number and the good alternate brands (RockAuto first),
// with "avoid" brands kept separate. Built from the brand research (brands table) plus parts-list part numbers
// for parts the brand research doesn't cover. Shared by GET /api/cars/:id/alternates and MCP get_alternates.
import { brandsForCar, pickedOption, priceOf } from './shopping.js';

const isRA = o => /rockauto/i.test(String(o.where || ''));
const isAvoid = o => /avoid|overpriced/i.test(String(o.verdict || ''));
const VERDICT_RANK = v => /best value/i.test(v) ? 0 : /best quality/i.test(v) ? 1 : /budget/i.test(v) ? 2 : 3;
const UNSURE = /verify|unverified|unconfirmed|not verif|check fit/i;

const slim = (o, extra = {}) => ({
  brand: o.brand, part_number: o.part_number ?? null, tier: o.tier || null,
  price_usd: priceOf(o), price_text: o.price_usd != null && priceOf(o) == null ? String(o.price_usd) : undefined,
  where: o.where || null, verdict: o.verdict || null, warranty: o.warranty && o.warranty !== 'not checked' ? o.warranty : undefined,
  note: o.reputation || undefined,
  verify_fitment: /verify/i.test(String(o.fitment || '')) || UNSURE.test(`${o.part_number || ''} ${o.verdict || ''} ${o.where || ''}`),
  sources: (o.sources || []).filter(u => /^https?:/.test(u)),
  ...(o.added ? { added: o.added } : {}), ...extra,
});

/** One brand-research part -> alternates entry. Pure; tested in test/alternates.test.mjs. */
export function alternatesFor(b) {
  const opts = b.options || [];
  const good = opts.filter(o => !isAvoid(o));
  const picked = pickedOption(b);
  const first = good.find(o => o.tier === 'oem') || picked || good[0] || null;
  const alts = good.filter(o => o !== first)
    .sort((x, y) => (isRA(y) ? 1 : 0) - (isRA(x) ? 1 : 0) || VERDICT_RANK(x.verdict || '') - VERDICT_RANK(y.verdict || ''));
  const avoid = [
    ...opts.filter(isAvoid).map(o => ({ brand: o.brand, part_number: o.part_number ?? null, why: o.reputation || o.verdict })),
    ...(b.avoid || []).map(a => ({ brand: a.brand, part_number: null, why: a.why || '' })),
  ];
  return {
    part: b.part, category: b.category || null, pick: b.pick || null,
    first_choice: first ? slim(first, { is_oem: first.tier === 'oem', is_pick: first === picked }) : null,
    alternates: alts.map(o => slim(o, { is_pick: o === picked })),
    avoid,
    no_alternate: alts.length === 0,
    ...(b.alternates_note ? { note: b.alternates_note } : {}),   // research finding (e.g. contradictions, fitment caveats)
  };
}

/** Parts-list part (no brand research) -> entry from its part_numbers list. */
function fromPartsList(p) {
  const pns = (p.part_numbers || []).filter(x => x && x.number);
  if (!pns.length) return null;
  const row = x => ({ brand: x.brand || '?', part_number: x.number, tier: /gm|acdelco|mopar|genuine|oem/i.test(x.brand || '') ? 'oem' : null, price_usd: null, where: null, verdict: null, verify_fitment: UNSURE.test(`${x.number} ${p.notes || ''}`), sources: [] });
  const oem = pns.findIndex(x => /gm|acdelco|mopar|genuine|oem/i.test(x.brand || ''));
  const fi = oem >= 0 ? oem : 0;
  return { part: p.name, category: p.category || null, pick: null, first_choice: { ...row(pns[fi]), is_oem: oem >= 0, is_pick: false },
    alternates: pns.filter((_, i) => i !== fi).map(row), avoid: [], no_alternate: pns.length < 2, from_parts_list: true };
}

export async function alternatesForCar(env, carId) {
  const [br, pg] = await Promise.all([
    brandsForCar(env, carId),
    env.DB.prepare('SELECT data FROM parts_guides WHERE car_id = ?1').bind(carId).first(),
  ]);
  const covered = new Set(br.parts.map(b => b.matched_part).filter(Boolean));
  const list = br.parts.filter(b => (b.options || []).length || (b.avoid || []).length).map(alternatesFor);
  if (pg) for (const p of JSON.parse(pg.data).parts || []) if (!covered.has(p.name)) { const e = fromPartsList(p); if (e) list.push(e); }
  const spec = br.parts.filter(b => !(b.options || []).length && !(b.avoid || []).length).map(b => b.part);   // e.g. lug nut torque: a spec, not a part
  return {
    as_of: br.meta?.as_of || br.meta?.researched || br.meta?.compiled || null,
    parts: list, spec_only: spec,
    counts: { parts: list.length, with_alternates: list.filter(x => !x.no_alternate).length, no_alternate: list.filter(x => x.no_alternate).map(x => x.part) },
    note: 'first_choice = the OEM part when researched, else the pick. alternates are the non-avoid brands, RockAuto first. verify_fitment = not confirmed for this exact vehicle and engine: check by VIN before buying. Prices are approximate (research date).',
  };
}
