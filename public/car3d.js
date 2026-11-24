// Procedural 3D cars by body style (sedan, coupe, hatchback, minivan, SUV, pickup) + the garage turntable viewer
// (three.js, no addons), painted in each car's colour. A car can instead show a .glb the owner uploaded (model_url).
//
// Each body is lofted from cross-sections driven by side-profile and plan-view curves sized like a typical vehicle
// of its class (length, wheelbase, width, height, track, tire size). Lights, grilles, trim and seams are "decals":
// outlines projected onto the body by ray casting, so they sit on the surface. All of it is original code; nothing
// is copied from photos or someone else's model files.
export const THREE_URL = '/vendor/three-0.160.0/three.module.min.js';
let T = null;
export async function loadThree() { if (!T) T = await import(THREE_URL); return T; }

export function webglAvailable() {
  try { const c = document.createElement('canvas'); return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl'))); }
  catch { return false; }
}

// ---------------------------------------------------------------- curves
/** Monotone cubic (Fritsch-Carlson) through [x,y] points: smooth, no overshoot. */
function curve(pts) {
  const n = pts.length, xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
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
const smooth = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------- body styles
// Units: metres. x runs from the rear bumper (0) to the front bumper (L); y is up from the ground; z is lateral.
// Each style is a generic, typical vehicle of its class (no specific make or model): U = roof/deck line, B = belt line,
// bot = underside, hw = half width, all as curves over x. windows: side glass outlines at the belt (b) and the roof (t).
// windshield / backlight: x ranges of glass on the top band. Decals are generic: grille, lamps, plate, seams, handles.

// Mid-size sedan: ~4.8 m, 1.45 m tall, three-box.
const SEDAN = {
  id: 'sedan', name: 'Sedan',
  L: 4.803, hwMax: 0.894, axles: [1.00, 3.852], tireR: 0.329, tireW: 0.225, rimR: 0.222, track: 1.525, archR: 0.38,
  U: [[0, 0.60], [0.035, 0.80], [0.10, 0.93], [0.35, 0.975], [0.72, 1.00], [1.02, 1.19], [1.32, 1.35], [1.70, 1.43], [2.15, 1.45],
      [2.55, 1.425], [2.82, 1.37], [3.15, 1.19], [3.52, 0.985], [3.9, 0.905], [4.3, 0.845], [4.60, 0.775], [4.74, 0.685], [4.803, 0.56]],
  B: [[0, 0.60], [0.1, 0.93], [0.5, 0.99], [1.0, 1.0], [2.0, 0.965], [3.0, 0.935], [3.6, 0.95]],
  bot: [[0, 0.44], [0.12, 0.33], [0.40, 0.235], [0.6, 0.20], [4.35, 0.20], [4.62, 0.215], [4.76, 0.29], [4.803, 0.41]],
  hw: [[0, 0.74], [0.07, 0.84], [0.22, 0.88], [0.6, 0.894], [3.95, 0.894], [4.35, 0.875], [4.62, 0.81], [4.75, 0.72], [4.803, 0.60]],
  inset: 0.19, crown: 0.065, rail: 0.05,
  windows: [ { b: [1.06, 2.12], t: [1.50, 2.10] }, { b: [2.21, 3.47], t: [2.21, 2.86] } ],
  blackPillars: [[2.12, 2.21]],
  windshield: [2.82, 3.52], backlight: [0.74, 1.62],
  wheel: { spokes: 5, style: 'bold', finish: 'bright' },
  spoiler: false,
  mirror: { x: 3.44, y: 0.99, len: 0.16, h: 0.10, mat: 'paint' },
  defaultColor: '#8a8f98',
};
SEDAN.decals = [
  // split grille with chrome surround, swept headlamps with projector rings, wide lower intake + fogs
  { view: 'front', mat: 'chrome', off: 0.004, pts: [[0, 0.71], [0.36, 0.72], [0.345, 0.585], [0, 0.565]] },
  { view: 'front', mat: 'black', off: 0.007, pts: [[0, 0.695], [0.34, 0.703], [0.328, 0.60], [0, 0.582]] },
  { view: 'front', mat: 'head', off: 0.004, pts: [[0.37, 0.715], [0.60, 0.745], [0.79, 0.765], [0.86, 0.73], [0.83, 0.66], [0.62, 0.635], [0.38, 0.62]] },
  { view: 'front', mat: 'chrome', off: 0.007, pts: circle(0.52, 0.685, 0.035, 12) },
  { view: 'front', mat: 'chrome', off: 0.007, pts: circle(0.66, 0.70, 0.035, 12) },
  { view: 'side', mat: 'head', off: 0.004, pts: [[4.30, 0.83], [4.55, 0.80], [4.74, 0.74], [4.75, 0.68], [4.58, 0.70], [4.38, 0.77]] },
  { view: 'front', mat: 'black', off: 0.004, pts: [[0, 0.47], [0.50, 0.475], [0.58, 0.33], [0, 0.305]] },
  { view: 'front', mat: 'chrome', off: 0.006, pts: circle(0.66, 0.405, 0.05, 14) },
  { view: 'front', mat: 'head', off: 0.008, pts: circle(0.66, 0.405, 0.036, 14) },
  { view: 'front', mat: 'plate', off: 0.007, pts: [[0, 0.47], [0.155, 0.47], [0.155, 0.40], [0, 0.40]] },
  // rear: wraparound tail lamps, chrome trunk strip, plate in bumper
  { view: 'rear', mat: 'tail', off: 0.004, pts: [[0.40, 0.93], [0.70, 0.94], [0.84, 0.90], [0.86, 0.80], [0.60, 0.785], [0.42, 0.82]] },
  { view: 'rear', mat: 'chrome', off: 0.007, pts: [[0, 0.875], [0.40, 0.885], [0.40, 0.865], [0, 0.855]] },
  { view: 'side', mat: 'tail', off: 0.004, pts: [[-0.02, 0.94], [0.20, 0.955], [0.26, 0.93], [0.20, 0.86], [-0.02, 0.80]] },
  { view: 'rear', mat: 'black', off: 0.004, pts: [[0, 0.66], [0.22, 0.66], [0.22, 0.50], [0, 0.50]] },
  { view: 'rear', mat: 'plate', off: 0.007, pts: [[0, 0.645], [0.155, 0.645], [0.155, 0.52], [0, 0.52]] },
  { view: 'rear', mat: 'black', off: 0.004, pts: [[0, 0.38], [0.70, 0.385], [0.76, 0.32], [0, 0.31]] },
  { view: 'rear', mat: 'chrome', off: 0.006, pts: circle(0.42, 0.35, 0.04, 12) },
  // seams, body-colour handles, rising side character line
  { view: 'side', mat: 'seam', off: 0.002, pts: strip([[2.165, 0.96], [2.165, 0.24]], 0.006) },
  { view: 'side', mat: 'seam', off: 0.002, pts: strip([[1.08, 1.0], [1.12, 0.80], [1.30, 0.66], [1.40, 0.55], [1.41, 0.34]], 0.006) },
  { view: 'side', mat: 'seam', off: 0.002, pts: strip([[3.47, 0.95], [3.52, 0.75], [3.50, 0.55]], 0.006) },
  { view: 'side', mat: 'trim', off: 0.005, pts: rect(1.80, 0.87, 0.15, 0.03) },
  { view: 'side', mat: 'trim', off: 0.005, pts: rect(2.95, 0.87, 0.15, 0.03) },
  { view: 'side', mat: 'line', off: 0.0015, pts: strip([[0.20, 0.805], [1.5, 0.79], [3.0, 0.745], [4.2, 0.72]], 0.008) },
  { view: 'side', mat: 'black', off: 0.002, pts: strip([[1.40, 0.255], [3.45, 0.255]], 0.035) },
];

// Two-door coupe: ~4.6 m, 1.36 m tall, long doors, fastback roof sloping into a short deck.
const COUPE = {
  id: 'coupe', name: 'Coupe',
  L: 4.60, hwMax: 0.90, axles: [0.98, 3.68], tireR: 0.330, tireW: 0.245, rimR: 0.240, track: 1.56, archR: 0.38,
  U: [[0, 0.62], [0.04, 0.83], [0.12, 0.93], [0.40, 0.97], [0.62, 1.00], [0.95, 1.13], [1.30, 1.28], [1.70, 1.355], [2.10, 1.365],
      [2.45, 1.335], [2.70, 1.25], [2.98, 1.08], [3.28, 0.95], [3.70, 0.88], [4.10, 0.82], [4.38, 0.74], [4.53, 0.65], [4.60, 0.54]],
  B: [[0, 0.62], [0.1, 0.93], [0.5, 0.975], [1.0, 0.985], [2.0, 0.95], [2.9, 0.925], [3.35, 0.94]],
  bot: [[0, 0.42], [0.12, 0.31], [0.40, 0.22], [0.6, 0.19], [4.15, 0.19], [4.42, 0.205], [4.55, 0.28], [4.60, 0.40]],
  hw: [[0, 0.74], [0.07, 0.84], [0.22, 0.89], [0.6, 0.90], [3.75, 0.90], [4.15, 0.88], [4.42, 0.81], [4.55, 0.71], [4.60, 0.60]],
  inset: 0.20, crown: 0.06, rail: 0.045,
  windows: [ { b: [1.20, 1.80], t: [1.62, 1.80] }, { b: [1.90, 3.20], t: [1.90, 2.62] } ],
  blackPillars: [[1.80, 1.90]],
  windshield: [2.62, 3.28], backlight: [0.66, 1.62],
  wheel: { spokes: 5, style: 'bold', finish: 'bright' },
  mirror: { x: 3.14, y: 0.97, len: 0.15, h: 0.10, mat: 'paint' },
  defaultColor: '#8a8f98',
};
COUPE.decals = [
  // low wide grille, slim headlamps, big lower intake
  { view: 'front', mat: 'black', off: 0.004, pts: [[0, 0.66], [0.34, 0.665], [0.33, 0.57], [0, 0.555]] },
  { view: 'front', mat: 'chrome', off: 0.007, pts: [[0, 0.668], [0.345, 0.673], [0.345, 0.662], [0, 0.657]] },
  { view: 'front', mat: 'head', off: 0.004, pts: [[0.36, 0.69], [0.62, 0.72], [0.80, 0.735], [0.85, 0.70], [0.80, 0.655], [0.58, 0.64], [0.37, 0.625]] },
  { view: 'side', mat: 'head', off: 0.004, pts: [[4.15, 0.80], [4.38, 0.77], [4.54, 0.71], [4.55, 0.66], [4.40, 0.68], [4.22, 0.75]] },
  { view: 'front', mat: 'black', off: 0.004, pts: [[0, 0.45], [0.56, 0.455], [0.62, 0.32], [0, 0.29]] },
  { view: 'front', mat: 'plate', off: 0.007, pts: [[0, 0.52], [0.155, 0.52], [0.155, 0.45], [0, 0.45]] },
  // rear: full-width slim tail lamps, plate, diffuser
  { view: 'rear', mat: 'tail', off: 0.004, pts: [[0.12, 0.93], [0.70, 0.945], [0.86, 0.91], [0.87, 0.85], [0.70, 0.86], [0.12, 0.875]] },
  { view: 'side', mat: 'tail', off: 0.004, pts: [[-0.02, 0.945], [0.18, 0.96], [0.24, 0.935], [0.18, 0.885], [-0.02, 0.87]] },
  { view: 'rear', mat: 'black', off: 0.004, pts: [[0, 0.68], [0.22, 0.68], [0.22, 0.52], [0, 0.52]] },
  { view: 'rear', mat: 'plate', off: 0.007, pts: [[0, 0.665], [0.155, 0.665], [0.155, 0.54], [0, 0.54]] },
  { view: 'rear', mat: 'black', off: 0.004, pts: [[0, 0.37], [0.74, 0.375], [0.80, 0.30], [0, 0.29]] },
  { view: 'rear', mat: 'chrome', off: 0.006, pts: circle(0.55, 0.34, 0.045, 12) },
  // one long door, flush handle, side character line
  { view: 'side', mat: 'seam', off: 0.002, pts: strip([[1.88, 0.96], [1.90, 0.60], [1.86, 0.25]], 0.006) },
  { view: 'side', mat: 'seam', off: 0.002, pts: strip([[3.20, 0.93], [3.26, 0.72], [3.24, 0.50]], 0.006) },
  { view: 'side', mat: 'trim', off: 0.005, pts: rect(2.30, 0.86, 0.16, 0.03) },
  { view: 'side', mat: 'line', off: 0.0015, pts: strip([[0.25, 0.81], [1.6, 0.79], [3.0, 0.74], [4.0, 0.70]], 0.008) },
  { view: 'side', mat: 'black', off: 0.002, pts: strip([[1.38, 0.245], [3.30, 0.245]], 0.035) },
];

// Five-door hatchback: ~4.3 m, 1.46 m tall, roof carried to a steep rear hatch.
const HATCHBACK = {
  id: 'hatchback', name: 'Hatchback',
  L: 4.30, hwMax: 0.89, axles: [0.70, 3.32], tireR: 0.315, tireW: 0.205, rimR: 0.21, track: 1.52, archR: 0.36,
  U: [[0, 0.98], [0.05, 1.10], [0.14, 1.24], [0.27, 1.345], [0.45, 1.41], [0.9, 1.45], [1.55, 1.46], [1.95, 1.43], [2.22, 1.33],
      [2.52, 1.13], [2.82, 0.96], [3.25, 0.87], [3.70, 0.81], [4.02, 0.74], [4.20, 0.65], [4.30, 0.52]],
  B: [[0, 0.98], [0.08, 0.99], [0.4, 0.995], [1.5, 0.975], [2.5, 0.935], [2.95, 0.93]],
  bot: [[0, 0.40], [0.08, 0.32], [0.30, 0.22], [0.5, 0.185], [3.75, 0.185], [4.05, 0.20], [4.22, 0.27], [4.30, 0.38]],
  hw: [[0, 0.80], [0.05, 0.85], [0.18, 0.88], [0.5, 0.89], [3.4, 0.89], [3.8, 0.87], [4.05, 0.82], [4.22, 0.73], [4.30, 0.60]],
  inset: 0.16, crown: 0.05, rail: 0.06,
  windows: [ { b: [0.20, 0.58], t: [0.46, 0.58] }, { b: [0.68, 1.58], t: [0.68, 1.58] }, { b: [1.68, 2.70], t: [1.68, 2.14] } ],
  blackPillars: [[0.58, 0.68], [1.58, 1.68]],
  windshield: [2.16, 2.82], backlight: [0.03, 0.44],
  wheel: { spokes: 7, style: 'thin', finish: 'silver' },
  mirror: { x: 2.66, y: 0.98, len: 0.15, h: 0.10, mat: 'paint' },
  defaultColor: '#8a8f98',
};
HATCHBACK.decals = [
  { view: 'front', mat: 'black', off: 0.004, pts: [[0, 0.68], [0.30, 0.69], [0.29, 0.60], [0, 0.59]] },
  { view: 'front', mat: 'chrome', off: 0.007, pts: [[0, 0.70], [0.31, 0.71], [0.31, 0.695], [0, 0.685]] },
  { view: 'front', mat: 'head', off: 0.004, pts: [[0.33, 0.72], [0.58, 0.75], [0.76, 0.76], [0.82, 0.72], [0.76, 0.66], [0.55, 0.65], [0.34, 0.64]] },
  { view: 'side', mat: 'head', off: 0.004, pts: [[3.80, 0.80], [4.02, 0.77], [4.19, 0.71], [4.21, 0.66], [4.05, 0.68], [3.88, 0.75]] },
  { view: 'front', mat: 'black', off: 0.004, pts: [[0, 0.46], [0.50, 0.465], [0.56, 0.33], [0, 0.31]] },
  { view: 'front', mat: 'plate', off: 0.007, pts: [[0, 0.54], [0.155, 0.54], [0.155, 0.47], [0, 0.47]] },
  // rear: tall corner lamps beside the hatch glass, plate on the hatch, bumper
  { view: 'rear', mat: 'tail', off: 0.004, pts: [[0.56, 1.02], [0.78, 1.00], [0.82, 0.90], [0.78, 0.84], [0.56, 0.86]] },
  { view: 'side', mat: 'tail', off: 0.004, pts: [[-0.01, 1.02], [0.10, 1.06], [0.14, 0.96], [0.08, 0.86], [-0.01, 0.85]] },
  { view: 'rear', mat: 'black', off: 0.004, pts: [[0, 0.86], [0.22, 0.86], [0.22, 0.70], [0, 0.70]] },
  { view: 'rear', mat: 'plate', off: 0.007, pts: [[0, 0.845], [0.155, 0.845], [0.155, 0.72], [0, 0.72]] },
  { view: 'rear', mat: 'black', off: 0.004, pts: [[0, 0.40], [0.74, 0.40], [0.80, 0.33], [0, 0.32]] },
  // 4 doors + hatch seams, handles
  { view: 'side', mat: 'seam', off: 0.002, pts: strip([[0.62, 0.98], [0.66, 0.70], [0.70, 0.52], [0.74, 0.32]], 0.006) },
  { view: 'side', mat: 'seam', off: 0.002, pts: strip([[1.63, 0.98], [1.63, 0.23]], 0.006) },
  { view: 'side', mat: 'seam', off: 0.002, pts: strip([[2.70, 0.94], [2.75, 0.74], [2.73, 0.52]], 0.006) },
  { view: 'side', mat: 'trim', off: 0.005, pts: rect(1.30, 0.88, 0.14, 0.03) },
  { view: 'side', mat: 'trim', off: 0.005, pts: rect(2.38, 0.87, 0.14, 0.03) },
  { view: 'side', mat: 'line', off: 0.0015, pts: strip([[0.15, 0.80], [1.6, 0.79], [3.0, 0.76], [3.9, 0.74]], 0.008) },
  { view: 'side', mat: 'black', off: 0.002, pts: strip([[1.08, 0.24], [2.95, 0.24]], 0.035) },
];

// Minivan: ~5.15 m, 1.7 m tall, sliding rear door, three side windows, roof rails.
const MINIVAN = {
  id: 'minivan', name: 'Minivan',
  L: 5.151, hwMax: 0.995, axles: [1.09, 4.168], tireR: 0.362, tireW: 0.225, rimR: 0.222, track: 1.655, archR: 0.415,
  U: [[0, 0.98], [0.03, 1.14], [0.08, 1.38], [0.14, 1.58], [0.22, 1.665], [0.42, 1.705], [2.6, 1.715], [3.02, 1.705], [3.22, 1.665],
      [3.48, 1.52], [3.84, 1.29], [4.20, 1.105], [4.55, 1.04], [4.88, 0.97], [5.06, 0.88], [5.151, 0.72]],
  B: [[0, 0.98], [0.12, 1.02], [0.4, 1.045], [1.2, 1.04], [3.0, 1.035], [3.9, 1.06], [4.25, 1.10]],
  bot: [[0, 0.40], [0.10, 0.32], [0.35, 0.25], [0.6, 0.205], [4.55, 0.205], [4.85, 0.215], [5.05, 0.26], [5.151, 0.38]],
  hw: [[0, 0.86], [0.05, 0.94], [0.18, 0.98], [0.5, 0.995], [4.35, 0.995], [4.75, 0.97], [4.98, 0.905], [5.09, 0.81], [5.151, 0.67]],
  inset: 0.13, crown: 0.035, rail: 0.085,
  windows: [ { b: [0.20, 1.33], t: [0.30, 1.30] }, { b: [1.44, 2.55], t: [1.42, 2.55] }, { b: [2.69, 3.98], t: [2.69, 3.24] } ],
  blackPillars: [[1.33, 1.44], [2.55, 2.69]],
  windshield: [3.22, 4.20], backlight: [0.025, 0.215],
  wheel: { spokes: 10, style: 'thin', finish: 'silver' },
  roofRails: { x0: 0.55, x1: 2.95, y: 1.755, z: 0.80 },
  mirror: { x: 3.98, y: 1.12, len: 0.17, h: 0.12, mat: 'paint' },
  beltChrome: { x0: 0.20, x1: 3.98 },
  defaultColor: '#8a8f98',
};
MINIVAN.decals = [
  // upright chrome-framed grille with bars, swept headlamps, black lower intake + fogs
  { view: 'front', mat: 'chrome', off: 0.004, pts: [[0, 0.835], [0.40, 0.815], [0.455, 0.735], [0.40, 0.55], [0, 0.535]] },
  { view: 'front', mat: 'black', off: 0.007, pts: [[0, 0.80], [0.37, 0.785], [0.415, 0.725], [0.37, 0.575], [0, 0.565]] },
  ...[0.75, 0.70, 0.65, 0.60].map(v => ({ view: 'front', mat: 'chrome', off: 0.010, pts: [[0, v + 0.012], [0.40 - (0.75 - v) * 0.1, v + 0.012], [0.40 - (0.75 - v) * 0.1, v - 0.006], [0, v - 0.006]] })),
  { view: 'front', mat: 'head', off: 0.004, pts: [[0.43, 0.84], [0.62, 0.885], [0.80, 0.895], [0.90, 0.87], [0.89, 0.79], [0.70, 0.765], [0.47, 0.75]] },
  { view: 'front', mat: 'chrome', off: 0.007, pts: [[0.53, 0.835], [0.64, 0.86], [0.66, 0.80], [0.55, 0.79]] },
  { view: 'side', mat: 'head', off: 0.004, pts: [[4.80, 0.965], [5.0, 0.92], [5.13, 0.84], [5.12, 0.79], [4.98, 0.81], [4.84, 0.90]] },
  { view: 'front', mat: 'black', off: 0.004, pts: [[0, 0.44], [0.50, 0.445], [0.56, 0.34], [0, 0.315]] },
  { view: 'front', mat: 'chrome', off: 0.006, pts: circle(0.66, 0.40, 0.045, 14) },
  { view: 'front', mat: 'plate', off: 0.006, pts: [[0, 0.52], [0.155, 0.52], [0.155, 0.445], [0, 0.445]] },
  // rear: tall wraparound tail lamps, chrome liftgate bar, plate recess
  { view: 'rear', mat: 'tail', off: 0.004, pts: [[0.76, 1.42], [0.93, 1.36], [0.96, 1.10], [0.92, 0.84], [0.80, 0.84], [0.78, 1.10]] },
  { view: 'side', mat: 'tail', off: 0.004, pts: [[0.02, 1.40], [0.14, 1.36], [0.15, 1.10], [0.10, 0.86], [0.02, 0.84]] },
  { view: 'rear', mat: 'chrome', off: 0.005, pts: [[0, 0.93], [0.58, 0.935], [0.58, 0.905], [0, 0.90]] },
  { view: 'rear', mat: 'black', off: 0.004, pts: [[0, 0.89], [0.24, 0.89], [0.24, 0.72], [0, 0.72]] },
  { view: 'rear', mat: 'plate', off: 0.007, pts: [[0, 0.87], [0.155, 0.87], [0.155, 0.74], [0, 0.74]] },
  { view: 'rear', mat: 'black', off: 0.004, pts: [[0, 0.40], [0.80, 0.40], [0.84, 0.33], [0, 0.33]] },
  // sliding-door track, door seams, handles, rocker
  { view: 'side', mat: 'black', off: 0.003, pts: strip([[0.42, 1.005], [1.38, 1.015]], 0.012) },
  { view: 'side', mat: 'seam', off: 0.002, pts: strip([[1.385, 1.0], [1.385, 0.32]], 0.006) },
  { view: 'side', mat: 'seam', off: 0.002, pts: strip([[2.62, 1.03], [2.62, 0.25]], 0.006) },
  { view: 'side', mat: 'seam', off: 0.002, pts: strip([[4.02, 1.07], [4.06, 0.80], [4.02, 0.62]], 0.006) },
  { view: 'side', mat: 'chrome', off: 0.006, pts: rect(2.40, 0.905, 0.17, 0.035) },
  { view: 'side', mat: 'chrome', off: 0.006, pts: rect(3.50, 0.915, 0.17, 0.035) },
  { view: 'side', mat: 'black', off: 0.002, pts: strip([[0.35, 0.40], [4.62, 0.40]], 0.03) },
];

// Mid-size SUV: ~4.8 m, 1.75 m tall, upright nose, high ground clearance, big tires, boxy greenhouse, roof rails.
const SUV = {
  id: 'suv', name: 'SUV',
  L: 4.80, hwMax: 0.95, axles: [1.00, 3.82], tireR: 0.372, tireW: 0.245, rimR: 0.245, track: 1.64, archR: 0.435,
  U: [[0, 1.00], [0.03, 1.25], [0.07, 1.52], [0.13, 1.66], [0.25, 1.72], [0.6, 1.74], [2.6, 1.745], [2.92, 1.72], [3.12, 1.62],
      [3.40, 1.40], [3.62, 1.25], [4.00, 1.20], [4.40, 1.15], [4.64, 1.08], [4.76, 0.97], [4.80, 0.82]],
  B: [[0, 1.00], [0.1, 1.08], [0.4, 1.10], [1.5, 1.10], [3.0, 1.09], [3.45, 1.12], [3.65, 1.16]],
  bot: [[0, 0.54], [0.10, 0.45], [0.35, 0.37], [0.6, 0.31], [4.2, 0.31], [4.5, 0.34], [4.70, 0.42], [4.80, 0.52]],
  hw: [[0, 0.88], [0.05, 0.93], [0.2, 0.95], [0.5, 0.95], [4.2, 0.95], [4.55, 0.93], [4.72, 0.88], [4.80, 0.80]],
  inset: 0.12, crown: 0.03, rail: 0.07,
  windows: [ { b: [0.17, 1.02], t: [0.28, 1.02] }, { b: [1.12, 2.06], t: [1.12, 2.06] }, { b: [2.16, 3.38], t: [2.16, 2.92] } ],
  blackPillars: [[1.02, 1.12], [2.06, 2.16]],
  windshield: [2.92, 3.62], backlight: [0.02, 0.17],
  claddingY: [[0, 0.66], [0.4, 0.62], [4.4, 0.62], [4.80, 0.66]],
  wheel: { spokes: 6, style: 'truck', finish: 'silver' },
  roofRails: { x0: 0.45, x1: 2.65, y: 1.79, z: 0.76 },
  mirror: { x: 3.42, y: 1.18, len: 0.19, h: 0.14, mat: 'black' },
  flares: true,
  defaultColor: '#8a8f98',
};
SUV.decals = [
  // tall grille with chrome bars, squared headlamps, skid plate, plate
  { view: 'front', mat: 'black', off: 0.004, pts: [[0, 1.02], [0.42, 1.02], [0.44, 0.78], [0, 0.77]] },
  ...[0.96, 0.89, 0.82].map(v => ({ view: 'front', mat: 'chrome', off: 0.008, pts: [[0, v + 0.01], [0.42, v + 0.01], [0.42, v - 0.008], [0, v - 0.008]] })),
  { view: 'front', mat: 'head', off: 0.004, pts: [[0.46, 1.03], [0.82, 1.04], [0.88, 0.99], [0.86, 0.90], [0.46, 0.90]] },
  { view: 'front', mat: 'amber', off: 0.006, pts: [[0.48, 0.90], [0.86, 0.90], [0.86, 0.875], [0.48, 0.875]] },
  { view: 'side', mat: 'head', off: 0.004, pts: [[4.52, 1.12], [4.70, 1.08], [4.78, 0.98], [4.74, 0.93], [4.55, 0.98]] },
  { view: 'front', mat: 'black', off: 0.006, pts: [[0, 0.66], [0.62, 0.66], [0.66, 0.50], [0, 0.48]] },
  { view: 'front', mat: 'chrome', off: 0.008, pts: [[0, 0.52], [0.40, 0.52], [0.40, 0.49], [0, 0.49]] },
  { view: 'front', mat: 'plate', off: 0.009, pts: [[0, 0.74], [0.155, 0.74], [0.155, 0.67], [0, 0.67]] },
  // rear: vertical lamps beside the liftgate glass, plate, bumper
  { view: 'rear', mat: 'tail', off: 0.004, pts: [[0.66, 1.26], [0.86, 1.24], [0.88, 0.95], [0.66, 0.95]] },
  { view: 'side', mat: 'tail', off: 0.004, pts: [[-0.01, 1.26], [0.10, 1.25], [0.12, 0.96], [-0.01, 0.95]] },
  { view: 'rear', mat: 'black', off: 0.004, pts: [[0, 0.94], [0.22, 0.94], [0.22, 0.78], [0, 0.78]] },
  { view: 'rear', mat: 'plate', off: 0.007, pts: [[0, 0.925], [0.155, 0.925], [0.155, 0.80], [0, 0.80]] },
  { view: 'rear', mat: 'chrome', off: 0.006, pts: [[0, 1.02], [0.55, 1.02], [0.55, 0.995], [0, 0.995]] },
  // doors, handles
  { view: 'side', mat: 'seam', off: 0.002, pts: strip([[1.07, 1.08], [1.10, 0.80], [1.16, 0.62]], 0.006) },
  { view: 'side', mat: 'seam', off: 0.002, pts: strip([[2.11, 1.09], [2.11, 0.62]], 0.006) },
  { view: 'side', mat: 'seam', off: 0.002, pts: strip([[3.38, 1.10], [3.42, 0.85], [3.40, 0.62]], 0.006) },
  { view: 'side', mat: 'black', off: 0.006, pts: rect(1.78, 1.00, 0.16, 0.035) },
  { view: 'side', mat: 'black', off: 0.006, pts: rect(2.95, 1.00, 0.16, 0.035) },
];

// Crew-cab pickup: ~5.6 m, 1.86 m tall, short open bed, dark-gray lower trim and fender flares.
const PICKUP = {
  id: 'pickup', name: 'Pickup',
  L: 5.631, hwMax: 1.0, axles: [1.39, 4.692], tireR: 0.389, tireW: 0.265, rimR: 0.215, track: 1.73, archR: 0.455,
  U: [[0, 1.17], [0.04, 1.225], [0.5, 1.235], [1.60, 1.24], [1.64, 1.40], [1.67, 1.70], [1.73, 1.815], [1.85, 1.855], [3.30, 1.862],
      [3.50, 1.835], [3.85, 1.56], [4.22, 1.305], [4.5, 1.275], [5.1, 1.235], [5.45, 1.195], [5.585, 1.13], [5.631, 1.0]],
  B: [[0, 1.17], [0.04, 1.225], [1.60, 1.24], [2.5, 1.245], [3.6, 1.255], [4.2, 1.29]],
  bot: [[0, 0.50], [0.08, 0.46], [0.45, 0.44], [5.2, 0.44], [5.5, 0.43], [5.631, 0.50]],
  hw: [[0, 0.935], [0.05, 0.985], [0.25, 1.0], [5.2, 1.0], [5.45, 0.975], [5.585, 0.93], [5.631, 0.88]],
  inset: 0.115, crown: 0.03, rail: 0.065,
  windows: [ { b: [1.82, 2.83], t: [1.90, 2.83] }, { b: [2.94, 4.12], t: [2.94, 3.50] } ],
  blackPillars: [[2.83, 2.94]],
  windshield: [3.50, 4.22], backlight: [1.63, 1.72],
  claddingY: [[0, 0.62], [0.3, 0.66], [5.3, 0.66], [5.631, 0.64]],
  bed: { x0: 0.04, x1: 1.61, liner: true },
  wheel: { spokes: 6, style: 'truck', finish: 'silver' },
  mirror: { x: 4.08, y: 1.36, len: 0.24, h: 0.20, mat: 'black' },
  flares: true,
  defaultColor: '#8a8f98',
};
PICKUP.decals = [
  // big black grille with chrome bars, square headlamps with amber strip, fogs, plate
  { view: 'front', mat: 'black', off: 0.004, pts: [[0, 1.085], [0.47, 1.085], [0.47, 0.84], [0, 0.84]] },
  ...[1.05, 0.965, 0.88].map(v => ({ view: 'front', mat: 'chrome', off: 0.007, pts: [[0, v + 0.006], [0.46, v + 0.006], [0.46, v - 0.006], [0, v - 0.006]] })),
  { view: 'front', mat: 'head', off: 0.004, pts: [[0.49, 1.09], [0.90, 1.09], [0.93, 1.05], [0.93, 0.90], [0.49, 0.90]] },
  { view: 'front', mat: 'chrome', off: 0.007, pts: [[0.50, 1.08], [0.70, 1.08], [0.70, 0.95], [0.50, 0.95]] },
  { view: 'front', mat: 'amber', off: 0.006, pts: [[0.49, 0.90], [0.93, 0.90], [0.93, 0.86], [0.49, 0.86]] },
  { view: 'side', mat: 'amber', off: 0.004, pts: [[5.50, 1.07], [5.62, 1.07], [5.62, 0.92], [5.52, 0.92]] },
  { view: 'front', mat: 'black', off: 0.006, pts: [[0, 0.72], [0.40, 0.72], [0.42, 0.60], [0, 0.60]] },
  { view: 'front', mat: 'chrome', off: 0.006, pts: circle(0.70, 0.64, 0.06, 14) },
  { view: 'front', mat: 'head', off: 0.009, pts: circle(0.70, 0.64, 0.045, 14) },
  { view: 'front', mat: 'plate', off: 0.008, pts: [[0, 0.58], [0.155, 0.58], [0.155, 0.50], [0, 0.50]] },
  // rear: tall vertical tail lamps, tailgate handle, step bumper, plate
  { view: 'rear', mat: 'tail', off: 0.004, pts: [[0.80, 1.18], [0.97, 1.18], [0.98, 0.78], [0.80, 0.78]] },
  { view: 'rear', mat: 'head', off: 0.007, pts: [[0.83, 0.98], [0.95, 0.98], [0.95, 0.90], [0.83, 0.90]] },
  { view: 'side', mat: 'tail', off: 0.004, pts: [[-0.02, 1.18], [0.05, 1.18], [0.05, 0.78], [-0.02, 0.78]] },
  { view: 'rear', mat: 'black', off: 0.004, pts: [[0, 1.14], [0.14, 1.14], [0.14, 1.09], [0, 1.09]] },
  { view: 'rear', mat: 'chrome', off: 0.03, pts: [[0, 0.72], [0.99, 0.72], [0.99, 0.48], [0, 0.48]] },
  { view: 'rear', mat: 'plate', off: 0.034, pts: [[0, 0.66], [0.155, 0.66], [0.155, 0.53], [0, 0.53]] },
  // seams and black handles
  { view: 'side', mat: 'seam', off: 0.002, pts: strip([[2.885, 1.24], [2.885, 0.66]], 0.006) },
  { view: 'side', mat: 'seam', off: 0.002, pts: strip([[1.80, 1.24], [1.80, 0.66]], 0.006) },
  { view: 'side', mat: 'seam', off: 0.002, pts: strip([[1.62, 1.235], [1.62, 0.66]], 0.006) },
  { view: 'side', mat: 'seam', off: 0.002, pts: strip([[4.13, 1.28], [4.16, 0.95], [4.13, 0.66]], 0.006) },
  { view: 'side', mat: 'black', off: 0.006, pts: rect(2.55, 1.105, 0.17, 0.04) },
  { view: 'side', mat: 'black', off: 0.006, pts: rect(3.80, 1.11, 0.17, 0.04) },
];

export const SPECS = { sedan: SEDAN, coupe: COUPE, hatchback: HATCHBACK, minivan: MINIVAN, suv: SUV, pickup: PICKUP };
export const BODY_STYLES = Object.keys(SPECS);
const STYLE_ALIASES = { van: 'minivan', truck: 'pickup', crossover: 'suv', wagon: 'hatchback', hatch: 'hatchback', convertible: 'coupe' };

/** Which procedural body style to show for a car row (by body_type; unknown -> sedan). */
export function specFor(car) {
  const t = String(car?.body_type || '').toLowerCase().trim();
  return SPECS[t] || SPECS[STYLE_ALIASES[t]] || SEDAN;
}

// ---------------------------------------------------------------- 2D helpers for decal outlines
function circle(cu, cv, r, n) { return Array.from({ length: n }, (_, i) => [cu + r * Math.cos((i / n) * Math.PI * 2), cv + r * Math.sin((i / n) * Math.PI * 2)]); }
function rect(u, v, w, h) { return [[u - w / 2, v + h / 2], [u + w / 2, v + h / 2], [u + w / 2, v - h / 2], [u - w / 2, v - h / 2]]; }
function strip(pts, width) {
  const L = [], R = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1]; const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
    L.push([pts[i][0] - dy * width / 2, pts[i][1] + dx * width / 2]);
    R.push([pts[i][0] + dy * width / 2, pts[i][1] - dx * width / 2]);
  }
  return L.concat(R.reverse());
}
function inPoly(pts, u, v) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ui, vi] = pts[i], [uj, vj] = pts[j];
    if ((vi > v) !== (vj > v) && u < ((uj - ui) * (v - vi)) / (vj - vi) + ui) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------- body loft
