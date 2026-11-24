// Procedural motorcycles, side-by-side (UTV) and ATV for the garage turntable (three.js 0.160, no addons).
//
// Same conventions as the procedural cars in car3d.js: real metres, origin centred under the vehicle,
// front facing +x, ground at y = 0, +z is the vehicle's right side. Every builder works in its own
// "design" coordinates (x measured forward from the rear axle) and the result is centred afterwards.
// Parts are collected per material role and merged into one geometry per role, cached per spec, so an
// instance is a handful of meshes that use the app's materials (paint = the owner's colour).
// Proportions come from published dimensions (wheelbase, length, seat height, tyre sizes); nothing is
// copied from photos or anyone else's model files.

let T = null;
const D2R = Math.PI / 180;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = t => Math.max(0, Math.min(1, t));
const smooth = t => { t = clamp01(t); return t * t * (3 - 2 * t); };
const spow = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);

/** Monotone cubic through [x, y] points (same as car3d.js). */
function curve(pts) {
  const n = pts.length, xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  if (n === 1) return () => ys[0];
  const d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return x => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0; while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}
const num = v => (typeof v === 'number' ? () => v : Array.isArray(v) ? curve(v) : v);

// ---------------------------------------------------------------- transforms
const V = (x, y, z = 0) => new T.Vector3(x, y, z);
const vec = a => (a.isVector3 ? a : V(a[0], a[1], a[2] || 0));
function M({ p = [0, 0, 0], r = [0, 0, 0], s = 1, q = null, order = 'XYZ' } = {}) {
  const sc = typeof s === 'number' ? V(s, s, s) : vec(s);
  return new T.Matrix4().compose(vec(p), q || new T.Quaternion().setFromEuler(new T.Euler(r[0], r[1], r[2], order)), sc);
}
/** Matrix that puts local +y along dir (a Vector3 or [x, y, z]) at p. */
function alongY(p, dir, s = 1) {
  return M({ p, s, q: new T.Quaternion().setFromUnitVectors(V(0, 1, 0), vec(dir).clone().normalize()) });
}

// ---------------------------------------------------------------- kit: parts per material role, merged
class Kit {
  constructor() { this.parts = {}; }
  add(geo, mat, m = null, mirrorZ = false) {
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    if (m) g.applyMatrix4(m);
    (this.parts[mat] ||= []).push(g);
    if (mirrorZ) {
      const h = g.clone(); h.applyMatrix4(new T.Matrix4().makeScale(1, 1, -1));
      const p = h.attributes.position.array, n = h.attributes.normal.array;
      for (let i = 0; i < p.length; i += 9) for (const a of [p, n]) for (let k = 0; k < 3; k++) { const t = a[i + 3 + k]; a[i + 3 + k] = a[i + 6 + k]; a[i + 6 + k] = t; }
      this.parts[mat].push(h);
    }
    return this;
  }
  finish(center = true) {
    const box = new T.Box3();
    for (const list of Object.values(this.parts)) for (const g of list) { g.computeBoundingBox(); box.union(g.boundingBox); }
    const dx = center ? -(box.min.x + box.max.x) / 2 : 0;
    const geos = {}; let tris = 0;
    for (const [mat, list] of Object.entries(this.parts)) {
      const total = list.reduce((s, g) => s + g.attributes.position.array.length, 0);
      const P = new Float32Array(total), N = new Float32Array(total); let o = 0;
      for (const g of list) { P.set(g.attributes.position.array, o); N.set(g.attributes.normal.array, o); o += g.attributes.position.array.length; g.dispose(); }
      for (let i = 0; i < P.length; i += 3) P[i] += dx;
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(P, 3)); g.setAttribute('normal', new T.BufferAttribute(N, 3));
      g.computeBoundingSphere();
      geos[mat] = g; tris += P.length / 9;
    }
    return { geos, tris, size: [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z] };
  }
}

// ---------------------------------------------------------------- primitive builders (indexed, smooth normals)
function gridGeo(rows, cols, fn, wrapCols = true) {
  const pos = [], idx = [];
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) { const p = fn(i, j); pos.push(p[0], p[1], p[2]); }
  const cmax = wrapCols ? cols : cols - 1;
  for (let i = 0; i < rows - 1; i++) for (let j = 0; j < cmax; j++) {
    const j2 = (j + 1) % cols, a = i * cols + j, b = i * cols + j2, c = (i + 1) * cols + j, d = (i + 1) * cols + j2;
    idx.push(a, c, b, b, c, d);
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}

/**
 * Loft along x from x0 to x1. sec(u) -> { y, z, up, down, w, wt, wb, e }: centre, half-height above/below,
 * half-width, top/bottom width factors and superellipse exponent (2 = ellipse, higher = boxier).
 * The ends close with elliptical caps over ra / rb of the length, so the result is a closed smooth solid.
 */
function blob(x0, x1, sec, { n = 36, ring = 28, ra = 0.2, rb = 0.2 } = {}) {
  const env = u => {
    if (u < ra) return Math.sqrt(Math.max(0, 1 - ((ra - u) / ra) ** 2));
    if (u > 1 - rb) return Math.sqrt(Math.max(0, 1 - ((u - 1 + rb) / rb) ** 2));
    return 1;
  };
  return gridGeo(n + 1, ring, (i, j) => {
    const u = (1 - Math.cos(Math.PI * i / n)) / 2, x = lerp(x0, x1, u), s = sec(u, x), k = env(u);
    const e = 2 / (s.e || 2), a = (j / ring) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
    const cz = spow(c, e), sy = spow(sn, e);
    const wf = sy >= 0 ? lerp(1, s.wt ?? 1, sy) : lerp(1, s.wb ?? 1, -sy);
    return [x, (s.y || 0) + (sy >= 0 ? s.up : s.down) * k * sy, (s.z || 0) + s.w * k * cz * wf];
  });
}
/** Rounded slab centred on the origin, lx * ly * lz. */
const slab = (lx, ly, lz, e = 4, round = 0.25) => blob(-lx / 2, lx / 2, () => ({ up: ly / 2, down: ly / 2, w: lz / 2, e }), { n: 12, ring: 20, ra: round, rb: round });

/** Lathe around local +y from [r, y] pairs. */
const lathe = (prof, seg = 32) => new T.LatheGeometry(prof.map(([r, y]) => new T.Vector2(Math.max(0, r), y)), seg);

/** Cylinder between two points (open by default). */
function rod(a, b, r, seg = 8, r2 = r, open = true) {
  const A = vec(a), B = vec(b), d = B.clone().sub(A), len = d.length();
  const g = new T.CylinderGeometry(r2, r, len, seg, 1, open);
  g.applyMatrix4(alongY(A.clone().add(B).multiplyScalar(0.5), d));
  return g;
}

/**
 * Tube along a smooth curve through pts with radius r (number or fn(t)). Optional end caps (separate
 * geometry so the tube keeps smooth normals) and a slash-cut end: slash > 0 makes the top of the last
 * ring stick out further than the bottom, like a slash-cut muffler.
 */
function sweep(pts, r, { seg = 12, n = 48, closed = false, slash = 0, type = 'centripetal' } = {}) {
  const c = pts instanceof T.Curve ? pts : new T.CatmullRomCurve3(pts.map(vec), closed, type);
  const fr = c.computeFrenetFrames(n, closed), rf = num(r);
  const rings = closed ? n : n + 1, ends = [];
  const geo = gridGeo(rings, seg, (i, j) => {
    const t = i / n, P = c.getPointAt(Math.min(1, t)), N = fr.normals[i % (n + 1)], B = fr.binormals[i % (n + 1)], Tn = fr.tangents[i % (n + 1)];
    const a = (j / seg) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a), rr = rf(t);
    const d = V(N.x * ca + B.x * sa, N.y * ca + B.y * sa, N.z * ca + B.z * sa);
    const p = P.clone().addScaledVector(d, rr);
    if (slash && i === rings - 1) p.addScaledVector(Tn, (1 + d.y) * rr * slash);
    if (!closed && (i === 0 || i === rings - 1)) (ends[i === 0 ? 0 : 1] ||= []).push(p);
    return [p.x, p.y, p.z];
  });
  if (closed) {
    // gridGeo doesn't wrap rows; stitch last ring to first
    const idx = Array.from(geo.index.array), base = (rings - 1) * seg;
    for (let j = 0; j < seg; j++) { const j2 = (j + 1) % seg; idx.push(base + j, j, base + j2, base + j2, j, j2); }
    geo.setIndex(idx); geo.computeVertexNormals();
  }
  const caps = ends.map(ring => {
    const ctr = ring.reduce((s, p) => s.add(p), V(0, 0, 0)).multiplyScalar(1 / ring.length);
    const pos = [];
    for (let j = 0; j < ring.length; j++) { const a = ring[j], b = ring[(j + 1) % ring.length]; pos.push(ctr.x, ctr.y, ctr.z, a.x, a.y, a.z, b.x, b.y, b.z); }
    const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
    return g;
  });
  return { geo, caps };
}
function tube(kit, mat, pts, r, opts = {}, mirror = false, capMat = null) {
  const { geo, caps } = sweep(pts, r, opts);
  kit.add(geo, mat, opts.m || null, mirror);
  if (capMat) for (const c of caps) kit.add(c, capMat, opts.m || null, mirror);
}

/**
 * Valanced fender: a shell around an axle at (cx, cy), radius R, from angle a0 to a1 (degrees, 0 = forward,
 * 90 = up). Cross-section is a rounded U: crown across +-hw, skirts dropping depth(t) towards the axle.
 */
function fender({ cx, cy, z = 0, R, a0, a1, hw, depth, n = 44, rc = 0.04, bulge = 0.012, flare = 0 }) {
  const dF = num(depth), hF = num(hw), fl = num(flare);
  const prof = t => {
    const D = dF(t), H = hF(t), out = [];
    for (let k = 0; k <= 3; k++) out.push([lerp(-D, -rc, k / 3), -H - fl(t) * (1 - k / 3)]);
    for (let k = 1; k <= 5; k++) { const p = (k / 5) * Math.PI / 2; out.push([-rc + rc * Math.sin(p), -H + rc - rc * Math.cos(p)]); }
    for (let k = 1; k < 8; k++) { const zz = lerp(-H + rc, H - rc, k / 8); out.push([bulge * (1 - (zz / H) ** 2), zz]); }
    const half = out.length;
    for (let k = half - 1 - 7; k >= 0; k--) out.push([out[k][0], -out[k][1]]);
    return out;
  };
  const P0 = prof(0), cols = P0.length;
  return gridGeo(n + 1, cols, (i, j) => {
    const t = i / n, a = lerp(a0, a1, t) * D2R, [dr, zz] = prof(t)[j], r = R + dr;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a), z + zz];
  }, false);
}

// ---------------------------------------------------------------- wheels
/** Tyre section (r, z) around the axle: superellipse from bead to bead; e = 2 round (bike), higher = squarer. */
function tyre(R, w, rimR, e = 2, seg = 56) {
  const rm = (R + rimR) / 2, ar = (R - rimR) / 2, az = w / 2, pts = [];
  pts.push([rimR - 0.004, -az * 0.78]);
  const n = 22, lim = Math.PI / 2 + 0.55;
  for (let i = 0; i <= n; i++) {
    const a = -lim + (2 * lim * i) / n;
    pts.push([rm + ar * spow(Math.cos(a), 2 / e), az * spow(Math.sin(a), 2 / e)]);
  }
  pts.push([rimR - 0.004, az * 0.78]);
  return lathe(pts, seg).applyMatrix4(M({ r: [Math.PI / 2, 0, 0] }));
}

