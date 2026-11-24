// Original stylized side-profile car art (no logos, badges or traced brand art).
// carSvg(bodyType, color, { label, reflection }) -> SVG markup string. Body colour is per car.

let uidN = 0;

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(hex, target, amt) {
  const [r, g, b] = hexToRgb(hex), [tr, tg, tb] = hexToRgb(target);
  const c = (a, t) => Math.round(a + (t - a) * amt).toString(16).padStart(2, '0');
  return `#${c(r, tr)}${c(g, tg)}${c(b, tb)}`;
}
export const lighten = (hex, a) => mix(hex, '#ffffff', a);
export const darken = (hex, a) => mix(hex, '#000000', a);

// Geometry per body type. Coordinates in a 600 x 300 box, ground at y ~ 240.
const SHAPES = {
  minivan: {
    wheels: [150, 462], cy: 200, r: 37, arch: 46,
    body: 'M 44 200 L 38 150 Q 34 96 58 70 Q 74 54 120 52 L 394 48 Q 418 48 430 58 L 506 126 Q 548 132 562 146 Q 573 158 572 182 L 570 200 L 508 200 A 46 46 0 0 0 416 200 L 196 200 A 46 46 0 0 0 104 200 Z',
    glass: 'M 60 122 L 64 88 Q 70 68 110 66 L 392 62 Q 410 62 420 72 L 484 126 Z',
    pillars: ['M 168 62 L 180 62 L 182 124 L 170 124 Z', 'M 292 60 L 303 60 L 304 126 L 293 126 Z', 'M 404 60 L 420 62 L 492 128 L 474 128 Z'],
    seams: ['M 186 128 L 186 196', 'M 302 128 L 304 196', 'M 470 130 Q 476 168 472 196', 'M 180 130 L 92 128'],
    handles: [[268, 140], [436, 140]],
    character: 'M 50 132 L 500 134 Q 536 138 560 150',
    head: 'M 532 140 Q 556 143 568 155 L 563 163 Q 544 158 526 150 Z',
    tail: 'M 39 92 Q 45 84 53 88 L 51 146 L 40 148 Z',
    grille: 'M 566 166 L 572 168 L 571 184 L 564 182 Z',
    mirror: 'M 476 118 Q 492 112 498 122 L 494 130 Q 482 132 476 126 Z',
    rail: 'M 122 50 L 372 46 L 372 42 L 122 46 Z',
    rocker: 180,
  },
  sedan: {
    wheels: [148, 452], cy: 202, r: 35, arch: 44,
    body: 'M 40 202 L 36 172 Q 36 154 54 150 L 118 140 Q 160 100 214 90 Q 272 80 334 86 Q 380 92 424 130 Q 500 136 548 148 Q 568 154 570 178 L 568 202 L 496 202 A 44 44 0 0 0 408 202 L 192 202 A 44 44 0 0 0 104 202 Z',
    glass: 'M 134 138 Q 172 104 218 96 Q 272 88 330 92 Q 366 98 404 132 Z',
    pillars: ['M 266 88 L 278 88 L 280 136 L 268 136 Z', 'M 134 138 Q 150 122 166 112 L 178 112 Q 162 124 150 138 Z'],
    seams: ['M 274 140 L 272 198', 'M 410 136 Q 416 170 410 198', 'M 196 142 Q 186 150 188 160'],
    handles: [[238, 150], [372, 150]],
    character: 'M 56 162 L 300 160 L 560 164',
    head: 'M 518 144 Q 550 146 566 158 L 561 165 Q 536 158 514 152 Z',
    tail: 'M 37 158 L 66 152 L 67 166 L 38 171 Z',
    grille: 'M 562 170 L 569 172 L 568 190 L 560 188 Z',
    mirror: 'M 404 124 Q 420 118 426 128 L 422 136 Q 410 138 404 132 Z',
    rocker: 186,
  },
  coupe: {
    wheels: [148, 452], cy: 202, r: 35, arch: 44,
    body: 'M 40 202 L 36 172 Q 36 154 54 150 L 118 142 Q 170 106 230 96 Q 290 90 340 96 Q 384 104 420 134 Q 500 138 548 148 Q 568 154 570 178 L 568 202 L 496 202 A 44 44 0 0 0 408 202 L 192 202 A 44 44 0 0 0 104 202 Z',
    glass: 'M 140 140 Q 180 112 232 104 Q 290 98 336 102 Q 368 108 402 136 Z',
    pillars: ['M 214 106 L 224 105 L 236 140 L 226 140 Z'],
    seams: ['M 238 144 L 236 198', 'M 410 138 Q 416 170 410 198'],
    handles: [[300, 152]],
    character: 'M 56 164 L 300 162 L 560 166',
    head: 'M 518 146 Q 550 148 566 160 L 561 167 Q 536 160 514 154 Z',
    tail: 'M 37 160 L 66 154 L 67 166 L 38 171 Z',
    grille: 'M 562 172 L 569 174 L 568 190 L 560 188 Z',
    mirror: 'M 402 126 Q 418 120 424 130 L 420 138 Q 408 140 402 134 Z',
    rocker: 186,
  },
  hatchback: {
    wheels: [160, 440], cy: 202, r: 35, arch: 44,
    body: 'M 60 202 L 56 150 Q 62 112 92 90 Q 108 80 140 78 L 310 76 Q 336 78 356 96 L 410 132 Q 486 138 530 150 Q 550 156 552 180 L 550 202 L 484 202 A 44 44 0 0 0 396 202 L 204 202 A 44 44 0 0 0 116 202 Z',
    glass: 'M 80 130 Q 92 104 112 92 Q 124 86 146 86 L 306 84 Q 328 86 344 100 L 390 132 Z',
    pillars: ['M 178 84 L 190 84 L 192 132 L 180 132 Z', 'M 276 84 L 288 84 L 290 132 L 278 132 Z'],
    seams: ['M 186 136 L 186 198', 'M 284 136 L 284 198', 'M 392 136 Q 398 170 394 198'],
    handles: [[236, 146], [334, 146]],
    character: 'M 66 150 L 540 158',
    head: 'M 506 146 Q 534 148 548 160 L 543 166 Q 520 160 500 154 Z',
    tail: 'M 58 116 Q 64 108 70 112 L 66 146 L 58 148 Z',
    grille: 'M 544 170 L 551 172 L 550 188 L 542 186 Z',
    mirror: 'M 380 124 Q 396 118 402 128 L 398 136 Q 386 138 380 132 Z',
    rocker: 186,
  },
  suv: {
    wheels: [150, 462], cy: 196, r: 42, arch: 51,
    body: 'M 38 196 L 34 120 Q 34 70 56 58 Q 66 52 100 50 L 380 48 Q 400 48 412 60 L 450 112 Q 540 116 562 128 Q 574 136 574 160 L 572 196 L 513 196 A 51 51 0 0 0 411 196 L 201 196 A 51 51 0 0 0 99 196 Z',
    glass: 'M 52 112 L 56 76 Q 60 62 96 60 L 376 58 Q 392 58 402 68 L 438 112 Z',
    pillars: ['M 170 58 L 182 58 L 184 114 L 172 114 Z', 'M 290 58 L 302 58 L 304 114 L 292 114 Z'],
    seams: ['M 178 118 L 178 190', 'M 298 118 L 300 190', 'M 438 118 Q 444 156 440 190'],
    handles: [[248, 128], [400, 128]],
    character: 'M 40 126 L 560 132',
    head: 'M 540 128 Q 562 132 572 142 L 571 152 Q 552 146 536 138 Z',
    tail: 'M 35 70 Q 40 64 48 68 L 46 124 L 36 126 Z',
    grille: 'M 564 146 L 574 148 L 574 178 L 564 176 Z',
    mirror: 'M 430 104 Q 448 98 454 108 L 450 118 Q 436 120 430 114 Z',
    rail: 'M 100 48 L 360 46 L 360 42 L 100 44 Z',
    cladding: true,
    rocker: 170,
  },
  pickup: {
    wheels: [160, 462], cy: 200, r: 40, arch: 50,
    body: 'M 30 200 L 28 124 Q 28 112 42 112 L 224 112 L 226 72 Q 228 60 244 60 L 364 60 Q 378 60 388 70 L 430 118 Q 524 120 558 130 Q 574 136 576 158 L 576 200 L 512 200 A 50 50 0 0 0 412 200 L 210 200 A 50 50 0 0 0 110 200 Z',
    glass: 'M 236 116 L 238 80 Q 240 70 254 70 L 360 70 Q 372 70 380 80 L 414 116 Z',
    pillars: ['M 318 68 L 330 68 L 330 118 L 318 118 Z'],
    seams: ['M 330 120 L 328 196', 'M 424 122 Q 430 160 426 196', 'M 236 120 L 232 196'],
    handles: [[296, 138], [398, 138]],
    character: 'M 34 140 L 560 142',
    head: 'M 538 132 Q 562 134 574 144 L 573 154 Q 552 149 534 142 Z',
    tail: 'M 28 122 L 37 122 L 37 160 L 28 160 Z',
    grille: 'M 567 152 L 576 152 L 576 180 L 567 180 Z',
    mirror: 'M 424 108 Q 442 102 448 112 L 444 122 Q 430 124 424 118 Z',
    bed: 'M 34 112 L 222 112 L 222 118 L 34 118 Z',
    cladding: true,
    rocker: 166,
  },
  suv: {
    wheels: [160, 462], cy: 200, r: 40, arch: 50,
    body: 'M 30 200 L 28 132 Q 28 74 58 64 L 374 58 Q 388 58 396 68 L 434 118 Q 524 122 558 132 Q 574 138 576 160 L 576 200 L 512 200 A 50 50 0 0 0 412 200 L 210 200 A 50 50 0 0 0 110 200 Z',
    glass: 'M 46 120 L 52 84 Q 56 72 72 72 L 366 68 Q 378 68 386 78 L 418 120 Z',
    pillars: ['M 138 70 L 150 70 L 150 122 L 138 122 Z', 'M 270 69 L 282 69 L 282 122 L 270 122 Z', 'M 380 70 L 392 74 L 424 120 L 410 120 Z'],
    seams: ['M 282 124 L 280 196', 'M 426 124 Q 432 160 428 196', 'M 150 124 L 152 196'],
    handles: [[244, 138], [392, 138]],
    character: 'M 34 140 L 560 142',
    head: 'M 538 132 Q 562 134 574 144 L 573 154 Q 552 149 534 142 Z',
    tail: 'M 28 120 L 38 120 L 38 156 L 28 156 Z',
    grille: 'M 567 152 L 576 152 L 576 180 L 567 180 Z',
    mirror: 'M 426 108 Q 444 102 450 112 L 446 122 Q 432 124 426 118 Z',
    rail: 'M 80 60 L 340 56 L 340 52 L 80 56 Z',
    cladding: true,
    rocker: 170,
  },
};