const MATS = ['paint', 'glass', 'black', 'under', 'cladding'];

function prepare(S) {
  if (S._f) return S._f;
  const f = { U: curve(S.U), B: curve(S.B), bot: curve(S.bot), hw: curve(S.hw), clad: S.claddingY ? curve(S.claddingY) : null };
  f.cy = S.tireR;
  S._f = f;
  return f;
}

/** Half cross-section at station x: [[z,y]...] bottom-centre -> top-centre, plus band heights. */
function section(S, x) {
  const f = prepare(S);
  const w = f.hw(x), U = f.U(x), B = Math.min(f.B(x), U);
  const gh = U - B, k = smooth(gh / 0.3);
  let yb = f.bot(x);
  for (const ax of S.axles) { const dx = x - ax; if (Math.abs(dx) < S.archR) yb = Math.max(yb, f.cy + Math.sqrt(S.archR * S.archR - dx * dx)); }
  yb = Math.min(yb, B - 0.05);
  const rail = Math.min(S.rail, gh * 0.45);
  const Wt = U - rail;
  const inset = S.inset * k;
  const y0 = Math.min(yb + 0.07, B);
  const pts = [[0, yb], [w * 0.80, yb], [w * 0.945, yb + 0.025]];
  for (let q = 0; q <= 6; q++) { const t = q / 6; pts.push([w * (0.955 + 0.045 * Math.sin(Math.PI * (0.15 + 0.7 * t))), lerp(y0, B, t)]); }
  const zg = w * 0.972;
  pts.push([zg - inset * 0.55, lerp(B, Wt, 0.5)]);
  pts.push([zg - inset, Wt]);
  const zr = zg - inset - 0.04 * (0.4 + 0.6 * k);
  pts.push([zr, U - S.crown * 0.1]);
  pts.push([zr * 0.78, U + S.crown * 0.55]);
  pts.push([zr * 0.42, U + S.crown * 0.88]);
  pts.push([0, U + S.crown]);
  return { pts, B, U, Wt, yb, w };
}
// segment index (half ring) -> band
const SEG_BAND = ['under', 'under', 'side', 'side', 'side', 'side', 'side', 'side', 'side', 'green', 'green', 'rail', 'cap', 'cap', 'cap'];