/** Wire-spoked motorcycle wheel with chrome rim, alloy hub and crossed spokes. */
function spokedWheel(kit, { x, y, R, w, rimR, rimW, hubR, hubW, spokes = 36, tyreMat = 'tire' }) {
  const at = M({ p: [x, y, 0] });
  kit.add(tyre(R, w, rimR), tyreMat, at);
  const h = rimW / 2;
  const rim = [[rimR + 0.014, -h], [rimR + 0.006, -h + 0.004], [rimR - 0.002, -h + 0.012], [rimR - 0.016, -0.012], [rimR - 0.016, 0.012],
    [rimR - 0.002, h - 0.012], [rimR + 0.006, h - 0.004], [rimR + 0.014, h], [rimR - 0.004, h + 0.002], [rimR - 0.024, h - 0.01], [rimR - 0.026, 0],
    [rimR - 0.024, -h + 0.01], [rimR - 0.004, -h - 0.002], [rimR + 0.014, -h]];
  kit.add(lathe(rim, 56), 'chromeV', M({ p: [x, y, 0], r: [Math.PI / 2, 0, 0] }));
  const hh = hubW / 2;
  const hub = [[0.016, -hh - 0.01], [0.03, -hh - 0.008], [0.035, -hh], [hubR, -hh + 0.004], [hubR, -hh + 0.014], [hubR * 0.72, -hh + 0.02],
    [hubR * 0.62, 0], [hubR * 0.72, hh - 0.02], [hubR, hh - 0.014], [hubR, hh - 0.004], [0.035, hh], [0.03, hh + 0.008], [0.016, hh + 0.01]];
  kit.add(lathe(hub, 28), 'alloy', M({ p: [x, y, 0], r: [Math.PI / 2, 0, 0] }));
  for (let i = 0; i < spokes; i++) {
    const side = i % 2 ? 1 : -1, a = (i / spokes) * Math.PI * 2, lead = (i % 4 < 2 ? 1 : -1) * 0.42;
    const hp = [x + Math.cos(a) * hubR * 0.92, y + Math.sin(a) * hubR * 0.92, side * (hh - 0.009)];
    const rp = [x + Math.cos(a + lead) * (rimR - 0.018), y + Math.sin(a + lead) * (rimR - 0.018), side * 0.006];
    kit.add(rod(hp, rp, 0.0024, 4), 'chromeV');
  }
  for (const s of [-1, 1]) kit.add(new T.CylinderGeometry(0.016, 0.016, 0.02, 6), 'chromeV', M({ p: [x, y, s * (hh + 0.02)], r: [Math.PI / 2, 0, 0] }));
}

/** Off-road wheel: knobby tyre (carcass + lugs), cast beadlock rim. side = +1 right / -1 left (face outward). */
function knobbyWheel(kit, { x, y, z, R, w, rimR, rimW, lugs = 22, spokes = 6 }) {
  const side = Math.sign(z) || 1, Rc = R - 0.024;
  kit.add(tyre(Rc, w, rimR, 3.2, 48), 'tire', M({ p: [x, y, z] }));
  const lugBox = new T.BoxGeometry(0.03, 0.05, 0.075), shBox = new T.BoxGeometry(0.03, 0.05, 0.06);
  for (let i = 0; i < lugs; i++) {
    const a = (i / lugs) * Math.PI * 2;
    for (const [zz, off] of [[-w * 0.2, 0], [w * 0.2, 0.5]]) {
      const aa = a + (off * Math.PI * 2) / lugs;
      kit.add(lugBox, 'tire', M({ p: [x + Math.cos(aa) * (Rc + 0.008), y + Math.sin(aa) * (Rc + 0.008), z + zz], r: [0, 0, aa] }));
    }
    for (const sd of [-1, 1]) {
      const aa = a + ((sd > 0 ? 0.5 : 0) * Math.PI * 2) / lugs, rr = Rc - 0.016;
      kit.add(shBox, 'tire', M({ p: [x + Math.cos(aa) * rr, y + Math.sin(aa) * rr, z + sd * w * 0.43], r: [0, -sd * 0.75, aa], order: 'ZYX' }));
    }
  }
  const h = rimW / 2;
  const rim = [[rimR + 0.012, -h], [rimR + 0.004, -h + 0.008], [rimR - 0.004, -h + 0.014], [rimR - 0.004, h - 0.014], [rimR + 0.004, h - 0.008],
    [rimR + 0.012, h], [rimR - 0.012, h - 0.004], [rimR - 0.014, -h + 0.004], [rimR + 0.012, -h]];
  kit.add(lathe(rim, 40), 'rimDark', M({ p: [x, y, z], r: [Math.PI / 2, 0, 0] }));
  const fz = z + side * (h - 0.03);
  // beadlock ring + bolts on the outer lip
  const ring = [[rimR - 0.014, -0.007], [rimR + 0.016, -0.007], [rimR + 0.018, 0.0], [rimR + 0.016, 0.007], [rimR - 0.014, 0.007], [rimR - 0.014, -0.007]];
  kit.add(lathe(ring, 40), 'alloy', M({ p: [x, y, z + side * (h + 0.002)], r: [Math.PI / 2, 0, 0] }));
  const bolt = new T.CylinderGeometry(0.0065, 0.0065, 0.012, 6);
  for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; kit.add(bolt, 'chromeV', M({ p: [x + Math.cos(a) * (rimR + 0.002), y + Math.sin(a) * (rimR + 0.002), z + side * (h + 0.01)], r: [Math.PI / 2, 0, 0] })); }
  // cast spokes and centre
  const sp = slab(rimR - 0.04, 0.042, 0.03, 3, 0.2);
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2 + 0.3, rr = (rimR + 0.03) / 2;
    kit.add(sp, 'rimDark', M({ p: [x + Math.cos(a) * rr, y + Math.sin(a) * rr, fz], r: [0, 0, a] }));
  }
  kit.add(lathe([[0, 0.03], [0.04, 0.028], [0.058, 0.012], [0.062, -0.02], [0.03, -0.03]], 24), 'rimDark', M({ p: [x, y, fz], r: [side * Math.PI / 2, 0, 0] }));
  kit.add(new T.CylinderGeometry(rimR - 0.01, rimR - 0.01, 0.006, 32), 'under', M({ p: [x, y, z - side * h * 0.4], r: [Math.PI / 2, 0, 0] }));
  for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + 0.4; kit.add(bolt, 'chromeV', M({ p: [x + Math.cos(a) * 0.04, y + Math.sin(a) * 0.04, fz + side * 0.03], r: [Math.PI / 2, 0, 0] })); }
}

// ---------------------------------------------------------------- suspension bits
function coilover(kit, a, b, { body = 0.024, spring = 0.042, coils = 7, wire = 0.0075, springMat = 'spring', bodyMat = 'alloy' } = {}) {
  const A = vec(a), B = vec(b), d = B.clone().sub(A), len = d.length();
  const m = alongY(A, d);
  kit.add(rod([0, 0], [0, len * 0.58], body, 14, body, false), bodyMat, m);
  kit.add(rod([0, len * 0.55], [0, len], body * 0.4, 8), 'chromeV', m);
  kit.add(lathe([[0, -0.012], [body * 1.2, -0.01], [body * 1.2, 0.012], [0, 0.014]], 12), 'frame', m);
  kit.add(lathe([[0, len - 0.014], [body * 1.2, len - 0.012], [body * 1.2, len + 0.01], [0, len + 0.012]], 12), 'frame', m);
  const pts = [], y0 = len * 0.12, y1 = len * 0.86, k = coils * 14;
  for (let i = 0; i <= k; i++) { const t = i / k, a2 = t * coils * Math.PI * 2; pts.push(V(Math.cos(a2) * spring, lerp(y0, y1, t), Math.sin(a2) * spring)); }
  tube(kit, springMat, pts, wire, { seg: 6, n: k, m, type: 'catmullrom' });
}
function aArm(kit, mat, p1, p2, ball, r = 0.016) {
  kit.add(rod(p1, ball, r, 8), mat); kit.add(rod(p2, ball, r, 8), mat);
  kit.add(rod(lerp3(p1, ball, 0.55), lerp3(p2, ball, 0.55), r * 0.8, 6), mat);
  kit.add(new T.SphereGeometry(r * 1.6, 10, 8), 'alloy', M({ p: ball }));
}
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2] || 0, b[2] || 0, t)];

