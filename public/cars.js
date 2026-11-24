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
};

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
        <path d="M 0 140 L 140 0 L 175 0 L 35 140 Z" fill="#fff" opacity=".10" transform="translate(${type === 'pickup' ? 250 : 120} 0)"/>
        <path d="M 0 140 L 140 0 L 152 0 L 12 140 Z" fill="#fff" opacity=".08" transform="translate(${type === 'pickup' ? 300 : 190} 0)"/>
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

export const BODY_LABELS = { sedan: 'Sedan', coupe: 'Coupe', hatchback: 'Hatchback', minivan: 'Minivan', suv: 'SUV', pickup: 'Pickup' };