function faceMat(S, band, x, y, sec) {
  const f = prepare(S);
  if (band === 'under') return 'under';
  if (band === 'side') return f.clad && y < f.clad(x) ? 'cladding' : 'paint';
  if (band === 'green') {
    if (sec.Wt - sec.B < 0.02) return 'paint';
    const t = (y - sec.B) / Math.max(0.001, sec.Wt - sec.B);
    for (const wnd of S.windows) if (x > lerp(wnd.b[0], wnd.t[0], t) && x < lerp(wnd.b[1], wnd.t[1], t)) return 'glass';
    for (const [a, b] of S.blackPillars || []) if (x > a && x < b) return 'black';
    return 'paint';
  }
  if (band === 'rail') return 'paint';
  if (x > S.windshield[0] && x < S.windshield[1]) return 'glass';
  if (S.backlight && x > S.backlight[0] && x < S.backlight[1]) return 'glass';
  if (S.bed && x > S.bed.x0 && x < S.bed.x1) return S.bed.liner ? 'under' : 'cladding';
  return 'paint';
}

function buildBody(S) {
  const main = [];
  const step = 0.025;
  for (let x = 0; x < S.L; x += step) main.push(x);
  main.push(S.L);
  const HALF = 16, RING = 30;
  const ringOf = sec => sec.pts.concat(sec.pts.slice(1, HALF - 1).reverse().map(([z, y]) => [-z, y]));
  // rounded bumpers: a few shrinking rings past each end (scaled about the end section's centre)
  const DOME = [[0.014, 0.94], [0.032, 0.80], [0.048, 0.58], [0.058, 0.30]];
  const domeRings = (x0, dir) => {
    const sec = section(S, x0), ring = ringOf(sec);
    const cy = ring.reduce((a, p) => a + p[1], 0) / ring.length;
    return DOME.map(([dx, sc]) => ({ x: x0 + dir * dx, sec, pts: ring.map(([z, y]) => [z * sc, cy + (y - cy) * sc]) }));
  };
  const rings = [...domeRings(0, -1).reverse(), ...main.map(x => { const sec = section(S, x); return { x, sec, pts: ringOf(sec) }; }), ...domeRings(S.L, 1)];
  const xs = rings.map(r => r.x);
  const pos = new Float32Array(rings.length * RING * 3);
  const secs = rings.map(r => r.sec);
  rings.forEach((r, i) => r.pts.forEach(([z, y], j) => { const o = (i * RING + j) * 3; pos[o] = r.x; pos[o + 1] = y; pos[o + 2] = z; }));
  const buckets = Object.fromEntries(MATS.map(m => [m, []]));
  const bands = []; // per station gap: triangle list (for decal ray casting)
  const V = (i, j) => i * RING + (j % RING);
  for (let i = 0; i < xs.length - 1; i++) {
    const tris = [];
    for (let j = 0; j < RING; j++) {
      const a = V(i, j), b = V(i + 1, j), c = V(i + 1, j + 1), d = V(i, j + 1);
      const segHalf = j < HALF - 1 ? j : RING - 1 - j; // mirror index for left side
      const band = SEG_BAND[segHalf];
      const xc = (xs[i] + xs[i + 1]) / 2, yc = (pos[a * 3 + 1] + pos[c * 3 + 1] + pos[b * 3 + 1] + pos[d * 3 + 1]) / 4;
      const m = faceMat(S, band, xc, yc, secs[i]);
      // winding: outward normals
      const t1 = j < HALF - 1 ? [a, b, c] : [a, b, c], t2 = [a, c, d];
      buckets[m].push(...t1, ...t2);
      tris.push(t1, t2);
    }
    bands.push(tris);
  }
  // end caps (fans)
  const capPos = [];
  const capBands = [[], []];
  const nV = xs.length * RING;
  const extra = [];
  [[0, -0.015], [xs.length - 1, 0.015]].forEach(([i, dx], which) => {
    let cy = 0; for (let j = 0; j < RING; j++) cy += pos[(i * RING + j) * 3 + 1]; cy /= RING;
    const ci = nV + which;
    extra.push(xs[i] + dx, cy, 0);
    for (let j = 0; j < RING; j++) {
      const a = V(i, j), b = V(i, j + 1);
      const tri = which === 0 ? [ci, a, b] : [ci, b, a];
      const yc = (pos[a * 3 + 1] + pos[b * 3 + 1] + cy) / 3;
      const f = prepare(S);
      const m = yc < secs[i].yb + 0.04 ? 'under' : f.clad && yc < f.clad(xs[i]) ? 'cladding' : 'paint';
      buckets[m].push(...tri);
      capBands[which].push(tri);
    }
  });
  const all = new Float32Array(pos.length + extra.length);
  all.set(pos); all.set(extra, pos.length);
  const geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.BufferAttribute(all, 3));
  const index = []; let start = 0;
  MATS.forEach((m, mi) => { index.push(...buckets[m]); geo.addGroup(start, buckets[m].length, mi); start += buckets[m].length; });
  geo.setIndex(index);
  geo.computeVertexNormals();
  return { geo, pos: all, xs, bands, capBands, secs };
}