// ================================================================ CRUISER
// 2007 Yamaha V Star 650 Classic-ish: wheelbase 1625 mm, length ~2450, seat 695 mm, rake 32 deg,
// 130/90-16 front on a 16" wire wheel, 170/80-15 rear on a 15", 70-degree air-cooled V-twin, shaft drive (left).
function buildCruiser() {
  const kit = new Kit();
  const FA = [1.625, 0.32], RA = [0, 0.3265];
  const rake = 32 * D2R, fd = [-Math.sin(rake), Math.cos(rake)], bk = [-Math.cos(rake), -Math.sin(rake)];
  const fp = (s, z = 0) => [FA[0] + fd[0] * s, FA[1] + fd[1] * s, z];
  const hp = (s, z = 0) => [FA[0] + fd[0] * s + bk[0] * 0.05, FA[1] + fd[1] * s + bk[1] * 0.05, z];
  const forkQ = new T.Quaternion().setFromUnitVectors(V(0, 1, 0), V(fd[0], fd[1], 0));
  const onFork = (s, z, sc = 1) => M({ p: fp(s, z), q: forkQ, s: sc });

  // wheels
  spokedWheel(kit, { x: FA[0], y: FA[1], R: 0.32, w: 0.13, rimR: 0.203, rimW: 0.078, hubR: 0.052, hubW: 0.11 });
  spokedWheel(kit, { x: RA[0], y: RA[1], R: 0.3265, w: 0.17, rimR: 0.1905, rimW: 0.104, hubR: 0.07, hubW: 0.13, spokes: 40 });
  // front disc + caliper (right side)
  kit.add(lathe([[0.06, -0.003], [0.138, -0.003], [0.138, 0.003], [0.06, 0.003], [0.06, -0.003]], 40), 'alloy', M({ p: [FA[0], FA[1], 0.077], r: [Math.PI / 2, 0, 0] }));
  kit.add(slab(0.08, 0.05, 0.04, 3), 'alloy', M({ p: [FA[0] - 0.07, FA[1] + 0.105, 0.086], r: [0, 0, 0.5] }));

  // forks: alloy sliders, chrome stanchions, chrome covers on the upper tubes
  for (const z of [-0.118, 0.118]) {
    kit.add(lathe([[0, -0.07], [0.02, -0.068], [0.03, -0.05], [0.031, 0.0], [0.03, 0.27], [0.027, 0.3], [0.02, 0.302], [0, 0.302]], 18), 'alloy', onFork(0, z));
    kit.add(rod([0, 0.29], [0, 0.5], 0.0205, 14), 'chromeV', onFork(0, z));
    kit.add(lathe([[0, 0.47], [0.03, 0.47], [0.037, 0.49], [0.037, 0.79], [0.03, 0.8], [0, 0.8]], 20), 'chromeV', onFork(0, z));
  }
  kit.add(rod([FA[0], FA[1], -0.15], [FA[0], FA[1], 0.15], 0.011, 8), 'alloy');
  // triple clamps + steering head
  for (const [s, mat] of [[0.56, 'frame'], [0.8, 'chromeV']]) {
    const c = lerp3(fp(s), hp(s), 0.45);
    kit.add(slab(0.1, 0.034, 0.32, 3, 0.35), mat, M({ p: c, q: forkQ.clone().multiply(new T.Quaternion().setFromEuler(new T.Euler(0, 0, Math.PI / 2))) }));
  }
  kit.add(rod(hp(0.5), hp(0.86), 0.032, 14), 'frame');

  // headlight: chrome bucket, lens, trim ring; brackets to the forks
  const HL = [1.31, 0.905, 0], hlM = M({ p: HL, r: [0, 0, -Math.PI / 2] });
  kit.add(lathe([[0, -0.005], [0.035, 0], [0.066, 0.02], [0.086, 0.05], [0.093, 0.085], [0.094, 0.108], [0.088, 0.112]], 36), 'chromeV', hlM);
  kit.add(lathe([[0.089, 0.108], [0.075, 0.118], [0.045, 0.125], [0, 0.128]], 36), 'head', hlM);
  kit.add(new T.TorusGeometry(0.091, 0.006, 8, 40), 'chromeV', M({ p: [HL[0] + 0.111, HL[1], 0], r: [0, Math.PI / 2, 0] }));
  for (const s of [-1, 1]) kit.add(rod([HL[0] + 0.05, HL[1], s * 0.085], [fp(0.63)[0] + 0.01, fp(0.63)[1], s * 0.118], 0.009, 8), 'chromeV');
  // front turn signals on stalks
  for (const s of [-1, 1]) {
    kit.add(rod([fp(0.52)[0], fp(0.52)[1], s * 0.15], [1.33, 0.80, s * 0.21], 0.008, 6), 'chromeV');
    kit.add(blob(1.30, 1.40, () => ({ y: 0.80, z: s * 0.215, up: 0.026, down: 0.026, w: 0.026 }), { n: 14, ring: 16, ra: 0.45, rb: 0.2 }), 'chromeV');
    kit.add(blob(1.385, 1.42, () => ({ y: 0.80, z: s * 0.215, up: 0.022, down: 0.022, w: 0.022 }), { n: 8, ring: 16, ra: 0.05, rb: 0.9 }), 'amber');
  }

  // handlebars: risers, wide pull-back bar, grips, levers, mirrors
  for (const s of [-1, 1]) kit.add(rod([1.19, 1.0, s * 0.05], [1.18, 1.085, s * 0.05], 0.016, 10, 0.016, false), 'chromeV');
  const bar = [[0.93, 1.10, -0.43], [0.945, 1.10, -0.305], [1.04, 1.105, -0.23], [1.15, 1.092, -0.11], [1.18, 1.088, 0], [1.15, 1.092, 0.11], [1.04, 1.105, 0.23], [0.945, 1.10, 0.305], [0.93, 1.10, 0.43]];
  tube(kit, 'chromeV', bar, 0.0127, { n: 80, seg: 10 });
  kit.add(rod([0.9445, 1.10, 0.31], [0.9305, 1.10, 0.43], 0.0185, 12, 0.0185, false), 'rubber', null, true);
  kit.add(blob(0.93, 0.98, () => ({ y: 1.10, z: 0.29, up: 0.024, down: 0.022, w: 0.022, e: 2.6 }), { n: 8, ring: 16, ra: 0.3, rb: 0.3 }), 'black', null, true);
  for (const s of [-1, 1]) kit.add(rod([0.975, 1.105, s * 0.29], [0.985, 1.09, s * 0.42], 0.0055, 6), 'alloy');
  for (const s of [-1, 1]) {
    kit.add(rod([0.975, 1.11, s * 0.25], [0.962, 1.205, s * 0.295], 0.0065, 6), 'chromeV');
    const mm = M({ p: [0.958, 1.235, s * 0.30], r: [0, 0, Math.PI / 2] });
    kit.add(lathe([[0, -0.012], [0.04, -0.01], [0.055, 0.0], [0.056, 0.006], [0, 0.008]], 24), 'chromeV', mm);
    kit.add(new T.CircleGeometry(0.05, 24), 'glass', M({ p: [0.95, 1.235, s * 0.30], r: [0, -Math.PI / 2, 0] }));
  }

  // tank: teardrop loft with a chrome console + speedo on top
  const tTop = curve([[0.70, 0.82], [0.80, 0.93], [0.95, 0.995], [1.10, 1.005], [1.20, 0.985], [1.27, 0.94]]);
  const tBot = curve([[0.70, 0.80], [1.0, 0.795], [1.27, 0.83]]);
  const tW = curve([[0.70, 0.09], [0.82, 0.135], [1.0, 0.165], [1.15, 0.158], [1.27, 0.115]]);
  kit.add(blob(0.70, 1.27, (u, x) => ({ y: (tTop(x) + tBot(x)) / 2, up: (tTop(x) - tBot(x)) / 2, down: (tTop(x) - tBot(x)) / 2, w: tW(x), wt: 0.78, wb: 0.86, e: 2.3 }), { n: 44, ring: 40, ra: 0.3, rb: 0.13 }), 'paint');
  kit.add(blob(0.86, 1.13, (u, x) => ({ y: tTop(x) + 0.004, up: 0.012, down: 0.014, w: 0.034, e: 3 }), { n: 18, ring: 16, ra: 0.25, rb: 0.2 }), 'chromeV');
  const spM = M({ p: [1.12, tTop(1.12) + 0.012, 0], r: [0, 0, 0.35] });
  kit.add(lathe([[0, -0.01], [0.042, -0.006], [0.048, 0.018], [0.046, 0.024], [0, 0.022]], 28), 'chromeV', spM);
  kit.add(new T.CircleGeometry(0.04, 28), 'glass', M({ p: [1.12 - 0.008, tTop(1.12) + 0.034, 0], r: [-Math.PI / 2, 0, 0.35], order: 'ZYX' }));
  kit.add(new T.CylinderGeometry(0.012, 0.012, 0.02, 12), 'chromeV', M({ p: [1.03, tTop(1.03) + 0.018, 0] }));

  // seats: rider bucket + raised pillion (leather), welt
  const sTop = curve([[0.30, 0.80], [0.37, 0.76], [0.47, 0.716], [0.60, 0.716], [0.72, 0.775], [0.81, 0.84]]);
  const sBot = curve([[0.30, 0.66], [0.50, 0.635], [0.70, 0.72], [0.81, 0.81]]);
  const sW = curve([[0.30, 0.15], [0.42, 0.195], [0.56, 0.19], [0.70, 0.12], [0.81, 0.06]]);
  kit.add(blob(0.30, 0.82, (u, x) => ({ y: (sTop(x) + sBot(x)) / 2, up: (sTop(x) - sBot(x)) / 2, down: (sTop(x) - sBot(x)) / 2, w: sW(x), wt: 0.9, wb: 0.92, e: 3.2 }), { n: 36, ring: 36, ra: 0.08, rb: 0.16 }), 'leather');
  const pTop = curve([[-0.13, 0.765], [-0.03, 0.80], [0.15, 0.812], [0.34, 0.80]]);
  const pW = curve([[-0.13, 0.10], [0.05, 0.135], [0.34, 0.14]]);
  kit.add(blob(-0.13, 0.35, (u, x) => ({ y: (pTop(x) + 0.70) / 2, up: (pTop(x) - 0.70) / 2, down: (pTop(x) - 0.70) / 2, w: pW(x), wt: 0.88, e: 3.2 }), { n: 28, ring: 32, ra: 0.16, rb: 0.08 }), 'leather');

  // fenders: deep valanced, rear one long over the 170 tyre
  kit.add(fender({ cx: RA[0], cy: RA[1], R: 0.385, a0: 58, a1: 198, hw: 0.128, depth: t => lerp(0.05, 0.165, smooth(t * 1.6)), bulge: 0.014, rc: 0.05 }), 'paint');
  kit.add(fender({ cx: FA[0], cy: FA[1], R: 0.356, a0: 8, a1: 150, hw: 0.086, depth: t => lerp(0.15, 0.05, smooth(t)), bulge: 0.01, rc: 0.035 }), 'paint');
  // fender trim strip (chrome) along the rear crown
  kit.add(fender({ cx: RA[0], cy: RA[1], R: 0.3995, a0: 70, a1: 185, hw: 0.012, depth: 0.004, rc: 0.006, bulge: 0.003, n: 40 }), 'chromeV');

  // V-twin: crankcase, gearbox, two finned cylinders at 70 deg, chrome rocker covers, side covers, air cleaner
  const C = [0.95, 0.35];
  kit.add(blob(0.66, 1.17, () => ({ y: 0.33, up: 0.12, down: 0.15, w: 0.112, e: 2.6 }), { n: 24, ring: 28, ra: 0.25, rb: 0.3 }), 'engine');
  kit.add(blob(0.50, 0.80, () => ({ y: 0.37, up: 0.09, down: 0.1, w: 0.092, e: 2.6 }), { n: 16, ring: 24, ra: 0.3, rb: 0.3 }), 'engine');
  const fin = [[0, 0.1], [0.055, 0.1]];
  for (let k = 0; k < 10; k++) {
    const y0 = 0.112 + k * 0.022, rf = k < 6 ? 0.082 : 0.091;
    fin.push([0.058, y0], [rf, y0 + 0.003], [rf, y0 + 0.009], [0.058, y0 + 0.012]);
  }
  fin.push([0.072, 0.334], [0.072, 0.34]);
  const cylGeo = lathe(fin, 28);
  const rock = lathe([[0.071, 0.336], [0.074, 0.35], [0.064, 0.372], [0.036, 0.386], [0, 0.389]], 28);
  for (const s of [1, -1]) {
    const dir = [s * Math.sin(35 * D2R), Math.cos(35 * D2R), 0];
    const m = alongY([C[0], C[1], s * 0.012], dir);
    kit.add(cylGeo, 'alloy', m); kit.add(rock, 'chromeV', m);
  }
  kit.add(lathe([[0, 0.032], [0.05, 0.03], [0.085, 0.018], [0.094, 0.0], [0.07, -0.006], [0, -0.006]], 32), 'alloy', M({ p: [0.97, 0.32, -0.108], r: [-Math.PI / 2, 0, 0] }));
  kit.add(lathe([[0, 0.03], [0.06, 0.028], [0.095, 0.016], [0.104, 0.0], [0.08, -0.006], [0, -0.006]], 32), 'alloy', M({ p: [0.86, 0.31, 0.108], r: [Math.PI / 2, 0, 0], s: [1.15, 1, 1] }));
  kit.add(blob(0.84, 1.07, u => ({ y: 0.585, z: 0.105, up: 0.07, down: 0.07, w: 0.03, wt: 0.8, e: 2.2 }), { n: 18, ring: 24, ra: 0.42, rb: 0.42 }), 'chromeV');

  // exhaust (right side): staggered chrome pipes with slash-cut tips
  const lowPipe = [[1.165, 0.56, 0.02], [1.24, 0.50, 0.08], [1.25, 0.35, 0.15], [1.15, 0.225, 0.195], [0.95, 0.195, 0.218], [0.6, 0.205, 0.226], [0.2, 0.235, 0.226], [-0.12, 0.258, 0.226], [-0.25, 0.266, 0.226]];
  const hiPipe = [[0.735, 0.56, 0.03], [0.66, 0.53, 0.1], [0.56, 0.47, 0.175], [0.40, 0.425, 0.215], [0.1, 0.395, 0.226], [-0.18, 0.392, 0.226], [-0.31, 0.398, 0.226]];
  const pipeR = (x0, x1) => (t, P) => 0.022 + 0.018 * smooth((x0 - P.x) / (x0 - x1));
  for (const [pts, x0, x1] of [[lowPipe, 0.55, 0.32], [hiPipe, 0.46, 0.22]]) {
    const c = new T.CatmullRomCurve3(pts.map(vec), false, 'centripetal');
    const r = pipeR(x0, x1);
    tube(kit, 'chromeV', c, t => r(t, c.getPointAt(t)), { n: 90, seg: 18, slash: 1.1 }, false, 'under');
  }
  kit.add(blob(0.56, 1.0, (u, x) => ({ y: lerp(0.212, 0.198, u), z: 0.222, up: 0.028, down: 0.026, w: 0.026, e: 2.4 }), { n: 14, ring: 16, ra: 0.2, rb: 0.2 }), 'chromeV');

  // frame: backbone, seat rails, pivot drops, double cradle downtubes
  tube(kit, 'frame', [hp(0.8), [1.08, 0.88, 0], [0.88, 0.81, 0], [0.70, 0.75, 0]], 0.024, { n: 24, seg: 12 });
  tube(kit, 'frame', [[0.72, 0.755, 0.0], [0.62, 0.72, 0.07], [0.40, 0.665, 0.09], [0.10, 0.66, 0.09], [-0.12, 0.69, 0.09]], 0.018, { n: 24, seg: 10 }, true);
  tube(kit, 'frame', [[0.66, 0.735, 0.06], [0.575, 0.62, 0.09], [0.545, 0.5, 0.09], [0.54, 0.37, 0.09]], 0.021, { n: 18, seg: 10 }, true);
  tube(kit, 'frame', [hp(0.53, 0.02), [1.295, 0.66, 0.06], [1.275, 0.45, 0.08], [1.225, 0.26, 0.085], [1.12, 0.168, 0.085], [0.85, 0.155, 0.085], [0.62, 0.19, 0.088], [0.55, 0.30, 0.09], [0.54, 0.37, 0.09]], 0.021, { n: 60, seg: 10 }, true);

  // swingarm (right) and shaft-drive housing (left) with the final-drive case on the hub
  tube(kit, 'frame', [[0.54, 0.40, 0.095], [0.30, 0.37, 0.10], [0.02, 0.3265, 0.10]], 0.027, { n: 16, seg: 12 });
  tube(kit, 'engine', [[0.54, 0.40, -0.095], [0.30, 0.37, -0.105], [0.06, 0.332, -0.11]], t => lerp(0.032, 0.044, t), { n: 16, seg: 16 });
  kit.add(lathe([[0, -0.02], [0.05, -0.018], [0.05, 0.03], [0.0, 0.032]], 16), 'rubber', alongY([0.54, 0.40, -0.095], [-1, -0.06, -0.04]));
  kit.add(lathe([[0, 0], [0.06, 0.002], [0.088, 0.016], [0.094, 0.034], [0.082, 0.056], [0.05, 0.068], [0, 0.07]], 32), 'alloy', M({ p: [RA[0], RA[1], -0.07], r: [-Math.PI / 2, 0, 0] }));
  kit.add(blob(0.0, 0.13, () => ({ y: 0.33, z: -0.11, up: 0.055, down: 0.05, w: 0.04 }), { n: 12, ring: 18, ra: 0.3, rb: 0.3 }), 'alloy');
  kit.add(rod([0.54, 0.40, -0.13], [0.54, 0.40, 0.13], 0.018, 10, 0.018, false), 'alloy');

  // floorboards (rubber on chrome trim) + brackets, brake pedal, heel-toe shifter
  for (const s of [-1, 1]) {
    kit.add(blob(0.98, 1.30, () => ({ y: 0.305, z: s * 0.30, up: 0.016, down: 0.01, w: 0.066, e: 5 }), { n: 16, ring: 24, ra: 0.12, rb: 0.12 }), 'rubber');
    kit.add(blob(0.97, 1.31, () => ({ y: 0.292, z: s * 0.30, up: 0.006, down: 0.008, w: 0.072, e: 5 }), { n: 16, ring: 24, ra: 0.1, rb: 0.1 }), 'chromeV');
    kit.add(rod([1.12, 0.20, s * 0.09], [1.12, 0.29, s * 0.25], 0.012, 8), 'frame');
  }
  tube(kit, 'chromeV', [[1.02, 0.27, 0.2], [1.18, 0.31, 0.24], [1.32, 0.36, 0.24]], 0.009, { n: 12, seg: 8 });
  kit.add(slab(0.07, 0.012, 0.06, 4), 'rubber', M({ p: [1.33, 0.367, 0.24], r: [0, 0, 0.3] }));
  tube(kit, 'chromeV', [[0.86, 0.33, -0.14], [1.0, 0.33, -0.22], [1.3, 0.37, -0.24]], 0.008, { n: 12, seg: 8 });
  kit.add(rod([1.28, 0.38, -0.21], [1.28, 0.38, -0.29], 0.011, 8), 'rubber');
  kit.add(rod([0.98, 0.37, -0.21], [0.98, 0.37, -0.28], 0.011, 8), 'rubber');

  // passenger pegs, side covers
  for (const s of [-1, 1]) {
    kit.add(rod([0.38, 0.60, s * 0.095], [0.30, 0.50, s * 0.17], 0.011, 8), 'frame');
    kit.add(rod([0.30, 0.50, s * 0.165], [0.30, 0.50, s * 0.27], 0.014, 10), 'rubber');
    const scT = curve([[0.46, 0.625], [0.60, 0.635], [0.74, 0.70]]), scB = curve([[0.46, 0.555], [0.74, 0.50]]);
    kit.add(blob(0.46, 0.75, (u, x) => ({ y: (scT(x) + scB(x)) / 2, z: s * 0.108, up: (scT(x) - scB(x)) / 2, down: (scT(x) - scB(x)) / 2, w: 0.012, wt: 0.6, wb: 0.6, e: 5 }), { n: 16, ring: 24, ra: 0.1, rb: 0.12 }), 'paint');
  }

  // tail: lamp on the fender, plate, rear turn signals
  const ta = 140 * D2R, tx = RA[0] + 0.395 * Math.cos(ta), ty = RA[1] + 0.395 * Math.sin(ta);
  const tM = M({ p: [tx, ty, 0], r: [0, 0, ta - Math.PI / 2] });
  kit.add(blob(-0.06, 0.06, () => ({ y: 0.018, up: 0.028, down: 0.018, w: 0.05, e: 2.4 }), { n: 14, ring: 20, ra: 0.3, rb: 0.3 }), 'chromeV', tM);
  kit.add(blob(-0.075, -0.02, () => ({ y: 0.02, up: 0.022, down: 0.014, w: 0.042, e: 2.4 }), { n: 10, ring: 20, ra: 0.6, rb: 0.2 }), 'tail', tM);
  kit.add(new T.BoxGeometry(0.004, 0.105, 0.18), 'plate', M({ p: [-0.425, 0.46, 0], r: [0, 0, -0.18] }));
  kit.add(new T.BoxGeometry(0.008, 0.115, 0.19), 'black', M({ p: [-0.42, 0.46, 0], r: [0, 0, -0.18] }));
  kit.add(rod([-0.36, 0.53, 0], [-0.415, 0.5, 0], 0.01, 6), 'black');
  for (const s of [-1, 1]) {
    kit.add(rod([-0.24, 0.56, s * 0.12], [-0.27, 0.56, s * 0.19], 0.007, 6), 'chromeV');
    kit.add(blob(-0.33, -0.23, () => ({ y: 0.56, z: s * 0.2, up: 0.024, down: 0.024, w: 0.024 }), { n: 12, ring: 16, ra: 0.2, rb: 0.45 }), 'chromeV');
    kit.add(blob(-0.35, -0.31, () => ({ y: 0.56, z: s * 0.2, up: 0.02, down: 0.02, w: 0.02 }), { n: 8, ring: 16, ra: 0.9, rb: 0.05 }), 'amber');
  }

  // side stand (left), long enough to meet the ground at the lean angle
  const lean = CRUISER.lean, fz = -0.36, fy = -fz * Math.tan(lean) + 0.006;
  kit.add(rod([0.80, 0.21, -0.12], [0.62, fy + 0.012, fz], 0.013, 8, 0.011), 'frame');
  kit.add(slab(0.07, 0.012, 0.045, 4), 'frame', M({ p: [0.615, fy, fz], r: [lean, 0, 0] }));
  return kit.finish();
}