// ---------------------------------------------------------------- motorcycles, UTV, ATV (side profiles drawn in metres)
const MOTO = new Set(['cruiser', 'sport', 'dualsport', 'scooter']);
const f1 = n => Math.round(n * 10) / 10;
function arcBand(P, cx, cy, R, rIn0, rIn1, a0, a1, k) {
  // fender seen from the side: outer arc a0 -> a1 (deg, CCW, 0 = forward), skirt back along a shallower inner arc
  const pt = (r, a) => P(cx + r * Math.cos(a * Math.PI / 180), cy + r * Math.sin(a * Math.PI / 180));
  const [ox0, oy0] = pt(R, a0), [ox1, oy1] = pt(R, a1), [ix1, iy1] = pt(rIn1, a1), [ix0, iy0] = pt(rIn0, a0);
  const big = a1 - a0 > 180 ? 1 : 0, rin = ((rIn0 + rIn1) / 2) * k;
  return `M ${f1(ox0)} ${f1(oy0)} A ${f1(R * k)} ${f1(R * k)} 0 ${big} 0 ${f1(ox1)} ${f1(oy1)} L ${f1(ix1)} ${f1(iy1)} A ${f1(rin)} ${f1(rin)} 0 ${big} 1 ${f1(ix0)} ${f1(iy0)} Z`;
}
const poly = (P, pts) => 'M ' + pts.map(([x, y]) => P(x, y).map(f1).join(' ')).join(' L ') + ' Z';
const line = (P, pts) => 'M ' + pts.map(([x, y]) => P(x, y).map(f1).join(' ')).join(' L ');
function spokeWheel(cx, cy, r, ids) {
  const sp = [];
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2, b = a + (i % 2 ? 0.5 : -0.5);
    sp.push(`M ${f1(cx + Math.cos(a) * r * 0.13)} ${f1(cy + Math.sin(a) * r * 0.13)} L ${f1(cx + Math.cos(b) * r * 0.6)} ${f1(cy + Math.sin(b) * r * 0.6)}`);
  }
  return `<g class="wheel"><circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(r)}" fill="#0d0f12"/>
    <circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(r - 4)}" fill="none" stroke="#24282e" stroke-width="3"/>
    <path d="${sp.join(' ')}" stroke="#cfd6de" stroke-width="1.1" opacity=".9"/>
    <circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(r * 0.62)}" fill="none" stroke="url(#${ids.rim})" stroke-width="4"/>
    <circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(r * 0.15)}" fill="url(#${ids.rim})" stroke="#5d646d" stroke-width="1.2"/></g>`;
}
function knobWheel(cx, cy, r, ids) {
  const rim = r * 0.5, sp = [];
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2 + 0.3; sp.push(`M ${f1(cx + Math.cos(a) * rim * 0.3)} ${f1(cy + Math.sin(a) * rim * 0.3)} L ${f1(cx + Math.cos(a) * rim * 0.92)} ${f1(cy + Math.sin(a) * rim * 0.92)}`); }
  return `<g class="wheel"><circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(r - 3)}" fill="#0d0f12" stroke="#16181c" stroke-width="7" stroke-dasharray="7 5"/>
    <circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(r - 9)}" fill="none" stroke="#24282e" stroke-width="2"/>
    <circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(rim)}" fill="#2b2f35"/>
    <path d="${sp.join(' ')}" stroke="#4a5059" stroke-width="${f1(r * 0.09)}" stroke-linecap="round"/>
    <circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(rim)}" fill="none" stroke="url(#${ids.rim})" stroke-width="3"/>
    <circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(rim * 0.25)}" fill="#1a1d22" stroke="#5d646d" stroke-width="1.2"/></g>`;
}
/** Body of a powersports side profile: returns { parts, wheels, ground } in SVG units. */
function powersportArt(type, color, ids) {
  const paint = `url(#${ids.body})`, chrome = `url(#${ids.rim})`, dark = '#15171a', edge = darken(color, 0.6);
  if (type === 'utv') {
    const k = 125, P = (x, y) => [154 + x * k, 250 - y * k];
    const [rx, ry] = P(0, 0.37), [fx, fy] = P(2.29, 0.37), r = 0.37 * k;
    const parts = `
      <path d="${line(P, [[0.80, 0.80], [0.78, 1.35], [0.74, 1.74], [0.86, 1.84], [1.30, 1.85], [1.45, 1.79], [1.62, 1.42], [1.80, 1.0]])}" fill="none" stroke="#3d434b" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>
      <path d="${line(P, [[0.76, 1.72], [0.45, 1.30], [0.05, 0.97]])}" fill="none" stroke="#3d434b" stroke-width="5" stroke-linecap="round"/>
      <path d="${poly(P, [[0.70, 0.66], [0.84, 1.30], [0.95, 1.30], [0.95, 0.72], [1.40, 0.72], [1.40, 0.62]])}" fill="#1b1714"/>
      <ellipse cx="${f1(P(1.47, 1.13)[0])}" cy="${f1(P(1.47, 1.13)[1])}" rx="5" ry="15" fill="none" stroke="#111" stroke-width="4" transform="rotate(-38 ${f1(P(1.47, 1.13)[0])} ${f1(P(1.47, 1.13)[1])})"/>
      <path d="${poly(P, [[-0.26, 0.85], [0.80, 0.85], [0.80, 0.95], [-0.26, 0.95]])}" fill="#1c1e22"/>
      <path d="${poly(P, [[0.05, 0.40], [2.45, 0.40], [2.45, 0.48], [0.05, 0.48]])}" fill="#0c0d0f"/>
      <path d="${line(P, [[2.25, 0.37], [2.16, 0.98]])}" stroke="#c9a227" stroke-width="7" stroke-dasharray="3 2"/>
      <path d="${line(P, [[0.16, 0.40], [0.50, 1.02]])}" stroke="#c9a227" stroke-width="7" stroke-dasharray="3 2"/>
      <path d="${line(P, [[1.02, 0.47], [0.06, 0.37]])}" stroke="${dark}" stroke-width="6" stroke-linecap="round"/>
      <path d="${line(P, [[2.10, 0.42], [2.29, 0.33], [2.48, 0.42]])}" stroke="${dark}" stroke-width="4" fill="none"/>
      <path d="M ${P(1.68, 0.99).map(f1).join(' ')} Q ${P(2.30, 0.92).map(f1).join(' ')} ${P(2.72, 0.70).map(f1).join(' ')} L ${P(2.72, 0.62).map(f1).join(' ')} L ${P(1.68, 0.64).map(f1).join(' ')} Z" fill="${paint}" stroke="${edge}" stroke-width="1.2"/>
      <path d="${poly(P, [[2.56, 0.76], [2.70, 0.71], [2.70, 0.69], [2.56, 0.73]])}" fill="#eef6ff"/>
      <path d="M ${P(0.86, 0.98).map(f1).join(' ')} Q ${P(1.2, 0.86).map(f1).join(' ')} ${P(1.74, 1.0).map(f1).join(' ')} L ${P(1.74, 0.58).map(f1).join(' ')} L ${P(0.86, 0.58).map(f1).join(' ')} Z" fill="${paint}" stroke="${edge}" stroke-width="1.2"/>
      <path d="${poly(P, [[0.70, 0.46], [1.86, 0.46], [1.86, 0.58], [0.70, 0.58]])}" fill="#1c1e22"/>
      <path d="${poly(P, [[0.40, 0.66], [0.86, 0.66], [0.86, 0.92], [0.40, 0.92]])}" fill="${paint}" stroke="${edge}" stroke-width="1"/>
      <path d="${arcBand(P, 2.29, 0.37, 0.475, 0.44, 0.44, 22, 150, k)}" fill="${paint}" stroke="${edge}" stroke-width="1"/>
      <path d="${arcBand(P, 0, 0.37, 0.475, 0.44, 0.44, 28, 142, k)}" fill="${paint}" stroke="${edge}" stroke-width="1"/>
      <path d="${poly(P, [[-0.27, 0.84], [-0.22, 0.84], [-0.22, 0.89], [-0.27, 0.89]])}" fill="#b3121b"/>`;
    return { parts, wheels: knobWheel(rx, ry, r, ids) + knobWheel(fx, fy, r, ids), ground: 250, w: [rx, fx], r };
  }
  if (type === 'atv') {
    const k = 190, P = (x, y) => [169 + x * k, 245 - y * k];
    const [rx, ry] = P(0, 0.3175), [fx, fy] = P(1.25, 0.3175), r = 0.3175 * k;
    const rack = (x0, x1, y) => `<path d="${line(P, [[x0, y], [x1, y]])} ${[0, 1, 2, 3, 4].map(i => line(P, [[x0 + (x1 - x0) * i / 4, y], [x0 + (x1 - x0) * i / 4, y - 0.05]])).join(' ')}" stroke="${dark}" stroke-width="4" fill="none" stroke-linecap="round"/>`;
    const parts = `
      <path d="${poly(P, [[0.30, 0.36], [0.98, 0.36], [0.98, 0.70], [0.30, 0.70]])}" fill="#1c1e22"/>
      <path d="${poly(P, [[0.40, 0.33], [0.98, 0.33], [0.98, 0.38], [0.40, 0.38]])}" fill="#101113"/>
      <path d="${line(P, [[0.98, 0.80], [1.07, 1.11]])}" stroke="${dark}" stroke-width="5"/>
      <path d="${line(P, [[0.98, 1.17], [1.075, 1.14]])}" stroke="${dark}" stroke-width="6" stroke-linecap="round"/>
      <path d="M ${P(-0.40, 0.56).map(f1).join(' ')} L ${P(-0.40, 0.76).map(f1).join(' ')} Q ${P(-0.25, 0.84).map(f1).join(' ')} ${P(0.42, 0.84).map(f1).join(' ')} L ${P(0.42, 0.56).map(f1).join(' ')} Z" fill="${paint}"/>
      <path d="M ${P(0.95, 0.58).map(f1).join(' ')} L ${P(0.95, 0.84).map(f1).join(' ')} Q ${P(1.45, 0.85).map(f1).join(' ')} ${P(1.76, 0.64).map(f1).join(' ')} L ${P(1.76, 0.48).map(f1).join(' ')} Z" fill="${paint}"/>
      <path d="M ${P(0.80, 0.74).map(f1).join(' ')} Q ${P(1.0, 1.0).map(f1).join(' ')} ${P(1.22, 0.88).map(f1).join(' ')} L ${P(1.22, 0.74).map(f1).join(' ')} Z" fill="${paint}"/>
      <path d="M ${P(-0.02, 0.80).map(f1).join(' ')} Q ${P(0.0, 0.91).map(f1).join(' ')} ${P(0.2, 0.905).map(f1).join(' ')} L ${P(0.88, 0.93).map(f1).join(' ')} L ${P(0.90, 0.80).map(f1).join(' ')} Z" fill="#17130f"/>
      <path d="${arcBand(P, 1.25, 0.3175, 0.415, 0.37, 0.36, 2, 165, k)}" fill="${paint}" stroke="${edge}" stroke-width="1"/>
      <path d="${arcBand(P, 0, 0.3175, 0.415, 0.36, 0.37, 15, 178, k)}" fill="${paint}" stroke="${edge}" stroke-width="1"/>
      <path d="M ${P(1.02, 1.12).map(f1).join(' ')} Q ${P(1.12, 1.20).map(f1).join(' ')} ${P(1.23, 1.12).map(f1).join(' ')} L ${P(1.23, 1.09).map(f1).join(' ')} L ${P(1.02, 1.10).map(f1).join(' ')} Z" fill="${paint}"/>
      ${rack(1.30, 1.70, 0.92)}${rack(-0.38, 0.30, 0.91)}
      <path d="${poly(P, [[1.68, 0.63], [1.75, 0.62], [1.75, 0.66], [1.68, 0.67]])}" fill="#eef6ff"/>
      <path d="${poly(P, [[-0.42, 0.70], [-0.38, 0.70], [-0.38, 0.75], [-0.42, 0.75]])}" fill="#b3121b"/>`;
    return { parts, wheels: knobWheel(rx, ry, r, ids) + knobWheel(fx, fy, r, ids), ground: 245, w: [rx, fx], r };
  }
  // motorcycles (cruiser profile; used for every motorcycle type)
  const k = 200, P = (x, y) => [140 + x * k, 240 - y * k];
  const [rx, ry] = P(0, 0.3265), [fx, fy] = P(1.625, 0.32), r = 0.325 * k;
  const [cx, cy] = P(0.95, 0.35);
  const cyl = a => `<g transform="translate(${f1(cx)} ${f1(cy)}) rotate(${a})">
      <rect x="-18" y="-74" width="36" height="52" rx="4" fill="url(#${ids.spoke})"/>
      ${Array.from({ length: 9 }, (_, i) => `<rect x="-19" y="${-72 + i * 5.4}" width="38" height="1.6" fill="#5b626b"/>`).join('')}
      <ellipse cx="0" cy="-76" rx="15" ry="6" fill="url(#${ids.rim})"/></g>`;
  const parts = `
    <path d="${line(P, [[1.27, 0.84], [1.29, 0.62], [1.25, 0.40], [1.15, 0.18], [0.62, 0.18], [0.54, 0.38], [0.62, 0.72]])}" fill="none" stroke="${dark}" stroke-width="5" stroke-linejoin="round"/>
    <path d="${line(P, [[0.54, 0.40], [0, 0.33]])}" stroke="#2a2d33" stroke-width="8" stroke-linecap="round"/>
    ${cyl(35)}${cyl(-35)}
    <ellipse cx="${f1(P(0.92, 0.33)[0])}" cy="${f1(P(0.92, 0.33)[1])}" rx="54" ry="27" fill="#1c1e22"/>
    <ellipse cx="${f1(P(0.86, 0.31)[0])}" cy="${f1(P(0.86, 0.31)[1])}" rx="21" ry="18" fill="url(#${ids.rim})"/>
    <path d="M ${P(0.47, 0.55).map(f1).join(' ')} L ${P(0.74, 0.50).map(f1).join(' ')} L ${P(0.74, 0.70).map(f1).join(' ')} L ${P(0.47, 0.625).map(f1).join(' ')} Z" fill="${paint}"/>
    <path d="${arcBand(P, 0, 0.3265, 0.385, 0.33, 0.22, 58, 198, k)}" fill="${paint}" stroke="${edge}" stroke-width="1.2"/>
    <path d="${arcBand(P, 1.625, 0.32, 0.356, 0.21, 0.30, 8, 150, k)}" fill="${paint}" stroke="${edge}" stroke-width="1.2"/>
    <path d="M ${P(0.81, 0.84).map(f1).join(' ')} Q ${P(0.62, 0.69).map(f1).join(' ')} ${P(0.40, 0.72).map(f1).join(' ')} Q ${P(0.33, 0.80).map(f1).join(' ')} ${P(0.25, 0.81).map(f1).join(' ')} L ${P(-0.06, 0.80).map(f1).join(' ')} Q ${P(-0.14, 0.79).map(f1).join(' ')} ${P(-0.13, 0.72).map(f1).join(' ')} L ${P(0.70, 0.72).map(f1).join(' ')} Z" fill="#17130f"/>
    <path d="M ${P(0.70, 0.81).map(f1).join(' ')} Q ${P(0.84, 1.0).map(f1).join(' ')} ${P(1.08, 1.01).map(f1).join(' ')} Q ${P(1.27, 1.0).map(f1).join(' ')} ${P(1.27, 0.86).map(f1).join(' ')} Q ${P(1.15, 0.79).map(f1).join(' ')} ${P(0.90, 0.79).map(f1).join(' ')} Z" fill="${paint}" stroke="${edge}" stroke-width="1.2"/>
    <path d="M ${P(0.86, 0.95).map(f1).join(' ')} Q ${P(1.0, 1.0).map(f1).join(' ')} ${P(1.16, 0.99).map(f1).join(' ')}" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="2"/>
    <path d="M ${P(1.165, 0.56).map(f1).join(' ')} Q ${P(1.30, 0.40).map(f1).join(' ')} ${P(1.10, 0.21).map(f1).join(' ')} L ${P(-0.25, 0.265).map(f1).join(' ')}" fill="none" stroke="url(#${ids.rim})" stroke-width="8" stroke-linecap="round"/>
    <path d="M ${P(0.73, 0.56).map(f1).join(' ')} Q ${P(0.55, 0.42).map(f1).join(' ')} ${P(0.30, 0.40).map(f1).join(' ')} L ${P(-0.31, 0.398).map(f1).join(' ')}" fill="none" stroke="url(#${ids.rim})" stroke-width="8" stroke-linecap="round"/>
    <path d="${line(P, [[0.98, 0.30], [1.30, 0.30]])}" stroke="#101113" stroke-width="6" stroke-linecap="round"/>
    <path d="${line(P, [[1.625, 0.32], [1.20, 0.99]])}" stroke="url(#${ids.spoke})" stroke-width="8" stroke-linecap="round"/>
    <path d="${line(P, [[1.18, 1.0], [1.18, 1.09], [0.95, 1.10]])}" fill="none" stroke="url(#${ids.rim})" stroke-width="4" stroke-linejoin="round"/>
    <path d="${line(P, [[0.99, 1.10], [0.93, 1.10]])}" stroke="#101113" stroke-width="7" stroke-linecap="round"/>
    <circle cx="${f1(P(1.37, 0.905)[0])}" cy="${f1(P(1.37, 0.905)[1])}" r="18" fill="url(#${ids.rim})"/>
    <path d="M ${P(1.40, 0.99).map(f1).join(' ')} A 17 17 0 0 1 ${P(1.40, 0.82).map(f1).join(' ')} Z" fill="#eef6ff"/>
    <circle cx="${f1(P(1.42, 0.80)[0])}" cy="${f1(P(1.42, 0.80)[1])}" r="4" fill="#ffa21a"/>
    <path d="${poly(P, [[-0.36, 0.58], [-0.30, 0.60], [-0.31, 0.55], [-0.37, 0.53]])}" fill="#b3121b"/>`;
  return { parts, wheels: spokeWheel(rx, ry, r, ids) + spokeWheel(fx, fy, r * 0.985, ids), ground: 240, w: [rx, fx], r };
}
function powersportSvg(type, color, { label = '', reflection = true, cls = '' } = {}) {
  const u = `c${++uidN}`;
  const ids = { body: `${u}b`, rim: `${u}r`, spoke: `${u}s`, car: `${u}car`, fade: `${u}f`, glare: `${u}gl` };
  const art = powersportArt(MOTO.has(type) ? 'cruiser' : type, color, ids);
  const g = art.ground;
  return `<svg class="car-art car-${type} ${cls}" viewBox="0 0 600 300" role="img" aria-label="${label.replace(/"/g, '&quot;')}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="${ids.body}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${lighten(color, 0.38)}"/><stop offset=".45" stop-color="${color}"/><stop offset="1" stop-color="${darken(color, 0.45)}"/>
    </linearGradient>
    <radialGradient id="${ids.rim}" cx=".4" cy=".35" r=".8">
      <stop offset="0" stop-color="#f3f6f9"/><stop offset=".55" stop-color="#a9b1bb"/><stop offset="1" stop-color="#5b626b"/>
    </radialGradient>
    <linearGradient id="${ids.spoke}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#8c949e"/><stop offset=".5" stop-color="#e9edf2"/><stop offset="1" stop-color="#7d858f"/>
    </linearGradient>
    <linearGradient id="${ids.fade}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".5"/><stop offset=".35" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <mask id="${ids.glare}"><rect x="0" y="${g}" width="600" height="${300 - g}" fill="url(#${ids.fade})"/></mask>
  </defs>
  <ellipse cx="300" cy="${g + 2}" rx="250" ry="10" fill="#000" opacity=".55"/>
  ${art.w.map(x => `<ellipse cx="${f1(x)}" cy="${g}" rx="${f1(art.r + 6)}" ry="5" fill="#000" opacity=".6"/>`).join('')}
  <g id="${ids.car}">${art.parts}${art.wheels}</g>
  ${reflection ? `<g mask="url(#${ids.glare})" opacity=".8"><use href="#${ids.car}" transform="translate(0 ${2 * g + 2}) scale(1 -1)"/></g>` : ''}
</svg>`;
}