// ---------------------------------------------------------------- ray casting for decals
function rayTri(P, o, d, a, b, c) {
  const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
  const e1x = P[b * 3] - ax, e1y = P[b * 3 + 1] - ay, e1z = P[b * 3 + 2] - az;
  const e2x = P[c * 3] - ax, e2y = P[c * 3 + 1] - ay, e2z = P[c * 3 + 2] - az;
  const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return -1;
  const inv = 1 / det;
  const tx = o[0] - ax, ty = o[1] - ay, tz = o[2] - az;
  const u = (tx * px + ty * py + tz * pz) * inv; if (u < 0 || u > 1) return -1;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv; if (v < 0 || u + v > 1) return -1;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  if (t <= 0) return -1;
  const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const nl = Math.hypot(nx, ny, nz) || 1;
  rayTri.n = [nx / nl, ny / nl, nz / nl];
  return t;
}
function castRay(body, view, u, v) {
  const P = body.pos;
  let o, d, bandIdx;
  const n = body.bands.length;
  if (view === 'side') {
    o = [u, v, 5]; d = [0, 0, -1];
    let i = 0; while (i < n - 1 && body.xs[i + 1] < u) i++;
    bandIdx = [i - 1, i, i + 1].filter(k => k >= 0 && k < n);
  } else if (view === 'front') {
    o = [body.xs[body.xs.length - 1] + 5, v, u]; d = [-1, 0, 0];
    bandIdx = ['capF']; for (let i = n - 1; i >= 0; i--) bandIdx.push(i);
  } else {
    o = [-5, v, u]; d = [1, 0, 0];
    bandIdx = ['capR']; for (let i = 0; i < n; i++) bandIdx.push(i);
  }
  let best = Infinity, bestN = null;
  for (const bi of bandIdx) {
    if (typeof bi === 'number' && view !== 'side' && best < Infinity) {
      // bands are ordered by distance along the ray; stop once a band can't be closer
      const bx = view === 'front' ? body.xs[bi + 1] : body.xs[bi];
      if (Math.abs(bx - o[0]) > best) break;
    }
    const tris = bi === 'capF' ? body.capBands[1] : bi === 'capR' ? body.capBands[0] : body.bands[bi];
    for (const [a, b, c] of tris) {
      const t = rayTri(P, o, d, a, b, c);
      if (t > 0 && t < best) { best = t; bestN = rayTri.n; }
    }
  }
  if (best === Infinity) return null;
  // make the normal face the ray origin
  if (bestN[0] * d[0] + bestN[1] * d[1] + bestN[2] * d[2] > 0) bestN = bestN.map(c => -c);
  return { p: [o[0] + d[0] * best, o[1] + d[1] * best, o[2] + d[2] * best], n: bestN };
}