// ================================================================ UTV
// Polaris RZR XP 1000-ish: L ~3.0 m, W 1.63, H 1.9, wheelbase 2.29, 29-30" knobby tyres on 14" beadlocks.
function buildUtv() {
  const kit = new Kit();
  const WB = 2.29, R = 0.37, TZ = 0.69;
  for (const x of [0, WB]) for (const s of [-1, 1]) knobbyWheel(kit, { x, y: R, z: s * TZ, R, w: 0.245, rimR: 0.178, rimW: 0.19, lugs: 24, spokes: 6 });

  // floor pan / skid
  kit.add(blob(0.05, 2.45, () => ({ y: 0.43, up: 0.055, down: 0.06, w: 0.5, e: 5 }), { n: 16, ring: 28, ra: 0.06, rb: 0.08 }), 'under');
  // nose / hood (owner colour)
  const nT = curve([[1.68, 0.99], [2.05, 0.94], [2.42, 0.85], [2.64, 0.76], [2.72, 0.70]]);
  const nB = curve([[1.68, 0.64], [2.45, 0.65], [2.72, 0.62]]);
  const nW = curve([[1.68, 0.54], [2.2, 0.52], [2.5, 0.42], [2.72, 0.28]]);
  kit.add(blob(1.66, 2.73, (u, x) => ({ y: (nT(x) + nB(x)) / 2, up: (nT(x) - nB(x)) / 2, down: (nT(x) - nB(x)) / 2, w: nW(x), wt: 0.86, wb: 0.8, e: 4 }), { n: 32, ring: 36, ra: 0.03, rb: 0.1 }), 'paint');
  kit.add(blob(2.0, 2.64, (u, x) => ({ y: nT(x) + 0.004, up: 0.01, down: 0.02, w: lerp(0.12, 0.05, u), e: 3 }), { n: 16, ring: 16, ra: 0.3, rb: 0.3 }), 'plastic');
  // front grille, headlights, bumper
  kit.add(blob(2.64, 2.74, () => ({ y: 0.645, up: 0.035, down: 0.03, w: 0.2, e: 4 }), { n: 8, ring: 20, ra: 0.3, rb: 0.3 }), 'plastic');
  for (const s of [-1, 1]) {
    kit.add(blob(2.54, 2.69, u => ({ y: 0.76 - u * 0.045, z: s * lerp(0.31, 0.22, u), up: 0.014, down: 0.012, w: 0.06, wt: 0.9, e: 3 }), { n: 10, ring: 16, ra: 0.2, rb: 0.4 }), 'head');
  }
  tube(kit, 'frame', [[2.56, 0.50, -0.36], [2.73, 0.53, -0.28], [2.77, 0.54, 0], [2.73, 0.53, 0.28], [2.56, 0.50, 0.36]], 0.024, { n: 40, seg: 10 });
  kit.add(rod([2.75, 0.54, -0.18], [2.68, 0.66, -0.17], 0.018, 8), 'frame', null, true);

  // fenders (owner colour): wide, shallow, flared
  for (const s of [-1, 1]) {
    kit.add(fender({ cx: WB, cy: R, z: s * 0.665, R: 0.475, a0: 22, a1: 150, hw: 0.19, depth: 0.035, bulge: 0.008, rc: 0.025 }), 'paint');
    kit.add(fender({ cx: 0, cy: R, z: s * 0.665, R: 0.475, a0: 28, a1: 142, hw: 0.19, depth: 0.035, bulge: 0.008, rc: 0.025 }), 'paint');
    // half door (owner colour) with black lower
    const dT = curve([[0.88, 0.98], [1.2, 0.90], [1.55, 0.92], [1.72, 1.0]]);
    kit.add(blob(0.86, 1.74, (u, x) => ({ y: (dT(x) + 0.58) / 2, z: s * 0.665, up: (dT(x) - 0.58) / 2, down: (dT(x) - 0.58) / 2, w: 0.016, e: 6 }), { n: 24, ring: 20, ra: 0.04, rb: 0.04 }), 'paint');
    kit.add(blob(0.70, 1.86, () => ({ y: 0.52, z: s * 0.68, up: 0.065, down: 0.05, w: 0.035, e: 5 }), { n: 18, ring: 20, ra: 0.06, rb: 0.06 }), 'plastic');
    // panel behind the front wheel, from the fender wing down to the door line
    kit.add(blob(1.70, 1.93, (u, x) => ({ y: 0.80, z: s * 0.62, up: lerp(0.15, 0.08, u), down: 0.16, w: 0.05, wt: 0.7, e: 4 }), { n: 12, ring: 20, ra: 0.1, rb: 0.2 }), 'paint');
    // rear side panel (owner colour) between B-pillar and rear fender
    kit.add(blob(0.40, 0.86, (u, x) => ({ y: 0.80, z: s * 0.6, up: 0.12, down: 0.14, w: 0.03, e: 5 }), { n: 16, ring: 20, ra: 0.06, rb: 0.06 }), 'paint');
  }
  // dash + cowl
  kit.add(blob(1.50, 1.80, () => ({ y: 0.97, up: 0.09, down: 0.13, w: 0.6, e: 4 }), { n: 12, ring: 28, ra: 0.2, rb: 0.2 }), 'plastic');
  // rear bed over the engine, firewall behind the seats, taillights, exhaust tip
  kit.add(blob(-0.25, 0.80, () => ({ y: 0.90, up: 0.05, down: 0.05, w: 0.56, e: 6 }), { n: 16, ring: 28, ra: 0.03, rb: 0.03 }), 'plastic');
  for (const s of [-1, 1]) kit.add(rod([-0.24, 0.98, s * 0.53], [0.78, 0.98, s * 0.53], 0.018, 8), 'frame');
  kit.add(rod([-0.24, 0.98, -0.53], [-0.24, 0.98, 0.53], 0.018, 8), 'frame');
  kit.add(blob(-0.20, 0.70, () => ({ y: 0.66, up: 0.18, down: 0.16, w: 0.38, e: 3 }), { n: 16, ring: 24, ra: 0.2, rb: 0.2 }), 'engine');
  kit.add(blob(0.78, 0.86, () => ({ y: 1.05, up: 0.35, down: 0.35, w: 0.6, e: 6 }), { n: 6, ring: 28, ra: 0.3, rb: 0.3 }), 'plastic');
  for (const s of [-1, 1]) kit.add(blob(-0.27, -0.2, () => ({ y: 0.86, z: s * 0.44, up: 0.03, down: 0.03, w: 0.06, e: 4 }), { n: 6, ring: 16, ra: 0.4, rb: 0.4 }), 'tail');
  kit.add(rod([0.1, 0.62, 0.22], [-0.28, 0.66, 0.22], 0.045, 16, 0.045, false), 'alloy');
  kit.add(new T.CircleGeometry(0.04, 16), 'under', M({ p: [-0.282, 0.66, 0.22], r: [0, -Math.PI / 2, 0] }));

  // bucket seats + steering wheel (driver on the left)
  for (const s of [-1, 1]) {
    const z = s * 0.32;
    kit.add(blob(0.86, 1.40, u => ({ y: 0.66, z, up: 0.07, down: 0.06, w: 0.24, wt: 0.85, e: 3.2 }), { n: 16, ring: 28, ra: 0.25, rb: 0.3 }), 'leather');
    for (const b of [-1, 1]) kit.add(blob(0.92, 1.38, () => ({ y: 0.72, z: z + b * 0.2, up: 0.05, down: 0.04, w: 0.05 }), { n: 12, ring: 16, ra: 0.3, rb: 0.3 }), 'leather');
    const bw = curve([[0, 0.23], [0.4, 0.235], [0.66, 0.2], [0.74, 0.12], [0.84, 0.13], [0.96, 0.11]]);
    kit.add(blob(0, 0.68, (u, x) => ({ up: 0.06, down: 0.06, w: bw(u), e: 3.2 }), { n: 24, ring: 28, ra: 0.06, rb: 0.12 }), 'leather', M({ p: [0.90, 0.68, z], r: [0, 0, 101 * D2R] }));
  }
  const swC = [1.47, 1.13, -0.32], swAx = V(-0.62, 0.78, 0).normalize();
  const swM = M({ p: swC, q: new T.Quaternion().setFromUnitVectors(V(0, 0, 1), swAx) });
  kit.add(new T.TorusGeometry(0.17, 0.017, 10, 40), 'black', swM);
  for (let i = 0; i < 3; i++) { const a = -Math.PI / 2 + (i - 1) * 1.3; kit.add(rod([0, 0, -0.01], [Math.cos(a) * 0.165, Math.sin(a) * 0.165, 0], 0.012, 6), 'black', swM); }
  kit.add(rod(swC, [1.66, 0.88, -0.32], 0.02, 8), 'black');

  // roll cage (black): A + B pillars as one rounded hoop per side, cross bars, rear braces
  const cage = s => [[0.80, 0.80, s * 0.61], [0.78, 1.35, s * 0.59], [0.74, 1.74, s * 0.56], [0.86, 1.84, s * 0.555], [1.30, 1.85, s * 0.555], [1.45, 1.79, s * 0.56], [1.62, 1.42, s * 0.585], [1.80, 1.0, s * 0.6]];
  tube(kit, 'frame', cage(1), 0.026, { n: 90, seg: 12 }, true);
  for (const [x, y] of [[0.80, 1.82], [1.38, 1.83], [0.78, 1.32]]) kit.add(rod([x, y, -0.56], [x, y, 0.56], 0.022, 10), 'frame');
  kit.add(rod([1.80, 0.99, -0.6], [1.80, 0.99, 0.6], 0.022, 10), 'frame');
  tube(kit, 'frame', [[0.76, 1.72, 0.555], [0.45, 1.30, 0.53], [0.05, 0.97, 0.52]], 0.022, { n: 24, seg: 10 }, true);
  kit.add(rod([0.30, 1.16, -0.53], [0.30, 1.16, 0.53], 0.018, 8), 'frame');
  // grab bar for the passenger, harness bar
  tube(kit, 'frame', [[1.55, 1.02, 0.15], [1.52, 1.10, 0.25], [1.55, 1.02, 0.45]], 0.014, { n: 16, seg: 8 });

  // front: double A-arms, coil-overs, knuckles
  for (const s of [-1, 1]) {
    aArm(kit, 'frame', [2.10, 0.42, s * 0.30], [2.48, 0.42, s * 0.30], [WB, 0.33, s * 0.58], 0.017);
    aArm(kit, 'frame', [2.14, 0.62, s * 0.30], [2.44, 0.62, s * 0.30], [WB, 0.52, s * 0.565], 0.015);
    kit.add(blob(-0.12, 0.12, () => ({ up: 0.04, down: 0.04, w: 0.03 }), { n: 8, ring: 12 }), 'alloy', M({ p: [WB, 0.43, s * 0.585], r: [0, 0, Math.PI / 2] }));
    coilover(kit, [WB - 0.04, 0.37, s * 0.50], [WB - 0.12, 0.98, s * 0.30], { body: 0.026, spring: 0.045, coils: 7 });
    // rear: trailing arm, radius rods, coil-over
    tube(kit, 'frame', [[1.02, 0.47, s * 0.44], [0.55, 0.42, s * 0.52], [0.06, 0.37, s * 0.575]], 0.03, { n: 20, seg: 12 });
    for (const y of [0.32, 0.47, 0.55]) kit.add(rod([0.25, y + 0.02, s * 0.22], [0.0, y, s * 0.565], 0.013, 8), 'frame');
    kit.add(blob(-0.1, 0.1, () => ({ up: 0.05, down: 0.05, w: 0.03 }), { n: 8, ring: 12 }), 'alloy', M({ p: [0, 0.42, s * 0.59], r: [0, 0, Math.PI / 2] }));
    coilover(kit, [0.18, 0.40, s * 0.53], [0.50, 1.02, s * 0.38], { body: 0.028, spring: 0.048, coils: 8 });
    kit.add(rod([0, 0.37, s * 0.2], [0, 0.37, s * 0.56], 0.018, 8), 'frame');
    kit.add(rod([WB, 0.37, s * 0.25], [WB, 0.37, s * 0.56], 0.016, 8), 'frame');
  }
  return kit.finish();
}