function wheel(cx, cy, r, ids) {
  const spokes = [];
  const n = 6, rim = r * 0.62;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 360;
    spokes.push(`<path d="M ${-r * 0.07} ${-r * 0.14} L ${-r * 0.1} ${-rim + 2} L ${r * 0.1} ${-rim + 2} L ${r * 0.07} ${-r * 0.14} Z" transform="rotate(${a})" fill="url(#${ids.spoke})"/>`);
  }
  return `<g class="wheel" transform="translate(${cx} ${cy})">
    <circle r="${r}" fill="#0d0f12"/>
    <circle r="${r - 4}" fill="none" stroke="#24282e" stroke-width="3"/>
    <circle r="${r - 9}" fill="none" stroke="#15181c" stroke-width="2"/>
    <circle r="${rim}" fill="url(#${ids.rim})"/>
    <circle r="${rim - 3}" fill="#1a1d22" opacity=".55"/>
    <path d="M ${rim * 0.25} ${-rim * 0.7} A ${rim * 0.75} ${rim * 0.75} 0 0 1 ${rim * 0.7} ${-rim * 0.2}" stroke="#b22" stroke-width="${r * 0.16}" fill="none" opacity=".85"/>
    ${spokes.join('')}
    <circle r="${rim}" fill="none" stroke="#dfe5ec" stroke-width="2" opacity=".8"/>
    <circle r="${r * 0.16}" fill="url(#${ids.rim})" stroke="#5d646d" stroke-width="1.5"/>
    <circle r="${r * 0.05}" fill="#3b4048"/>
    <path d="M ${-r * 0.8} ${-r * 0.35} A ${r * 0.88} ${r * 0.88} 0 0 1 ${-r * 0.2} ${-r * 0.86}" stroke="#fff" stroke-width="2" fill="none" opacity=".12"/>
  </g>`;
}