/** Project a 2D outline onto the body and return a thin surface patch (plus its mirror). */
function decalGeometry(body, dcl) {
  const pts = dcl.pts;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [u, v] of pts) { u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
  const size = Math.max(u1 - u0, v1 - v0);
  const res = size < 0.15 ? 0.003 : size < 0.6 ? 0.005 : 0.009;
  const nu = Math.max(2, Math.min(160, Math.ceil((u1 - u0) / res))), nv = Math.max(2, Math.min(90, Math.ceil((v1 - v0) / res)));
  const du = (u1 - u0) / nu, dv = (v1 - v0) / nv;
  const hits = new Map();
  const hit = (i, j) => {
    const key = i * 1000 + j;
    if (!hits.has(key)) hits.set(key, castRay(body, dcl.view, u0 + i * du, v0 + j * dv));
    return hits.get(key);
  };
  const positions = [];
  const push = h => positions.push(h.p[0] + h.n[0] * dcl.off, h.p[1] + h.n[1] * dcl.off, h.p[2] + h.n[2] * dcl.off);
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    // keep a cell if any of 5 sample points is inside: smoother edges than centre-only
    const uc = u0 + (i + 0.5) * du, vc = v0 + (j + 0.5) * dv;
    if (!inPoly(pts, uc, vc)) continue;
    const a = hit(i, j), b = hit(i + 1, j), c = hit(i + 1, j + 1), d = hit(i, j + 1);
    if (!a || !b || !c || !d) continue;
    // reject cells that straddle a depth jump (e.g. front decal running off the nose onto the hood)
    const depth = h => dcl.view === 'side' ? h.p[2] : h.p[0];
    const ds = [a, b, c, d].map(depth);
    if (Math.max(...ds) - Math.min(...ds) > Math.max(du, dv) * 3.5) continue; // grazing angle -> skip (no stretched shards)
    push(a); push(b); push(c); push(a); push(c); push(d);
  }
  if (!positions.length) return null;
  const out = new Float32Array(positions.length * 2);
  out.set(positions);
  // mirror across z = 0 (body is symmetric) with reversed winding
  const half = positions.length;
  for (let k = 0; k < half; k += 9) for (let q = 0; q < 3; q++) {
    const src = k + [0, 2, 1][q] * 3;
    out[half + k + q * 3] = positions[src]; out[half + k + q * 3 + 1] = positions[src + 1]; out[half + k + q * 3 + 2] = -positions[src + 2];
  }
  return out;
}