// ================================================================ ATV
// Yamaha Grizzly / Polaris Sportsman-ish: L ~2.1 m, W 1.2, seat 0.9 m, wheelbase 1.25, 25x8-12 / 25x10-12.
function buildAtv() {
  const kit = new Kit();
  const WB = 1.25, R = 0.3175;
  for (const s of [-1, 1]) {
    knobbyWheel(kit, { x: WB, y: R, z: s * 0.46, R, w: 0.2, rimR: 0.152, rimW: 0.15, lugs: 20, spokes: 5 });
    knobbyWheel(kit, { x: 0, y: R, z: s * 0.46, R, w: 0.25, rimR: 0.152, rimW: 0.19, lugs: 20, spokes: 5 });
  }
  // frame / skid, engine, footwells
  kit.add(blob(-0.05, 1.45, () => ({ y: 0.36, up: 0.06, down: 0.05, w: 0.2, e: 5 }), { n: 12, ring: 20, ra: 0.06, rb: 0.08 }), 'under');
  kit.add(blob(0.30, 0.98, () => ({ y: 0.52, up: 0.17, down: 0.14, w: 0.19, e: 2.8 }), { n: 16, ring: 24, ra: 0.25, rb: 0.25 }), 'engine');
  kit.add(lathe([[0.06, 0], [0.085, 0.02], [0.085, 0.16], [0.06, 0.18], [0, 0.18]], 20), 'alloy', M({ p: [0.72, 0.60, 0], r: [0, 0, 0.5] }));
  for (const s of [-1, 1]) {
    kit.add(blob(0.40, 0.98, () => ({ y: 0.355, z: s * 0.36, up: 0.02, down: 0.02, w: 0.12, e: 6 }), { n: 12, ring: 20, ra: 0.06, rb: 0.06 }), 'plastic');
    kit.add(blob(0.40, 0.98, () => ({ y: 0.52, z: s * 0.47, up: 0.16, down: 0.16, w: 0.012, e: 6 }), { n: 12, ring: 20, ra: 0.06, rb: 0.06 }), 'plastic');
  }
  // plastics (owner colour): front and rear fenders + centre sections, tank/console
  for (const s of [-1, 1]) {
    kit.add(fender({ cx: WB, cy: R, z: s * 0.43, R: 0.415, a0: 2, a1: 165, hw: 0.19, depth: t => 0.05 + 0.03 * Math.sin(t * Math.PI), bulge: 0.008, rc: 0.035, flare: t => 0.025 * Math.sin(t * Math.PI) }), 'paint');
    kit.add(fender({ cx: 0, cy: R, z: s * 0.43, R: 0.415, a0: 15, a1: 178, hw: 0.2, depth: t => 0.05 + 0.03 * Math.sin(t * Math.PI), bulge: 0.008, rc: 0.035, flare: t => 0.025 * Math.sin(t * Math.PI) }), 'paint');
  }
  const fT = curve([[0.95, 0.84], [1.25, 0.835], [1.55, 0.78], [1.74, 0.66]]);
  const fB = curve([[0.95, 0.58], [1.74, 0.48]]);
  const fW = curve([[0.95, 0.27], [1.3, 0.33], [1.6, 0.31], [1.74, 0.23]]);
  kit.add(blob(0.93, 1.76, (u, x) => ({ y: (fT(x) + fB(x)) / 2, up: (fT(x) - fB(x)) / 2, down: (fT(x) - fB(x)) / 2, w: fW(x), wt: 0.85, e: 3.2 }), { n: 28, ring: 32, ra: 0.04, rb: 0.14 }), 'paint');
  const rT = curve([[-0.38, 0.76], [-0.2, 0.83], [0.4, 0.84]]);
  kit.add(blob(-0.40, 0.42, (u, x) => ({ y: (rT(x) + 0.56) / 2, up: (rT(x) - 0.56) / 2, down: (rT(x) - 0.56) / 2, w: 0.3, wt: 0.9, e: 3.2 }), { n: 24, ring: 32, ra: 0.1, rb: 0.06 }), 'paint');
  const cT = curve([[0.80, 0.90], [0.98, 0.99], [1.12, 0.97], [1.22, 0.88]]);
  kit.add(blob(0.80, 1.22, (u, x) => ({ y: (cT(x) + 0.74) / 2, up: (cT(x) - 0.74) / 2, down: (cT(x) - 0.74) / 2, w: 0.16, wt: 0.75, e: 2.6 }), { n: 20, ring: 28, ra: 0.25, rb: 0.3 }), 'paint');
  // seat
  const sT = curve([[0.0, 0.86], [0.15, 0.905], [0.6, 0.905], [0.88, 0.93]]);
  kit.add(blob(-0.02, 0.90, (u, x) => ({ y: (sT(x) + 0.78) / 2, up: (sT(x) - 0.78) / 2, down: (sT(x) - 0.78) / 2, w: 0.165, wt: 0.86, e: 3.6 }), { n: 24, ring: 28, ra: 0.1, rb: 0.08 }), 'leather');
  // handlebars, headlight pod
  kit.add(rod([0.98, 0.80, 0], [1.07, 1.11, 0], 0.02, 10), 'frame');
  const bar = [[0.98, 1.17, -0.47], [1.0, 1.17, -0.36], [1.05, 1.155, -0.2], [1.075, 1.14, 0], [1.05, 1.155, 0.2], [1.0, 1.17, 0.36], [0.98, 1.17, 0.47]];
  tube(kit, 'frame', bar, 0.0127, { n: 60, seg: 10 });
  kit.add(rod([1.0, 1.17, 0.35], [0.98, 1.17, 0.48], 0.018, 12, 0.018, false), 'rubber', null, true);
  kit.add(blob(1.02, 1.23, u => ({ y: 1.15 - u * 0.03, up: 0.042, down: 0.04, w: 0.14, wt: 0.75, e: 2.8 }), { n: 16, ring: 24, ra: 0.3, rb: 0.3 }), 'paint');
  kit.add(blob(1.19, 1.245, () => ({ y: 1.125, up: 0.022, down: 0.016, w: 0.085, e: 3 }), { n: 8, ring: 16, ra: 0.5, rb: 0.3 }), 'head');
  for (const s of [-1, 1]) kit.add(blob(1.66, 1.74, u => ({ y: 0.645, z: s * 0.17, up: 0.022, down: 0.018, w: 0.06, e: 3 }), { n: 8, ring: 16, ra: 0.4, rb: 0.3 }), 'head');
  kit.add(blob(-0.42, -0.36, () => ({ y: 0.72, up: 0.025, down: 0.025, w: 0.06, e: 3 }), { n: 6, ring: 16, ra: 0.4, rb: 0.4 }), 'tail');

  // racks (black tube): rounded rectangles + slats
  const rack = (x0, x1, y, hw) => [[x0, y, -hw + 0.06], [x0, y, hw - 0.06], [x0 + 0.04, y, hw], [x1 - 0.04, y, hw], [x1, y, hw - 0.06], [x1, y, -hw + 0.06], [x1 - 0.04, y, -hw], [x0 + 0.04, y, -hw]];
  tube(kit, 'frame', rack(1.30, 1.70, 0.92, 0.40), 0.014, { n: 80, seg: 8, closed: true });
  for (const z of [-0.2, 0, 0.2]) kit.add(rod([1.30, 0.92, z], [1.70, 0.92, z], 0.01, 6), 'frame');
  for (const x of [1.42, 1.58]) kit.add(rod([x, 0.92, -0.4], [x, 0.92, 0.4], 0.009, 6), 'frame');
  for (const s of [-1, 1]) for (const x of [1.36, 1.64]) kit.add(rod([x, 0.92, s * 0.3], [x, 0.83 - (x - 1.36) * 0.2, s * 0.24], 0.011, 6), 'frame');
  tube(kit, 'frame', rack(-0.38, 0.30, 0.91, 0.44), 0.014, { n: 80, seg: 8, closed: true });
  for (const z of [-0.22, 0, 0.22]) kit.add(rod([-0.38, 0.91, z], [0.30, 0.91, z], 0.01, 6), 'frame');
  for (const x of [-0.15, 0.08]) kit.add(rod([x, 0.91, -0.44], [x, 0.91, 0.44], 0.009, 6), 'frame');
  for (const s of [-1, 1]) for (const x of [-0.3, 0.22]) kit.add(rod([x, 0.91, s * 0.34], [x, 0.82, s * 0.28], 0.011, 6), 'frame');
  // bumpers + hitch
  tube(kit, 'frame', [[1.62, 0.42, -0.2], [1.76, 0.46, -0.16], [1.80, 0.55, -0.1], [1.80, 0.55, 0.1], [1.76, 0.46, 0.16], [1.62, 0.42, 0.2]], 0.02, { n: 40, seg: 10 });
  kit.add(rod([1.78, 0.48, 0], [1.80, 0.60, 0], 0.016, 8), 'frame');
  kit.add(rod([-0.30, 0.36, 0], [-0.44, 0.36, 0], 0.02, 8), 'frame');
  kit.add(slab(0.05, 0.02, 0.06, 4), 'frame', M({ p: [-0.45, 0.36, 0] }));
  kit.add(rod([0.2, 0.66, 0.24], [-0.34, 0.70, 0.27], 0.03, 14, 0.03, false), 'alloy');
  // suspension: double A-arms front + rear (independent), coil-overs
  for (const s of [-1, 1]) {
    aArm(kit, 'frame', [WB - 0.14, 0.33, s * 0.13], [WB + 0.12, 0.33, s * 0.13], [WB, 0.27, s * 0.37], 0.015);
    aArm(kit, 'frame', [WB - 0.12, 0.47, s * 0.13], [WB + 0.1, 0.47, s * 0.13], [WB, 0.43, s * 0.35], 0.013);
    coilover(kit, [WB - 0.03, 0.31, s * 0.30], [WB - 0.08, 0.74, s * 0.15], { body: 0.022, spring: 0.04, coils: 6 });
    aArm(kit, 'frame', [-0.13, 0.33, s * 0.12], [0.13, 0.33, s * 0.12], [0, 0.27, s * 0.34], 0.015);
    aArm(kit, 'frame', [-0.11, 0.47, s * 0.12], [0.11, 0.47, s * 0.12], [0, 0.43, s * 0.33], 0.013);
    coilover(kit, [0.03, 0.31, s * 0.29], [0.08, 0.74, s * 0.14], { body: 0.024, spring: 0.042, coils: 6 });
    kit.add(blob(-0.08, 0.08, () => ({ up: 0.04, down: 0.04, w: 0.03 }), { n: 8, ring: 12 }), 'alloy', M({ p: [WB, 0.35, s * 0.37], r: [0, 0, Math.PI / 2] }));
    kit.add(blob(-0.08, 0.08, () => ({ up: 0.04, down: 0.04, w: 0.03 }), { n: 8, ring: 12 }), 'alloy', M({ p: [0, 0.35, s * 0.35], r: [0, 0, Math.PI / 2] }));
  }
  return kit.finish();
}