const ALIASES = { van: 'minivan', truck: 'pickup', crossover: 'suv', wagon: 'hatchback', hatch: 'hatchback' };

export function carSvg(type, color = '#8a8f98', { label = '', reflection = true, cls = '' } = {}) {
  if (MOTO.has(type) || type === 'utv' || type === 'atv') return powersportSvg(type, color, { label, reflection, cls });
  type = SHAPES[type] ? type : ALIASES[type] || 'sedan';
  const s = SHAPES[type];
  const u = `c${++uidN}`;
  const ids = { body: `${u}b`, glass: `${u}g`, rim: `${u}r`, spoke: `${u}s`, clip: `${u}c`, shine: `${u}h`, glow: `${u}w`, fade: `${u}f`, car: `${u}car`, mask: `${u}m`, glare: `${u}gl` };
  const top = lighten(color, 0.38), mid = color, low = darken(color, 0.45), edge = darken(color, 0.6);
  const [w1, w2] = s.wheels;
  const wells = s.wheels.map(x => `<circle cx="${x}" cy="${s.cy}" r="${s.arch - 1}" fill="#08090b"/>`).join('');
  const flares = s.cladding
    ? s.wheels.map(x => `<path d="M ${x - s.arch - 3} ${s.cy} A ${s.arch + 3} ${s.arch + 3} 0 0 1 ${x + s.arch + 3} ${s.cy}" fill="none" stroke="#3a3e45" stroke-width="9"/>`).join('')
    : s.wheels.map(x => `<path d="M ${x - s.arch} ${s.cy} A ${s.arch} ${s.arch} 0 0 1 ${x + s.arch} ${s.cy}" fill="none" stroke="${edge}" stroke-width="3" opacity=".7"/>`).join('');
  const car = `<g id="${ids.car}">
    <g class="car-body">
      ${wells}
      <path d="${s.body}" fill="url(#${ids.body})"/>
      <g clip-path="url(#${ids.clip})">
        ${s.sail ? `<path d="${s.sail}" fill="${darken(color, 0.18)}"/>` : ''}
        ${s.bed ? `<path d="${s.bed}" fill="${darken(color, 0.55)}"/>` : ''}
        <rect x="0" y="${s.rocker}" width="600" height="40" fill="${s.cladding ? '#33373d' : low}" opacity="${s.cladding ? 1 : 0.85}"/>
        ${s.cladding ? `<rect x="0" y="${s.rocker}" width="600" height="2" fill="#4a4f57"/>` : ''}
        <path d="${s.character}" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width="2"/>
        <path d="${s.character}" fill="none" stroke="${edge}" stroke-opacity=".35" stroke-width="1.2" transform="translate(0 3)"/>
        <rect x="-200" y="40" width="160" height="200" fill="url(#${ids.shine})" class="car-sheen" transform="skewX(-20)"/>
      </g>
      <path d="${s.glass}" fill="url(#${ids.glass})"/>
      <g clip-path="url(#${ids.mask})">
        <path d="M 0 140 L 140 0 L 175 0 L 35 140 Z" fill="#fff" opacity=".10" transform="translate(${type === 'pickup' || type === 'suv' ? 250 : 120} 0)"/>
        <path d="M 0 140 L 140 0 L 152 0 L 12 140 Z" fill="#fff" opacity=".08" transform="translate(${type === 'pickup' || type === 'suv' ? 300 : 190} 0)"/>
      </g>
      ${s.pillars.map(p => `<path d="${p}" fill="${darken(color, 0.25)}"/>`).join('')}
      ${s.rail ? `<path d="${s.rail}" fill="#22262b"/>` : ''}
      ${s.spoiler ? `<path d="${s.spoiler}" fill="${darken(color, 0.3)}"/>` : ''}
      ${s.seams.map(p => `<path d="${p}" fill="none" stroke="${edge}" stroke-width="1.3" opacity=".8"/>`).join('')}
      ${s.handles.map(([x, y]) => `<rect x="${x}" y="${y}" width="18" height="4" rx="2" fill="${darken(color, 0.4)}"/><rect x="${x + 1}" y="${y}" width="16" height="1.3" rx=".6" fill="#fff" opacity=".25"/>`).join('')}
      <path d="${s.mirror}" fill="${darken(color, 0.15)}" stroke="${edge}" stroke-width="1"/>
      ${flares}
      <path d="${s.grille}" fill="#15171a"/>
      <path d="${s.head}" fill="#eef6ff"/>
      <path d="${s.head}" fill="#bfe3ff" class="car-headlight" filter="url(#${ids.glow})"/>
      <path d="${s.tail}" fill="#b3121b"/>
      <path d="${s.tail}" fill="#ff3b3b" class="car-taillight" filter="url(#${ids.glow})" opacity=".6"/>
      <path d="${s.body}" fill="none" stroke="${edge}" stroke-width="1.5" opacity=".9"/>
    </g>
    ${wheel(w1, s.cy, s.r, ids)}${wheel(w2, s.cy, s.r, ids)}
  </g>`;
  return `<svg class="car-art car-${type} ${cls}" viewBox="0 0 600 300" role="img" aria-label="${label.replace(/"/g, '&quot;')}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="${ids.body}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${top}"/><stop offset=".42" stop-color="${mid}"/><stop offset=".75" stop-color="${darken(color, 0.22)}"/><stop offset="1" stop-color="${low}"/>
    </linearGradient>
    <linearGradient id="${ids.glass}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3a4e66"/><stop offset=".55" stop-color="#16202c"/><stop offset="1" stop-color="#0b1017"/>
    </linearGradient>
    <radialGradient id="${ids.rim}" cx=".4" cy=".35" r=".8">
      <stop offset="0" stop-color="#f3f6f9"/><stop offset=".55" stop-color="#a9b1bb"/><stop offset="1" stop-color="#5b626b"/>
    </radialGradient>
    <linearGradient id="${ids.spoke}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#8c949e"/><stop offset=".5" stop-color="#e9edf2"/><stop offset="1" stop-color="#7d858f"/>
    </linearGradient>
    <linearGradient id="${ids.shine}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="${ids.fade}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".5"/><stop offset=".35" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <mask id="${ids.glare}"><rect x="0" y="240" width="600" height="60" fill="url(#${ids.fade})"/></mask>
    <clipPath id="${ids.clip}"><path d="${s.body}"/></clipPath>
    <clipPath id="${ids.mask}"><path d="${s.glass}"/></clipPath>
    <filter id="${ids.glow}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4"/></filter>
  </defs>
  <ellipse cx="300" cy="${s.cy + s.r + 2}" rx="265" ry="11" fill="#000" opacity=".55"/>
  <ellipse cx="${w1}" cy="${s.cy + s.r}" rx="${s.r + 8}" ry="5" fill="#000" opacity=".6"/>
  <ellipse cx="${w2}" cy="${s.cy + s.r}" rx="${s.r + 8}" ry="5" fill="#000" opacity=".6"/>
  ${car}
  ${reflection ? `<g mask="url(#${ids.glare})" opacity=".8"><use href="#${ids.car}" transform="translate(0 ${2 * (s.cy + s.r) + 2}) scale(1 -1)"/></g>` : ''}
</svg>`;
}

export const BODY_LABELS = {
  sedan: 'Sedan', coupe: 'Coupe', hatchback: 'Hatchback', minivan: 'Minivan', suv: 'SUV', pickup: 'Pickup',
  cruiser: 'Cruiser motorcycle', sport: 'Sport motorcycle', dualsport: 'Dual-sport motorcycle', scooter: 'Scooter',
  utv: 'Side-by-side (UTV)', atv: 'ATV',
};