// ---------------------------------------------------------------- materials
function paintParams(hex) {
  const c = new T.Color(hex); const hsl = {}; c.getHSL(hsl);
  if (hsl.l > 0.8) return { metalness: 0.05, roughness: 0.38, envMapIntensity: 0.55, clearcoat: 0.8 };       // gloss white
  if (hsl.l < 0.08) return { metalness: 0.35, roughness: 0.22, envMapIntensity: 1.6, clearcoat: 1 };          // gloss black: lean on reflections
  return { metalness: 0.55, roughness: 0.3, envMapIntensity: 1.0, clearcoat: 1 };                              // metallic
}
function makeMaterials(color, S = {}) {
  const m = {
    paint: new T.MeshPhysicalMaterial({ color, clearcoatRoughness: 0.06, ...paintParams(color) }),
    glass: new T.MeshPhysicalMaterial({ color: 0x0b1118, metalness: 0.1, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 0.9 }),
    black: new T.MeshStandardMaterial({ color: 0x101114, roughness: 0.45, metalness: 0.2 }),
    under: new T.MeshStandardMaterial({ color: 0x0a0a0b, roughness: 0.9 }),
    interiorGlb: new T.MeshStandardMaterial({ color: 0x111215, roughness: 0.9, side: T.DoubleSide }),
    cladding: new T.MeshStandardMaterial({ color: S.claddingColor ?? 0x34373c, roughness: 0.7, metalness: 0.05 }),   // plain dark-gray trim
    chrome: new T.MeshStandardMaterial({ color: 0xe6e9ee, metalness: 1, roughness: 0.12 }),
    head: new T.MeshPhysicalMaterial({ color: 0xdfe7ee, emissive: 0xcfe6ff, emissiveIntensity: 0.3, metalness: 0.3, roughness: 0.08, clearcoat: 1 }),
    tail: new T.MeshPhysicalMaterial({ color: 0x7a070c, emissive: 0xff1a1a, emissiveIntensity: 0.45, roughness: 0.15, clearcoat: 1 }),
    amber: new T.MeshPhysicalMaterial({ color: 0xb56a00, emissive: 0xff9a10, emissiveIntensity: 0.35, roughness: 0.15, clearcoat: 1 }),
    plate: new T.MeshStandardMaterial({ color: 0xe9ecef, roughness: 0.5 }),
    seam: new T.MeshStandardMaterial({ color: 0x050506, roughness: 0.9 }),
    tire: new T.MeshStandardMaterial({ color: 0x151517, roughness: 0.92 }),
    rim: new T.MeshStandardMaterial({ color: 0xc3c9d0, metalness: 0.85, roughness: 0.28 }),
    rimBright: new T.MeshStandardMaterial({ color: 0xe8ecf1, metalness: 1, roughness: 0.12 }),
    rimDark: new T.MeshStandardMaterial({ color: 0x3a3e44, metalness: 0.7, roughness: 0.4 }),
    caliper: new T.MeshStandardMaterial({ color: 0x55595f, metalness: 0.5, roughness: 0.5 }),
  };
  m.glass.side = T.DoubleSide;
  m.trim = m.paint; // body-colour trim (handles) shares the paint
  m.line = new T.MeshPhysicalMaterial({ color, metalness: 0.55, roughness: 0.2, clearcoat: 1 });
  for (const k of ['seam', 'plate', 'head', 'tail', 'amber', 'chrome', 'black', 'cladding', 'line']) { m[k].polygonOffset = true; m[k].polygonOffsetFactor = -2; m[k].side = T.DoubleSide; }
  return m;
}

// ---------------------------------------------------------------- parts
function wheelMesh(S, mats) {
  const g = new T.Group();
  const R = S.tireR, r = S.rimR, w = S.tireW;
  // tire: lathe of a rounded cross-section around the axle
  const prof = [];
  const steps = 10;
  prof.push(new T.Vector2(r - 0.01, -w / 2 + 0.02));
  for (let i = 0; i <= steps; i++) {
    const a = -Math.PI / 2 + (i / steps) * Math.PI;
    prof.push(new T.Vector2(R - 0.045 + Math.cos(a) * 0.045, Math.sin(a) * (w / 2)));
  }
  prof.push(new T.Vector2(r - 0.01, w / 2 - 0.02));
  const tire = new T.Mesh(new T.LatheGeometry(prof, 40), mats.tire);
  tire.rotation.x = Math.PI / 2;
  g.add(tire);
  const face = S.wheel.finish === 'bright' ? mats.rimBright : mats.rim;
  const barrel = new T.Mesh(new T.CylinderGeometry(r, r, w * 0.8, 32, 1, true), mats.rimDark);
  barrel.rotation.x = Math.PI / 2; g.add(barrel);
  const back = new T.Mesh(new T.CircleGeometry(r * 0.98, 24), mats.rimDark);
  back.position.z = -w * 0.05; g.add(back);
  const lip = new T.Mesh(new T.TorusGeometry(r - 0.006, 0.009, 6, 40), face);
  lip.position.z = w * 0.36; g.add(lip);
  // brake disc + caliper
  const disc = new T.Mesh(new T.CylinderGeometry(r * 0.78, r * 0.78, 0.025, 24), mats.rimDark);
  disc.rotation.x = Math.PI / 2; disc.position.z = w * 0.05; g.add(disc);
  const cal = new T.Mesh(new T.BoxGeometry(0.09, 0.07, 0.05), mats.caliper);
  cal.position.set(-r * 0.55, r * 0.35, w * 0.12); g.add(cal);
  // spokes
  const n = S.wheel.spokes;
  const spokeW = S.wheel.style === 'thin' ? 0.022 : S.wheel.style === 'bold' ? 0.07 : 0.085;
  const spokeGeo = new T.BoxGeometry(spokeW, r * 0.86, 0.028);
  spokeGeo.translate(0, r * 0.48, 0);
  for (let i = 0; i < n; i++) {
    const sp = new T.Mesh(spokeGeo, face);
    sp.rotation.z = (i / n) * Math.PI * 2;
    sp.position.z = w * 0.33;
    if (S.wheel.style === 'bold') sp.rotation.y = 0.12;
    g.add(sp);
    if (S.wheel.style === 'bold') { // split 5-spoke
      const s2 = new T.Mesh(spokeGeo, face); s2.rotation.z = (i / n) * Math.PI * 2 + 0.16; s2.position.z = w * 0.33; s2.scale.x = 0.45; g.add(s2);
    }
  }
  const hub = new T.Mesh(new T.CylinderGeometry(r * 0.28, r * 0.3, 0.05, 24), face);
  hub.rotation.x = Math.PI / 2; hub.position.z = w * 0.35; g.add(hub);
  const lugs = S.wheel.style === 'truck' ? 6 : 5;
  for (let i = 0; i < lugs; i++) {
    const nut = new T.Mesh(new T.CylinderGeometry(0.011, 0.011, 0.02, 6), mats.chrome);
    const a = (i / lugs) * Math.PI * 2;
    nut.rotation.x = Math.PI / 2; nut.position.set(Math.cos(a) * r * 0.2, Math.sin(a) * r * 0.2, w * 0.38); g.add(nut);
  }
  const cap = new T.Mesh(new T.CylinderGeometry(r * 0.1, r * 0.1, 0.02, 16), mats.chrome);
  cap.rotation.x = Math.PI / 2; cap.position.z = w * 0.385; g.add(cap);
  return g;
}

/** z of the body side at (x, y), for placing parts on the surface. */
function sideZ(S, x, y) {
  const { pts } = section(S, x);
  for (let i = 0; i < pts.length - 1; i++) {
    const [z1, y1] = pts[i], [z2, y2] = pts[i + 1];
    if ((y >= y1 && y <= y2) || (y <= y1 && y >= y2)) return y2 === y1 ? Math.max(z1, z2) : lerp(z1, z2, (y - y1) / (y2 - y1));
  }
  return pts[3][0];
}

function roundedBox(w, h, d, r) {
  const shape = new T.Shape();
  const x = -w / 2, y = -h / 2;
  shape.moveTo(x + r, y); shape.lineTo(x + w - r, y); shape.quadraticCurveTo(x + w, y, x + w, y + r);
  shape.lineTo(x + w, y + h - r); shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  shape.lineTo(x + r, y + h); shape.quadraticCurveTo(x, y + h, x, y + h - r);
  shape.lineTo(x, y + r); shape.quadraticCurveTo(x, y, x + r, y);
  const g = new T.ExtrudeGeometry(shape, { depth: d, bevelEnabled: true, bevelThickness: r * 0.6, bevelSize: r * 0.6, bevelSegments: 2, curveSegments: 4 });
  g.translate(0, 0, -d / 2);
  return g;
}

function addParts(S, car, mats) {
  const f = prepare(S);
  // mirrors
  if (S.mirror) {
    const m = S.mirror;
    for (const side of [1, -1]) {
      const z = sideZ(S, m.x, m.y + 0.02) + m.len / 2;
      const housing = new T.Mesh(roundedBox(0.10, m.h, m.len, 0.025), mats[m.mat]);
      housing.position.set(m.x - 0.03, m.y + m.h / 2 + 0.02, side * z);
      car.add(housing);
      const glassM = new T.Mesh(new T.PlaneGeometry(m.len * 0.8, m.h * 0.75), mats.glass);
      glassM.rotation.y = -Math.PI / 2; glassM.position.set(m.x - 0.083, m.y + m.h / 2 + 0.02, side * z); car.add(glassM);
      const arm = new T.Mesh(new T.BoxGeometry(0.07, 0.03, m.len * 0.6), mats.black);
      arm.position.set(m.x, m.y + 0.02, side * (z - m.len * 0.45)); car.add(arm);
    }
  }
  // roof rails
  if (S.roofRails) {
    const r = S.roofRails;
    for (const side of [1, -1]) {
      const rail = new T.Mesh(roundedBox(r.x1 - r.x0, 0.035, 0.035, 0.012), mats.black);
      rail.position.set((r.x0 + r.x1) / 2, r.y, side * r.z);
      car.add(rail);
      for (const x of [r.x0 + 0.05, r.x1 - 0.05]) {
        const foot = new T.Mesh(new T.BoxGeometry(0.09, 0.05, 0.05), mats.black);
        foot.position.set(x, r.y - 0.025, side * r.z); car.add(foot);
      }
    }
  }
  // chrome belt moulding
  if (S.beltChrome) {
    const pts = [];
    for (let x = S.beltChrome.x0; x <= S.beltChrome.x1; x += 0.05) { const y = Math.min(f.B(x), f.U(x)) + 0.004; pts.push(new T.Vector3(x, y, sideZ(S, x, y - 0.01) + 0.002)); }
    const tube = new T.TubeGeometry(new T.CatmullRomCurve3(pts), 80, 0.008, 6, false);
    car.add(new T.Mesh(tube, mats.chrome));
    const t2 = tube.clone(); t2.scale(1, 1, -1); car.add(new T.Mesh(t2, mats.chrome));
  }
  // optional pedestal spoiler
  if (S.spoiler) {
    const s = S.spoiler;
    const yDeck = f.U((s.x0 + s.x1) / 2) + S.crown;
    const wing = new T.Mesh(roundedBox(s.x1 - s.x0, 0.018, s.w, 0.008), mats.paint);
    wing.position.set((s.x0 + s.x1) / 2, yDeck + 0.07, 0); wing.rotation.z = -0.08; car.add(wing);
    for (const side of [1, -1]) {
      const post = new T.Mesh(new T.BoxGeometry(0.09, 0.08, 0.035), mats.paint);
      post.position.set((s.x0 + s.x1) / 2 + 0.01, yDeck + 0.03, side * s.w * 0.36); car.add(post);
    }
  }
  // open bed: thin bed-side caps and a tailgate lip around the dark liner
  if (S.bed?.liner) {
    const b = S.bed, y = f.U((b.x0 + b.x1) / 2) + S.crown * 0.5;
    const zIn = sideZ(S, (b.x0 + b.x1) / 2, y - 0.03);
    for (const side of [1, -1]) {
      const cap = new T.Mesh(roundedBox(b.x1 - b.x0, 0.035, 0.07, 0.012), mats.black);
      cap.position.set((b.x0 + b.x1) / 2, y + 0.012, side * (zIn - 0.05)); car.add(cap);
    }
    const lip = new T.Mesh(roundedBox(0.06, 0.035, zIn * 2 - 0.08, 0.012), mats.black);
    lip.position.set(b.x0 + 0.03, y + 0.012, 0); car.add(lip);
  }
  // fender flares (dark-gray trim)
  if (S.flares) {
    for (const ax of S.axles) for (const side of [1, -1]) {
      const R = S.archR + 0.045;
      const geo = new T.TorusGeometry(R, 0.05, 8, 28, Math.PI);
      geo.scale(1, 1, 0.5);
      const m = new T.Mesh(geo, mats.cladding);
      const z = sideZ(S, ax - S.archR - 0.05, f.cy + 0.1);
      m.position.set(ax, f.cy, side * (z + 0.005)); car.add(m);
      for (const dx of [-R, R]) {
        const foot = new T.Mesh(new T.BoxGeometry(0.10, f.cy - f.bot(ax + dx) + 0.06, 0.05), mats.cladding);
        foot.position.set(ax + dx, (f.cy + f.bot(ax + dx)) / 2, side * (z + 0.005)); car.add(foot);
      }
    }
  }
  // wheel-well liners
  for (const ax of S.axles) {
    const geo = new T.CylinderGeometry(S.archR - 0.005, S.archR - 0.005, S.hwMax * 2 - 0.06, 24, 1, true, Math.PI / 2, Math.PI);
    const liner = new T.Mesh(geo, new T.MeshStandardMaterial({ color: 0x050505, roughness: 1, side: T.BackSide }));
    liner.rotation.x = Math.PI / 2; liner.position.set(ax, f.cy, 0);
    car.add(liner);
  }
  // wheels
  for (const ax of S.axles) for (const side of [1, -1]) {
    const wm = wheelMesh(S, mats);
    wm.position.set(ax, S.tireR, side * (S.track / 2));
    if (side === -1) wm.rotation.y = Math.PI;
    wm.userData.wheel = true;
    car.add(wm);
  }
}