// ================================================================ shared bike parts (sport / dual-sport / scooter)
/** Cast wheel: round tyre, rim barrel, n split spokes, hub, optional discs (z offsets). */
function castWheel(kit, { x, y, R, w, rimR, rimW, spokes = 5, mat = 'rimDark', discs = [], discR = 0.14 }) {
  kit.add(tyre(R, w, rimR), 'tire', M({ p: [x, y, 0] }));
  const h = rimW / 2;
  kit.add(lathe([[rimR + 0.012, -h], [rimR + 0.004, -h + 0.006], [rimR - 0.006, -h + 0.012], [rimR - 0.006, h - 0.012], [rimR + 0.004, h - 0.006], [rimR + 0.012, h],
    [rimR - 0.014, h - 0.004], [rimR - 0.016, -h + 0.004], [rimR + 0.012, -h]], 48), mat, M({ p: [x, y, 0], r: [Math.PI / 2, 0, 0] }));
  const hubR = 0.05, len = rimR - hubR - 0.006, sp = slab(len, 0.022, 0.018, 3, 0.15);
  for (let i = 0; i < spokes; i++) for (const d of [-0.09, 0.09]) {
    const a = (i / spokes) * Math.PI * 2 + d, rr = hubR + len / 2;
    kit.add(sp, mat, M({ p: [x + Math.cos(a) * rr, y + Math.sin(a) * rr, 0], r: [0, 0, a + d * 0.6] }));
  }
  kit.add(lathe([[0.015, -0.06], [hubR, -0.05], [hubR, 0.05], [0.015, 0.06]], 20), 'alloy', M({ p: [x, y, 0], r: [Math.PI / 2, 0, 0] }));
  for (const dz of discs) kit.add(lathe([[0.055, -0.0025], [discR, -0.0025], [discR, 0.0025], [0.055, 0.0025], [0.055, -0.0025]], 40), 'alloy', M({ p: [x, y, dz], r: [Math.PI / 2, 0, 0] }));
}
/** Knobs on a dual-purpose tyre (two staggered rows). */
function knobs(kit, x, y, R, w, n = 30) {
  const box = new T.BoxGeometry(0.014, 0.03, w * 0.32);
  for (let i = 0; i < n; i++) for (const [zz, o] of [[-w * 0.2, 0], [w * 0.2, 0.5]]) {
    const a = ((i + o) / n) * Math.PI * 2;
    kit.add(box, 'tire', M({ p: [x + Math.cos(a) * (R - 0.004), y + Math.sin(a) * (R - 0.004), zz], r: [0, 0, a] }));
  }
}
/** Telescopic fork at axle FA with rake (deg): sliders, tubes (optional gaiters), axle, clamps, steering head. */
function teleFork(kit, FA, rakeDeg, { spread = 0.1, sl = 0.3, top = 0.72, rS = 0.028, rT = 0.02, sliderMat = 'alloy', tubeMat = 'chromeV', clampMat = 'frame', gaiter = false, offset = 0.04 }) {
  const rk = rakeDeg * D2R, fd = [-Math.sin(rk), Math.cos(rk)], bk = [-Math.cos(rk), -Math.sin(rk)];
  const fp = (s, z = 0) => [FA[0] + fd[0] * s, FA[1] + fd[1] * s, z];
  const hp = (s, z = 0) => [FA[0] + fd[0] * s + bk[0] * offset, FA[1] + fd[1] * s + bk[1] * offset, z];
  const q = new T.Quaternion().setFromUnitVectors(V(0, 1, 0), V(fd[0], fd[1], 0));
  for (const z of [-spread, spread]) {
    const m = M({ p: fp(0, z), q });
    kit.add(lathe([[0, -0.06], [rS * 0.7, -0.058], [rS, -0.035], [rS, sl - 0.02], [rS * 0.85, sl], [0, sl + 0.002]], 16), sliderMat, m);
    kit.add(rod([0, sl - 0.02], [0, top + 0.02], rT, 12), tubeMat, m);
    if (gaiter) {
      const g = []; for (let k = 0; k <= 12; k++) g.push([k % 2 ? rT + 0.012 : rT + 0.004, sl + 0.01 + k * 0.018]);
      kit.add(lathe([[rT, sl + 0.005], ...g, [rT, sl + 0.23]], 14), 'rubber', m);
    }
  }
  kit.add(rod([FA[0], FA[1], -spread - 0.03], [FA[0], FA[1], spread + 0.03], 0.01, 8), 'alloy');
  const zq = q.clone().multiply(new T.Quaternion().setFromEuler(new T.Euler(0, 0, Math.PI / 2)));
  for (const s of [top - 0.17, top]) kit.add(slab(0.08, 0.03, spread * 2 + 0.07, 3, 0.35), clampMat, M({ p: lerp3(fp(s), hp(s), 0.45), q: zq }));
  kit.add(rod(hp(top - 0.22), hp(top + 0.03), 0.03, 12), 'frame');
  return { fp, hp, fd };
}
/** Side stand on the left reaching the ground at the lean angle. */
function sideStand(kit, pivot, footX, lean, fz = -0.33) {
  const fy = -fz * Math.tan(lean) + 0.006;
  kit.add(rod(pivot, [footX, fy + 0.012, fz], 0.012, 8, 0.01), 'frame');
  kit.add(slab(0.06, 0.012, 0.04, 4), 'frame', M({ p: [footX, fy, fz], r: [lean, 0, 0] }));
}
const loft = (kit, mat, x0, x1, top, bot, wid, o = {}, m = null) => {
  const tT = num(top), tB = num(bot), tW = num(wid);
  kit.add(blob(x0, x1, (u, x) => ({ y: (tT(x) + tB(x)) / 2, z: o.z || 0, up: (tT(x) - tB(x)) / 2, down: (tT(x) - tB(x)) / 2, w: tW(x), wt: o.wt ?? 0.8, wb: o.wb ?? 0.9, e: o.e ?? 2.6 }),
    { n: o.n ?? 28, ring: o.ring ?? 32, ra: o.ra ?? 0.15, rb: o.rb ?? 0.15 }), mat, m, o.mirror);
};