// ---------------------------------------------------------------- model cache + factory
const geoCache = new Map();
function geometryFor(S) {
  if (geoCache.has(S.id)) return geoCache.get(S.id);
  const body = buildBody(S);
  const decals = {};
  for (const d of S.decals) {
    const arr = decalGeometry(body, d);
    if (!arr) continue;
    (decals[d.mat] ||= []).push(arr);
  }
  const merged = {};
  for (const [mat, list] of Object.entries(decals)) {
    const total = list.reduce((n, a) => n + a.length, 0);
    const buf = new Float32Array(total); let o = 0;
    for (const a of list) { buf.set(a, o); o += a.length; }
    const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(buf, 3)); g.computeVertexNormals();
    merged[mat] = g;
  }
  const out = { body: body.geo, decals: merged };
  geoCache.set(S.id, out);
  return out;
}

/** Build a car Object3D (origin centred under the car, front facing +x). */
export function createCar(S, color, onReady) {
  const mats = makeMaterials(color || S.defaultColor, S);
  const pivot = new T.Group();
  pivot.add(proceduralCar(S, mats));
  pivot.userData = { spec: S, mats, length: S.L, setColor: c => { mats.paint.color.set(c); Object.assign(mats.paint, paintParams(c)); mats.line.color.set(c); } };
  return pivot;
}
function proceduralCar(S, mats) {
  const geo = geometryFor(S);
  const car = new T.Group();
  const body = new T.Mesh(geo.body, MATS.map(m => mats[m]));
  body.castShadow = true; body.receiveShadow = true;
  car.add(body);
  for (const [mat, g] of Object.entries(geo.decals)) car.add(new T.Mesh(g, mats[mat]));
  addParts(S, car, mats);
  car.traverse(o => { if (o.isMesh) { o.castShadow = true; } });
  car.position.x = -S.L / 2;
  const wrap = new T.Group(); wrap.add(car);
  return wrap;
}

// ---------------------------------------------------------------- owner-uploaded GLB (optional, per car)
// carRow.model_url -> a .glb the owner uploaded (served same-origin by the Worker). It keeps its own materials;
// materials named like paint/body/carpaint take the car's colour. If it fails to load, the procedural style is used.
const VENDOR = (globalThis.GARAGE_ASSET_BASE || '') + '/vendor/three-0.160.0/';
const PAINT_RE = /paint|body|carpaint/i;
export const DEFAULT_GLB_LENGTH = 4.6;   // metres, used when the file's units don't look like metres
const glbCache = new Map();
function loadGlb(url) {
  if (!glbCache.has(url)) {
    const p = (async () => {
      const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([import(VENDOR + 'GLTFLoader.js'), import(VENDOR + 'meshopt_decoder.module.js')]);
      const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
      return (await loader.loadAsync(url)).scene;
    })();
    glbCache.set(url, p);
    p.catch(() => glbCache.delete(url));
  }
  return glbCache.get(url);
}
/** Longest horizontal axis -> +x, metres (rescaled to 4.6 m if the length is outside 2.5-7 m), wheels on y = 0, centred. */
export function normalizeModel(model) {
  const g = new T.Group(); g.add(model);
  let box = new T.Box3().setFromObject(g), size = box.getSize(new T.Vector3());
  if (size.z > size.x) { model.rotation.y += Math.PI / 2; g.updateMatrixWorld(true); box = new T.Box3().setFromObject(g); size = box.getSize(new T.Vector3()); }
  const len = size.x;
  if (!(len >= 2.5 && len <= 7)) {
    if (!(len > 0) || !Number.isFinite(len)) throw new Error('model has no size');
    model.scale.multiplyScalar(DEFAULT_GLB_LENGTH / len);
    g.updateMatrixWorld(true); box = new T.Box3().setFromObject(g);
  }
  const c = box.getCenter(new T.Vector3());
  model.position.x -= c.x; model.position.z -= c.z; model.position.y -= box.min.y;
  g.updateMatrixWorld(true);
  return { group: g, length: new T.Box3().setFromObject(g).getSize(new T.Vector3()).x };
}
function createUserCar(url, S, color, onReady) {
  const mats = makeMaterials(color || S.defaultColor, S);
  const paintMats = new Set();
  const pivot = new T.Group();
  const setColor = c => { mats.paint.color.set(c); Object.assign(mats.paint, paintParams(c)); mats.line.color.set(c); for (const m of paintMats) m.color?.set(c); };
  pivot.userData = { spec: S, mats, paintMats, length: S.L, setColor, userModel: true };
  pivot.userData.ready = loadGlb(url).then(scene => {
    const model = scene.clone(true);
    model.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = true; o.receiveShadow = true;
      const swap = m => {
        if (!m || !PAINT_RE.test(m.name || '')) return m;
        const p = m.clone(); p.color?.set(color || S.defaultColor); paintMats.add(p); return p;   // per-instance copy: the cached scene is shared
      };
      o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
    });
    const { group, length } = normalizeModel(model);
    pivot.add(group);
    pivot.userData.length = length;
    pivot.userData.loaded = 'glb';
    onReady?.();
  }).catch(err => {
    console.warn('Car model failed to load, using the procedural body style', err);
    pivot.add(proceduralCar(S, mats));
    pivot.userData.loaded = 'procedural';
    onReady?.();
  });
  return pivot;
}

// ---------------------------------------------------------------- environment (RoomEnvironment-style, no addon)
function envTexture(renderer) {
  const scene = new T.Scene();
  const room = new T.Mesh(new T.BoxGeometry(1, 1, 1), new T.MeshStandardMaterial({ side: T.BackSide, color: 0x7a7f88, roughness: 1 }));
  room.scale.set(20, 10, 20); room.position.y = 4; scene.add(room);
  scene.add(new T.AmbientLight(0xffffff, 1.4));
  const panel = (w, h, d, x, y, z, k) => {
    const m = new T.MeshBasicMaterial({ color: 0xffffff }); m.color.setScalar(k);
    const b = new T.Mesh(new T.BoxGeometry(w, h, d), m); b.position.set(x, y, z); scene.add(b);
  };
  panel(8, 0.2, 1.2, 0, 8.6, 0, 5);       // long ceiling strip
  panel(8, 0.2, 1.2, 0, 8.6, -4, 4);
  panel(8, 0.2, 1.2, 0, 8.6, 4, 4);
  panel(14, 0.2, 14, 0, 9.4, 0, 0.9);
  panel(0.2, 3, 8, -9.8, 4, 0, 4);          // side softbox
  panel(0.2, 3, 8, 9.8, 4, 0, 6);
  panel(6, 2.5, 0.2, 0, 3, 9.8, 3);
  const warm = new T.MeshBasicMaterial({ color: 0xff8a1f }); warm.color.multiplyScalar(2.5);
  const w = new T.Mesh(new T.BoxGeometry(6, 0.3, 0.2), warm); w.position.set(0, 1.4, -9.8); scene.add(w);
  const pm = new T.PMREMGenerator(renderer);
  const tex = pm.fromScene(scene, 0.035).texture;
  pm.dispose();
  return tex;
}

// ---------------------------------------------------------------- viewer
/**
 * new CarViewer(container, { garage: true }) -> await viewer.init() -> viewer.show(car, dir)
 * Drag to orbit; auto turntable spin when idle. Pauses when hidden or off-screen.
 */