// ================================================================ SPORT (Ninja 650-ish: WB 1410, L 2.10, seat 790, 120/70-17 + 160/60-17)
function buildSport() {
  const kit = new Kit();
  const RA = [0, 0.312], FA = [1.41, 0.30];
  castWheel(kit, { x: FA[0], y: FA[1], R: 0.30, w: 0.12, rimR: 0.216, rimW: 0.09, spokes: 5, discs: [-0.075, 0.075], discR: 0.15 });
  castWheel(kit, { x: RA[0], y: RA[1], R: 0.312, w: 0.16, rimR: 0.216, rimW: 0.12, spokes: 5, discs: [0.085], discR: 0.11 });
  kit.add(lathe([[0.03, -0.004], [0.1, -0.004], [0.1, 0.004], [0.03, 0.004], [0.03, -0.004]], 32), 'alloy', M({ p: [0, RA[1], -0.09], r: [Math.PI / 2, 0, 0] }));
  for (const z of [-0.088, 0.088]) kit.add(slab(0.07, 0.045, 0.035, 3), 'black', M({ p: [FA[0] - 0.09, FA[1] + 0.1, z], r: [0, 0, 0.9] }));
  const { fp, hp } = teleFork(kit, FA, 24.5, { spread: 0.1, sl: 0.33, top: 0.72, rS: 0.03, rT: 0.021, sliderMat: 'rimDark', tubeMat: 'chromeV' });
  kit.add(fender({ cx: FA[0], cy: FA[1], R: 0.33, a0: 45, a1: 145, hw: 0.068, depth: t => 0.03 + 0.03 * Math.sin(t * Math.PI), bulge: 0.006, rc: 0.025 }), 'paint');
  // front cowl, headlights, screen, side fairings
  const cT = curve([[0.95, 0.86], [1.15, 0.97], [1.32, 1.035], [1.50, 0.97], [1.67, 0.83]]);
  const cB = curve([[0.95, 0.50], [1.06, 0.44], [1.15, 0.54], [1.26, 0.68], [1.45, 0.72], [1.67, 0.79]]);
  loft(kit, 'paint', 0.93, 1.68, cT, cB, [[0.93, 0.16], [1.15, 0.205], [1.38, 0.2], [1.55, 0.14], [1.68, 0.06]], { wt: 0.55, wb: 0.8, e: 2.5, ra: 0.06, rb: 0.22, n: 40, ring: 36 });
  kit.add(blob(1.0, 1.22, () => ({ y: 0.60, up: 0.06, down: 0.06, w: 0.2, e: 6 }), { n: 10, ring: 24, ra: 0.2, rb: 0.2 }), 'black');
  for (const s of [-1, 1]) kit.add(blob(1.53, 1.655, u => ({ y: 0.86 - u * 0.03, z: s * lerp(0.115, 0.045, u), up: 0.022, down: 0.018, w: 0.045, e: 3 }), { n: 10, ring: 16, ra: 0.2, rb: 0.4 }), 'head');
  kit.add(blob(1.22, 1.50, u => ({ y: cT(lerp(1.22, 1.50, u)) + 0.03 + (1 - u) * 0.045, up: 0.006, down: 0.006, w: lerp(0.16, 0.08, u), e: 2.5 }), { n: 14, ring: 16, ra: 0.1, rb: 0.3 }), 'glass');
  for (const s of [-1, 1]) {
    kit.add(rod([1.28, 1.02, s * 0.2], [1.28, 1.08, s * 0.3], 0.007, 6), 'black');
    kit.add(blob(1.24, 1.33, () => ({ y: 1.09, z: s * 0.32, up: 0.03, down: 0.03, w: 0.055, e: 2.5 }), { n: 10, ring: 16, ra: 0.4, rb: 0.3 }), 'paint');
  }
  // tank, seat, tail
  loft(kit, 'paint', 0.80, 1.22, [[0.80, 0.90], [0.95, 1.03], [1.12, 1.06], [1.22, 1.03]], [[0.80, 0.80], [1.22, 0.86]], [[0.80, 0.12], [1.0, 0.175], [1.22, 0.16]], { ra: 0.2, rb: 0.12, e: 2.6 });
  loft(kit, 'leather', 0.42, 0.86, [[0.42, 0.80], [0.55, 0.785], [0.75, 0.80], [0.86, 0.86]], [[0.42, 0.71], [0.86, 0.80]], [[0.42, 0.13], [0.6, 0.15], [0.86, 0.08]], { e: 3.2, ra: 0.06, rb: 0.15 });
  loft(kit, 'leather', 0.16, 0.47, [[0.16, 0.86], [0.47, 0.85]], [[0.16, 0.80], [0.47, 0.76]], [[0.16, 0.08], [0.47, 0.11]], { e: 3.2, ra: 0.12, rb: 0.08 });
  loft(kit, 'paint', -0.14, 0.52, [[-0.14, 0.88], [0.15, 0.87], [0.52, 0.80]], [[-0.14, 0.85], [0.15, 0.74], [0.52, 0.62]], [[-0.14, 0.03], [0.1, 0.1], [0.52, 0.15]], { e: 2.6, ra: 0.06, rb: 0.08 });
  kit.add(blob(-0.15, -0.08, () => ({ y: 0.865, up: 0.014, down: 0.012, w: 0.05, e: 3 }), { n: 6, ring: 16, ra: 0.5, rb: 0.3 }), 'tail');
  kit.add(rod([-0.02, 0.78, 0], [-0.17, 0.58, 0], 0.012, 8), 'black');
  kit.add(new T.BoxGeometry(0.004, 0.1, 0.17), 'plate', M({ p: [-0.18, 0.53, 0], r: [0, 0, -0.15] }));
  for (const s of [-1, 1]) kit.add(blob(-0.14, -0.06, () => ({ y: 0.62, z: s * 0.09, up: 0.014, down: 0.014, w: 0.014 }), { n: 8, ring: 12, ra: 0.3, rb: 0.5 }), 'amber');
  // engine, exhaust, frame, swingarm
  kit.add(blob(0.60, 1.20, () => ({ y: 0.42, up: 0.18, down: 0.14, w: 0.16, e: 3 }), { n: 16, ring: 24, ra: 0.2, rb: 0.2 }), 'engine');
  kit.add(blob(0.92, 1.24, () => ({ y: 0.66, up: 0.1, down: 0.08, w: 0.15, e: 3 }), { n: 12, ring: 24, ra: 0.3, rb: 0.3 }), 'alloy', M({ p: [1.08, 0.66, 0], r: [0, 0, -0.5] }).multiply(M({ p: [-1.08, -0.66, 0] })));
  for (const z of [-0.05, 0.05]) tube(kit, 'alloy', [[1.25, 0.6, z], [1.33, 0.46, z * 1.2], [1.28, 0.26, z * 1.4], [1.0, 0.21, z], [0.85, 0.22, 0.03]], 0.02, { n: 30, seg: 10 });
  kit.add(blob(0.50, 0.92, () => ({ y: 0.22, z: 0.04, up: 0.06, down: 0.05, w: 0.11, e: 3 }), { n: 12, ring: 20, ra: 0.2, rb: 0.2 }), 'black');
  for (const s of [-1, 1]) {
    tube(kit, 'frame', [hp(0.62, s * 0.04), [1.0, 0.86, s * 0.12], [0.78, 0.74, s * 0.13], [0.62, 0.48, s * 0.11]], 0.022, { n: 30, seg: 10 });
    tube(kit, 'frame', [[0.70, 0.74, s * 0.1], [0.35, 0.74, s * 0.08], [-0.02, 0.82, s * 0.06]], 0.014, { n: 20, seg: 8 });
    tube(kit, 'rimDark', [[0.62, 0.43, s * 0.1], [0.3, 0.38, s * 0.1], [0.0, RA[1], s * 0.1]], t => lerp(0.035, 0.024, t), { n: 16, seg: 12 });
    kit.add(rod([0.98, 0.42, s * 0.13], [0.98, 0.42, s * 0.22], 0.011, 8), 'rubber');
    kit.add(rod([0.62, 0.52, s * 0.12], [0.62, 0.52, s * 0.2], 0.01, 8), 'rubber');
    kit.add(rod(hp(0.7, s * 0.06), [hp(0.7)[0] - 0.04, hp(0.7)[1] - 0.01, s * 0.32], 0.012, 8), 'black');
    kit.add(rod([hp(0.7)[0] - 0.03, hp(0.7)[1] - 0.008, s * 0.22], [hp(0.7)[0] - 0.045, hp(0.7)[1] - 0.012, s * 0.33], 0.017, 10, 0.017, false), 'rubber');
  }
  sideStand(kit, [0.78, 0.30, -0.12], 0.62, SPORT.lean, -0.31);
  return kit.finish();
}

// ================================================================ DUAL-SPORT (KLR650-ish: WB 1480, L 2.30, seat 890, 90/90-21 + 130/80-17)
function buildDualsport() {
  const kit = new Kit();
  const RA = [0, 0.32], FA = [1.48, 0.348];
  spokedWheel(kit, { x: FA[0], y: FA[1], R: 0.348, w: 0.09, rimR: 0.2667, rimW: 0.05, hubR: 0.045, hubW: 0.1, spokes: 36 });
  spokedWheel(kit, { x: RA[0], y: RA[1], R: 0.32, w: 0.13, rimR: 0.216, rimW: 0.075, hubR: 0.055, hubW: 0.13, spokes: 36 });
  knobs(kit, FA[0], FA[1], 0.348, 0.09, 34); knobs(kit, RA[0], RA[1], 0.32, 0.13, 30);
  kit.add(lathe([[0.05, -0.0025], [0.13, -0.0025], [0.13, 0.0025], [0.05, 0.0025], [0.05, -0.0025]], 32), 'alloy', M({ p: [FA[0], FA[1], 0.065], r: [Math.PI / 2, 0, 0] }));
  const { fp, hp } = teleFork(kit, FA, 28, { spread: 0.095, sl: 0.36, top: 0.86, rS: 0.028, rT: 0.021, sliderMat: 'alloy', tubeMat: 'chromeV', gaiter: true });
  // high front fender under the lower clamp + headlight fairing + screen
  const lc = fp(0.69);
  kit.add(fender({ cx: FA[0], cy: FA[1], R: 0.46, a0: 30, a1: 128, hw: 0.075, depth: 0.025, bulge: 0.008, rc: 0.025 }), 'paint');
  loft(kit, 'paint', 1.12, 1.42, [[1.12, 1.21], [1.28, 1.19], [1.42, 1.05]], [[1.12, 1.0], [1.3, 0.97], [1.42, 0.99]], [[1.12, 0.12], [1.3, 0.12], [1.42, 0.07]], { wt: 0.7, ra: 0.1, rb: 0.3, e: 2.6 });
  kit.add(blob(1.37, 1.42, () => ({ y: 1.07, up: 0.05, down: 0.04, w: 0.06, e: 2.4 }), { n: 8, ring: 16, ra: 0.6, rb: 0.3 }), 'head');
  kit.add(blob(1.10, 1.30, u => ({ y: 1.30 - u * 0.06, up: 0.08, down: 0.08, w: 0.008, e: 2.5 }), { n: 10, ring: 16, ra: 0.2, rb: 0.3 }), 'glass', M({ p: [1.2, 1.26, 0], r: [Math.PI / 2, 0, 0] }).multiply(M({ p: [-1.2, -1.26, 0] })));
  // big tank with shrouds, long flat seat, side panels, rear rack + tail
  loft(kit, 'paint', 0.64, 1.10, [[0.64, 1.0], [0.8, 1.08], [0.98, 1.10], [1.10, 1.05]], [[0.64, 0.86], [0.9, 0.82], [1.10, 0.86]], [[0.64, 0.13], [0.8, 0.19], [0.98, 0.21], [1.10, 0.15]], { ra: 0.18, rb: 0.15, e: 2.8 });
  loft(kit, 'leather', 0.05, 0.80, [[0.05, 0.92], [0.3, 0.925], [0.55, 0.89], [0.72, 0.91], [0.80, 0.97]], [[0.05, 0.84], [0.55, 0.83], [0.80, 0.92]], [[0.05, 0.10], [0.35, 0.14], [0.65, 0.13], [0.80, 0.07]], { e: 3.4, ra: 0.06, rb: 0.08 });
  for (const s of [-1, 1]) loft(kit, 'paint', 0.24, 0.68, [[0.24, 0.86], [0.68, 0.86]], [[0.24, 0.80], [0.68, 0.64]], 0.016, { z: s * 0.12, e: 5, wt: 1, wb: 1, ra: 0.1, rb: 0.1 });
  loft(kit, 'plastic', -0.32, 0.25, [[-0.32, 0.88], [0.25, 0.86]], [[-0.32, 0.84], [0.25, 0.74]], [[-0.32, 0.06], [0.25, 0.12]], { e: 3.2, ra: 0.05, rb: 0.05 });
  tube(kit, 'frame', [[-0.25, 0.93, -0.12], [-0.25, 0.93, 0.12], [0.15, 0.93, 0.14], [0.15, 0.93, -0.14]], 0.011, { n: 40, seg: 8, closed: true });
  kit.add(blob(-0.34, -0.29, () => ({ y: 0.85, up: 0.02, down: 0.02, w: 0.04, e: 3 }), { n: 6, ring: 16, ra: 0.5, rb: 0.3 }), 'tail');
  kit.add(new T.BoxGeometry(0.004, 0.1, 0.17), 'plate', M({ p: [-0.33, 0.76, 0], r: [0, 0, -0.2] }));
  // single-cylinder engine, radiator, skid plate, upswept pipe, frame, swingarm, shock
  kit.add(blob(0.68, 1.12, () => ({ y: 0.42, up: 0.16, down: 0.13, w: 0.14, e: 3 }), { n: 14, ring: 24, ra: 0.25, rb: 0.25 }), 'engine');
  kit.add(lathe([[0.08, 0], [0.085, 0.24], [0.075, 0.28], [0, 0.29]], 20), 'engine', alongY([0.95, 0.45, 0], [0.35, 1, 0]));
  kit.add(slab(0.05, 0.22, 0.30, 4, 0.2), 'black', M({ p: [1.18, 0.75, 0], r: [0, 0, -0.35] }));
  kit.add(blob(0.62, 1.18, u => ({ y: 0.25 + u * 0.03, up: 0.03, down: 0.03, w: 0.12, e: 4 }), { n: 12, ring: 20, ra: 0.1, rb: 0.3 }), 'alloy');
  tube(kit, 'alloy', [[1.08, 0.62, 0.04], [1.16, 0.45, 0.10], [1.06, 0.33, 0.14], [0.70, 0.37, 0.15], [0.35, 0.52, 0.16], [0.18, 0.62, 0.16]], 0.019, { n: 40, seg: 10 });
  loft(kit, 'alloy', -0.18, 0.30, u => 0.69 + (1 - u) * 0.04 + 0.05, u => 0.69 + (1 - u) * 0.04 - 0.05, 0.05, { z: 0.16, e: 2.2, ra: 0.12, rb: 0.2 }, null);
  for (const s of [-1, 1]) {
    tube(kit, 'frame', [hp(0.78, s * 0.03), [1.0, 0.98, s * 0.07], [0.75, 0.85, s * 0.09], [0.66, 0.50, s * 0.1]], 0.02, { n: 30, seg: 10 });
    tube(kit, 'frame', [[0.72, 0.83, s * 0.08], [0.3, 0.83, s * 0.09], [-0.15, 0.87, s * 0.08]], 0.013, { n: 20, seg: 8 });
    tube(kit, 'alloy', [[0.66, 0.46, s * 0.09], [0.3, 0.40, s * 0.09], [0.0, RA[1], s * 0.085]], t => lerp(0.03, 0.022, t), { n: 16, seg: 12 });
    kit.add(rod([0.98, 0.44, s * 0.12], [0.98, 0.44, s * 0.22], 0.012, 8), 'frame');
    tube(kit, 'frame', [[1.0, 1.20, s * 0.05], [0.96, 1.22, s * 0.25], [0.93, 1.23, s * 0.42]], 0.012, { n: 12, seg: 8 });
    kit.add(rod([0.94, 1.23, s * 0.32], [0.93, 1.23, s * 0.44], 0.017, 10, 0.017, false), 'rubber');
    kit.add(rod([0.97, 1.23, s * 0.24], [0.95, 1.36, s * 0.28], 0.006, 6), 'black');
    kit.add(blob(0.93, 0.97, () => ({ y: 1.37, z: s * 0.29, up: 0.035, down: 0.035, w: 0.05 }), { n: 8, ring: 16, ra: 0.4, rb: 0.4 }), 'black');
  }
  coilover(kit, [0.42, 0.44, 0], [0.62, 0.80, 0], { body: 0.024, spring: 0.04, coils: 7 });
  sideStand(kit, [0.80, 0.30, -0.12], 0.60, DUALSPORT.lean, -0.33);
  return kit.finish();
}

// ================================================================ SCOOTER (PCX-ish: WB 1310, L 1.92, seat 760, 14" wheels; on its centre stand)
function buildScooter() {
  const kit = new Kit();
  const RA = [0, 0.262], FA = [1.31, 0.258];
  castWheel(kit, { x: FA[0], y: FA[1], R: 0.258, w: 0.10, rimR: 0.178, rimW: 0.075, spokes: 5, discs: [0.06], discR: 0.11 });
  castWheel(kit, { x: RA[0], y: RA[1], R: 0.262, w: 0.12, rimR: 0.178, rimW: 0.09, spokes: 5 });
  const { fp } = teleFork(kit, FA, 27, { spread: 0.085, sl: 0.24, top: 0.55, rS: 0.026, rT: 0.02, sliderMat: 'alloy', tubeMat: 'rimDark' });
  kit.add(fender({ cx: FA[0], cy: FA[1], R: 0.29, a0: 15, a1: 140, hw: 0.065, depth: t => 0.03 + 0.03 * Math.sin(t * Math.PI), bulge: 0.006, rc: 0.025 }), 'paint');
  // front apron / leg shield, step-through floor, centre tunnel, rear body, seat
  loft(kit, 'paint', 0.98, 1.38, [[0.98, 1.0], [1.15, 1.05], [1.30, 0.96], [1.38, 0.80]], [[0.98, 0.40], [1.2, 0.46], [1.38, 0.62]], [[0.98, 0.21], [1.2, 0.22], [1.38, 0.12]], { wt: 0.75, wb: 0.85, e: 3, ra: 0.05, rb: 0.25 });
  loft(kit, 'plastic', 0.50, 1.02, 0.37, 0.31, [[0.50, 0.19], [1.02, 0.2]], { e: 5, ra: 0.05, rb: 0.05 });
  loft(kit, 'paint', 0.50, 1.02, [[0.50, 0.50], [0.75, 0.46], [1.02, 0.52]], 0.34, [[0.50, 0.11], [1.02, 0.12]], { e: 3, wt: 0.7, ra: 0.05, rb: 0.05 });
  loft(kit, 'paint', -0.30, 0.64, [[-0.30, 0.70], [-0.05, 0.77], [0.35, 0.74], [0.64, 0.62]], [[-0.30, 0.60], [0.1, 0.44], [0.4, 0.34], [0.64, 0.34]], [[-0.30, 0.07], [-0.05, 0.16], [0.35, 0.2], [0.64, 0.18]], { wt: 0.8, wb: 0.9, e: 3, ra: 0.08, rb: 0.06 });
  loft(kit, 'leather', -0.12, 0.62, [[-0.12, 0.81], [0.12, 0.81], [0.30, 0.765], [0.50, 0.76], [0.62, 0.79]], [[-0.12, 0.74], [0.62, 0.72]], [[-0.12, 0.1], [0.1, 0.15], [0.45, 0.16], [0.62, 0.1]], { e: 3.4, ra: 0.1, rb: 0.1 });
  kit.add(blob(-0.32, -0.25, () => ({ y: 0.67, up: 0.025, down: 0.02, w: 0.06, e: 3 }), { n: 6, ring: 16, ra: 0.5, rb: 0.3 }), 'tail');
  kit.add(new T.BoxGeometry(0.004, 0.09, 0.15), 'plate', M({ p: [-0.31, 0.53, 0], r: [0, 0, -0.25] }));
  // headset: handlebar cover with headlight, grips, mirrors, small screen
  kit.add(rod(fp(0.5), [1.06, 1.06, 0], 0.025, 10), 'frame');
  loft(kit, 'paint', 0.98, 1.24, [[0.98, 1.14], [1.12, 1.16], [1.24, 1.08]], [[0.98, 1.04], [1.24, 1.02]], [[0.98, 0.14], [1.1, 0.16], [1.24, 0.1]], { wt: 0.75, ra: 0.2, rb: 0.3, e: 2.6 });
  kit.add(blob(1.20, 1.255, () => ({ y: 1.07, up: 0.03, down: 0.02, w: 0.08, e: 3 }), { n: 8, ring: 16, ra: 0.5, rb: 0.3 }), 'head');
  kit.add(blob(1.10, 1.22, u => ({ y: 1.22 - u * 0.05, up: 0.06, down: 0.06, w: 0.006, e: 2.5 }), { n: 10, ring: 16, ra: 0.2, rb: 0.3 }), 'glass', M({ p: [1.16, 1.2, 0], r: [Math.PI / 2, 0, 0] }).multiply(M({ p: [-1.16, -1.2, 0] })));
  for (const s of [-1, 1]) {
    kit.add(rod([1.02, 1.10, s * 0.15], [1.0, 1.10, s * 0.34], 0.017, 10, 0.017, false), 'rubber');
    kit.add(rod([1.08, 1.13, s * 0.17], [1.04, 1.30, s * 0.25], 0.006, 6), 'black');
    kit.add(blob(1.02, 1.06, () => ({ y: 1.31, z: s * 0.26, up: 0.03, down: 0.03, w: 0.05 }), { n: 8, ring: 16, ra: 0.4, rb: 0.4 }), 'black');
  }
  // engine / swingarm unit (left), muffler (right), shock, centre stand
  loft(kit, 'alloy', -0.06, 0.55, [[-0.06, 0.34], [0.3, 0.40], [0.55, 0.42]], [[-0.06, 0.20], [0.55, 0.22]], 0.055, { z: -0.10, e: 3, wt: 1, wb: 1, ra: 0.15, rb: 0.15 });
  loft(kit, 'black', -0.22, 0.30, [[-0.22, 0.36], [0.30, 0.34]], [[-0.22, 0.26], [0.30, 0.24]], 0.05, { z: 0.13, e: 2.6, wt: 1, wb: 1, ra: 0.15, rb: 0.2 });
  kit.add(rod([-0.22, 0.31, 0.13], [-0.25, 0.31, 0.13], 0.025, 12), 'chromeV');
  coilover(kit, [0.05, 0.30, -0.15], [-0.02, 0.62, -0.15], { body: 0.02, spring: 0.035, coils: 6 });
  for (const s of [-1, 1]) kit.add(rod([0.48, 0.24, s * 0.08], [0.50, 0.0, s * 0.11], 0.012, 8), 'frame');
  kit.add(rod([0.50, 0.01, -0.13], [0.50, 0.01, 0.13], 0.012, 8), 'frame');
  return kit.finish();
}

// ---------------------------------------------------------------- specs + instancing
export const CRUISER = { id: 'cruiser', name: 'Cruiser motorcycle', L: 2.45, defaultColor: '#8a8f98', credit: null, minDist: 4.7, lookY: 0.55, lean: 8.5 * D2R, make: buildCruiser };
export const UTV = { id: 'utv', name: 'Side-by-side (UTV)', L: 3.15, defaultColor: '#8a8f98', credit: null, minDist: 6.9, lookY: 0.8, make: buildUtv };
export const SPORT = { id: 'sport', name: 'Sport motorcycle', L: 2.12, defaultColor: '#8a8f98', credit: null, minDist: 4.6, lookY: 0.55, lean: 7 * D2R, make: buildSport };
export const DUALSPORT = { id: 'dualsport', name: 'Dual-sport motorcycle', L: 2.3, defaultColor: '#8a8f98', credit: null, minDist: 4.7, lookY: 0.6, lean: 7 * D2R, make: buildDualsport };
export const SCOOTER = { id: 'scooter', name: 'Scooter', L: 1.95, defaultColor: '#8a8f98', credit: null, minDist: 4.4, lookY: 0.5, make: buildScooter };
export const ATV = { id: 'atv', name: 'ATV', L: 2.25, defaultColor: '#8a8f98', credit: null, minDist: 5.4, lookY: 0.55, make: buildAtv };

const cache = new Map();
/** Geometry (merged per material role) for a spec, built once. */
export function vehicleGeometry(three, S) {
  T = three;
  if (!cache.has(S.id)) cache.set(S.id, S.make());
  return cache.get(S.id);
}
function extraMaterials(mats) {
  const std = o => new T.MeshStandardMaterial(o);
  mats.chromeV ||= std({ color: 0xeef1f5, metalness: 1, roughness: 0.08 });
  mats.alloy ||= std({ color: 0xb4bac2, metalness: 0.85, roughness: 0.3 });
  mats.engine ||= std({ color: 0x1c1d20, metalness: 0.55, roughness: 0.42 });
  mats.frame ||= new T.MeshPhysicalMaterial({ color: 0x0d0e10, metalness: 0.3, roughness: 0.32, clearcoat: 0.6, clearcoatRoughness: 0.2 });
  mats.leather ||= std({ color: 0x16130f, metalness: 0, roughness: 0.6 });
  mats.rubber ||= std({ color: 0x111113, metalness: 0, roughness: 0.92 });
  mats.plastic ||= std({ color: 0x18191c, metalness: 0.05, roughness: 0.68 });
  mats.spring ||= std({ color: 0xc9a227, metalness: 0.7, roughness: 0.32 });
  for (const m of Object.values(mats)) if (m && m.isMaterial) { m.side = T.DoubleSide; m.needsUpdate = true; }
}
/** Build an instance (THREE.Group) using the app's per-car materials; called from createCar via S.build. */
export function buildVehicle(three, S, mats) {
  const { geos } = vehicleGeometry(three, S);
  extraMaterials(mats);
  const inner = new T.Group();
  for (const [role, g] of Object.entries(geos)) {
    const mesh = new T.Mesh(g, mats[role] || mats.black);
    mesh.castShadow = true; mesh.receiveShadow = true; inner.add(mesh);
  }
  if (S.lean) inner.rotation.x = -S.lean; // lean onto the side stand (left = -z), pivoting on the contact patches
  const wrap = new T.Group(); wrap.add(inner);
  return wrap;
}
for (const S of [CRUISER, SPORT, DUALSPORT, SCOOTER, UTV, ATV]) S.build = (three, mats) => buildVehicle(three, S, mats);

export const VEHICLE_SPECS = { cruiser: CRUISER, sport: SPORT, dualsport: DUALSPORT, scooter: SCOOTER, utv: UTV, atv: ATV };