export class CarViewer {
  constructor(container, opts = {}) {
    this.el = container; this.opts = { garage: true, spin: true, ...opts };
    this.az = opts.az ?? 0.65; this.el2 = opts.elev ?? 0.2; this.dist = null;
    this.spin = 0; this.lastInteract = 0; this.running = false; this.visible = true; this.anims = [];
  }
  async init() {
    await loadThree();
    const r = this.renderer = new T.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: !!this.opts.capture });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.outputColorSpace = T.SRGBColorSpace;
    r.toneMapping = T.ACESFilmicToneMapping; r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = true; r.shadowMap.type = T.PCFSoftShadowMap;
    this.el.appendChild(r.domElement);
    r.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:pan-y;cursor:grab';
    const s = this.scene = new T.Scene();
    s.background = new T.Color(this.opts.garage ? 0x0b0d10 : 0x10141a);
    s.fog = new T.Fog(s.background, 11, 26);
    s.environment = envTexture(r);
    this.camera = new T.PerspectiveCamera(30, 1, 0.1, 120);
    s.add(new T.HemisphereLight(0xcfe2ff, 0x0c0c0e, 0.35));
    const key = this.key = new T.DirectionalLight(0xffffff, 2.0);
    key.position.set(3, 9, 5); key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -4.5, right: 4.5, top: 4.5, bottom: -4.5, near: 1, far: 25 });
    key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02;
    s.add(key);
    // rim lights from behind so a black car's silhouette still reads against the dark bay
    const rim = new T.DirectionalLight(0x9fd0ff, 1.1); rim.position.set(-6, 4, -6); s.add(rim);
    const rim2 = new T.DirectionalLight(0xffc89a, 0.7); rim2.position.set(6, 3, -5); s.add(rim2);
    const fill = new T.DirectionalLight(0xffffff, 0.35); fill.position.set(-4, 2.5, 6); s.add(fill);
    this.buildSet();
    this.pivot = new T.Group(); s.add(this.pivot);
    this.bindInput();
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(this.el); this.resize();
    this.io = new IntersectionObserver(es => { this.visible = es[0].isIntersecting; this.kick(); }); this.io.observe(this.el);
    this.onVis = () => this.kick(); document.addEventListener('visibilitychange', this.onVis);
    return this;
  }
  buildSet() {
    const s = this.scene;
    const floor = new T.Mesh(new T.CircleGeometry(30, 48), new T.MeshStandardMaterial({ color: 0x0d0f12, roughness: 0.5, metalness: 0.0, envMapIntensity: 0.35 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; s.add(floor);
    const table = this.table = new T.Group();
    const disc = new T.Mesh(new T.CylinderGeometry(3.35, 3.4, 0.07, 72), new T.MeshStandardMaterial({ color: 0x1a1e24, roughness: 0.55, metalness: 0.25, envMapIntensity: 0.35 }));
    disc.position.y = 0.035; disc.receiveShadow = true; table.add(disc);
    const ring = new T.Mesh(new T.TorusGeometry(3.36, 0.018, 8, 96), new T.MeshBasicMaterial({ color: 0xff8a1f }));
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.07; table.add(ring);
    for (let i = 0; i < 24; i++) { // grooves so the spin reads
      const g = new T.Mesh(new T.BoxGeometry(0.9, 0.004, 0.02), new T.MeshStandardMaterial({ color: 0x1a1e24, roughness: 0.6 }));
      const a = (i / 24) * Math.PI * 2; g.position.set(Math.cos(a) * 2.8, 0.072, Math.sin(a) * 2.8); g.rotation.y = -a; table.add(g);
    }
    s.add(table);
    if (!this.opts.garage) return;
    // garage bay: back wall, side walls, ceiling light bars, bay lines
    const wallMat = new T.MeshStandardMaterial({ color: 0x15181d, roughness: 0.85 });
    const back = new T.Mesh(new T.PlaneGeometry(24, 9), wallMat); back.position.set(0, 4.5, -7); back.receiveShadow = true; s.add(back);
    for (const x of [-11, 11]) { const w = new T.Mesh(new T.PlaneGeometry(16, 9), wallMat); w.position.set(x, 4.5, 1); w.rotation.y = x < 0 ? Math.PI / 2 : -Math.PI / 2; s.add(w); }
    const barMat = new T.MeshBasicMaterial({ color: 0xffffff }); barMat.color.setScalar(3);
    for (const z of [-2.2, 0.6, 3.4]) { const bar = new T.Mesh(new T.BoxGeometry(3.2, 0.05, 0.14), barMat); bar.position.set(0, 5.6, z); s.add(bar); }
    const lineMat = new T.MeshBasicMaterial({ color: 0xc9a227 });
    for (const x of [-4.6, 4.6]) { const l = new T.Mesh(new T.PlaneGeometry(0.12, 12), lineMat); l.rotation.x = -Math.PI / 2; l.rotation.z = Math.PI / 2; l.position.set(0, 0.003, x); s.add(l); }
    const stop = new T.Mesh(new T.BoxGeometry(0.16, 0.1, 1.4), new T.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.6 }));
    stop.position.set(-5.6, 0.05, 0); s.add(stop);
    const sign = new T.Mesh(new T.BoxGeometry(5, 0.04, 0.04), new T.MeshBasicMaterial({ color: 0xff8a1f })); sign.position.set(0, 4.3, -6.9); s.add(sign);
  }
  bindInput() {
    const c = this.renderer.domElement;
    let drag = null;
    c.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, az: this.az, el: this.el2, t: performance.now(), id: e.pointerId }; c.style.cursor = 'grabbing'; this.lastInteract = performance.now(); this.kick(); });
    c.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.cap && Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy)) { drag.cap = true; c.setPointerCapture(e.pointerId); }
      if (!drag.cap) return;
      this.az = drag.az - dx * 0.008; this.el2 = Math.max(0.03, Math.min(0.75, drag.el + dy * 0.004));
      this.lastInteract = performance.now(); this.kick();
    });
    const end = e => {
      if (!drag) return;
      const dt = performance.now() - drag.t, dx = e.clientX - drag.x;
      if (drag.cap && dt < 260 && Math.abs(dx) > 70 && this.onSwipe) { this.az = drag.az; this.onSwipe(dx < 0 ? 1 : -1); }
      drag = null; c.style.cursor = 'grab';
    };
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
  }
  resize() {
    const w = this.el.clientWidth || 300, h = this.el.clientHeight || 200;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Optional focus element: frame the car on that part of the canvas (full-bleed garage with UI overlaid)
    let fw = w, fh = h;
    if (this.focusEl) {
      const a = this.el.getBoundingClientRect(), b = this.focusEl.getBoundingClientRect();
      fw = Math.max(120, b.width); fh = Math.max(120, b.height);
      const cx = b.left + b.width / 2 - a.left, cy = b.top + b.height / 2 - a.top;
      this.camera.setViewOffset(w, h, w / 2 - cx, h / 2 - cy, w, h);
    } else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    // narrow/portrait frames need the camera further back to fit the car's length
    // the vertical FOV spans the whole canvas, so a smaller focus box needs the camera further back by h/fh
    this.aspectBoost = Math.max(1, 1.55 / Math.max(0.5, fw / fh)) * (this.focusEl ? Math.max(1, (h / fh) * 0.8) : 1);
    if (this.spec) this.targetDist = Math.max(7.6, this.spec.L * 1.55) * this.aspectBoost;
    this.kick();
  }
  /** Show a car; dir = +1 slides in from the right, -1 from the left, 0 = instant. */
  show(carRow, dir = 0) {
    const S = specFor(carRow);
    const url = typeof carRow.model_url === 'string' && carRow.model_url.trim() ? carRow.model_url.trim() : null;
    const color = carRow.color || S.defaultColor;
    let next;
    const onReady = () => {
      // an uploaded model can be a different length than the style's default: re-frame once it's in
      if (this.current === next && next.userData.length !== S.L) { this.spec = { ...S, L: next.userData.length }; this.resize(); }
      this.kick();
    };
    next = url ? createUserCar(url, S, color, onReady) : createCar(S, color, onReady);
    this.ready = next.userData.ready || Promise.resolve();
    next.userData.carId = carRow.id;
    const prev = this.current;
    this.current = next;
    this.spec = S;
    this.pivot.add(next);
    this.targetDist = Math.max(7.6, S.L * 1.55) * (this.aspectBoost || 1);
    if (this.focusEl) this.resize();
    if (this.dist == null) this.dist = this.targetDist;
    if (prev && dir) {
      const t0 = performance.now();
      next.position.x = dir * 11;
      this.anims.push(t => {
        const k = Math.min(1, (t - t0) / 650), e = 1 - Math.pow(1 - k, 3);
        next.position.x = dir * 11 * (1 - e);
        prev.position.x = -dir * 11 * Math.min(1, k * 1.4) ** 2;
        if (k >= 1) { this.pivot.remove(prev); disposeCar(prev); return true; }
        return false;
      });
    } else if (prev) { this.pivot.remove(prev); disposeCar(prev); }
    this.kick();
  }
  setColor(c) { this.current?.userData.setColor(c); this.kick(); }
  setView(az, el) { this.az = az; this.el2 = el; this.opts.spin = false; this.kick(); }
  kick() {
    if (this.running || this.disposed) return;
    if (document.hidden || !this.visible) return;
    this.running = true;
    const loop = t => {
      if (this.disposed || document.hidden || !this.visible) { this.running = false; return; }
      this.frame(t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  frame(t) {
    const dt = Math.min(0.05, (t - (this.lastT || t)) / 1000); this.lastT = t;
    if (this.opts.spin && t - this.lastInteract > 2500) { this.spin += dt * 0.22; }
    this.pivot.rotation.y = this.spin;
    this.table.rotation.y = this.spin;
    this.anims = this.anims.filter(a => !a(t));
    this.dist += (this.targetDist - this.dist) * Math.min(1, dt * 4);
    this.scene.fog.near = this.dist + 3; this.scene.fog.far = this.dist + 18;
    const d = this.dist, look = new T.Vector3(0, 0.75, 0);
    this.camera.position.set(Math.sin(this.az) * Math.cos(this.el2) * d, look.y + Math.sin(this.el2) * d, Math.cos(this.az) * Math.cos(this.el2) * d);
    this.camera.lookAt(look);
    this.renderer.render(this.scene, this.camera);
  }
  renderOnce() { this.frame(performance.now()); }
  dispose() {
    this.disposed = true; cancelAnimationFrame(this.raf);
    this.ro?.disconnect(); this.io?.disconnect(); document.removeEventListener('visibilitychange', this.onVis);
    this.scene?.traverse(o => { if (o.isMesh) { o.geometry?.dispose?.(); } });
    this.scene?.environment?.dispose();
    this.renderer?.dispose(); this.renderer?.forceContextLoss?.();
    this.renderer?.domElement.remove();
  }
}
function disposeCar(pivot) {
  // geometry is cached and shared between instances; only free per-instance materials
  for (const m of Object.values(pivot.userData.mats || {})) m.dispose?.();
  for (const m of pivot.userData.paintMats || []) m.dispose?.();
}
