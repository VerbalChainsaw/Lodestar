// Generates the release artwork: the 1600x900 hero and the version-pinned 1254x1254
// social card.
//
// The encoder is hand-rolled rather than pulled from a dependency for two reasons: the
// package ships with no dependencies, and the release check admits only IHDR, pHYs,
// IDAT and IEND chunks. Most encoders add ancillary chunks (tEXt, gAMA, sRGB) that
// would fail that check, so emitting the chunk list directly is the reliable path.
//
// Usage:
//   node scripts/build-release-social.mjs <version>   # social card for that version
//   node scripts/build-release-social.mjs --hero      # docs/assets/lodestar-launch-hero.png
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HERO = process.argv.includes("--hero");
const version = HERO ? null : process.argv[2];
if (!HERO && !/^\d+\.\d+\.\d+$/u.test(version ?? "")) {
  throw new Error("Usage: build-release-social.mjs <x.y.z> | --hero");
}
const W = HERO ? 1600 : 1254;
const H = HERO ? 900 : 1254;
const OUT = HERO
  ? path.join(ROOT, "docs", "assets", "lodestar-launch-hero.png")
  : path.join(ROOT, "docs", "assets", `lodestar-v${version}-social.png`);

// Stroke font on a 0..1 box. Each glyph is a list of polylines, rendered as round-capped
// strokes; distance-to-segment coverage anti-aliases without supersampling.
const G = {
  A: [[[0, 1], [0.5, 0], [1, 1]], [[0.18, 0.62], [0.82, 0.62]]],
  C: [[[1, 0.18], [0.5, 0], [0, 0.35], [0, 0.65], [0.5, 1], [1, 0.82]]],
  D: [[[0, 0], [0, 1]], [[0, 0], [0.55, 0.06], [1, 0.4], [1, 0.6], [0.55, 0.94], [0, 1]]],
  E: [[[1, 0], [0, 0], [0, 1], [1, 1]], [[0, 0.5], [0.75, 0.5]]],
  F: [[[1, 0], [0, 0], [0, 1]], [[0, 0.5], [0.72, 0.5]]],
  G: [[[1, 0.18], [0.5, 0], [0, 0.35], [0, 0.65], [0.5, 1], [1, 0.8], [1, 0.55], [0.6, 0.55]]],
  H: [[[0, 0], [0, 1]], [[1, 0], [1, 1]], [[0, 0.5], [1, 0.5]]],
  I: [[[0.5, 0], [0.5, 1]]],
  J: [[[0.75, 0], [0.75, 0.78], [0.4, 1], [0.05, 0.8]]],
  K: [[[0, 0], [0, 1]], [[1, 0], [0, 0.55]], [[0.32, 0.38], [1, 1]]],
  L: [[[0, 0], [0, 1], [1, 1]]],
  M: [[[0, 1], [0, 0], [0.5, 0.5], [1, 0], [1, 1]]],
  N: [[[0, 1], [0, 0], [1, 1], [1, 0]]],
  O: [[[0.5, 0], [1, 0.32], [1, 0.68], [0.5, 1], [0, 0.68], [0, 0.32], [0.5, 0]]],
  P: [[[0, 1], [0, 0], [0.7, 0], [1, 0.18], [1, 0.38], [0.7, 0.56], [0, 0.56]]],
  R: [[[0, 1], [0, 0], [0.7, 0], [1, 0.16], [1, 0.36], [0.7, 0.52], [0, 0.52]],
    [[0.5, 0.52], [1, 1]]],
  S: [[[1, 0.14], [0.5, 0], [0.06, 0.16], [0.06, 0.36], [0.94, 0.64], [0.94, 0.84],
    [0.5, 1], [0, 0.86]]],
  T: [[[0, 0], [1, 0]], [[0.5, 0], [0.5, 1]]],
  U: [[[0, 0], [0, 0.7], [0.5, 1], [1, 0.7], [1, 0]]],
  V: [[[0, 0], [0.5, 1], [1, 0]]],
  W: [[[0, 0], [0.22, 1], [0.5, 0.36], [0.78, 1], [1, 0]]],
  Y: [[[0, 0], [0.5, 0.5], [1, 0]], [[0.5, 0.5], [0.5, 1]]],
  0: [[[0.5, 0], [1, 0.32], [1, 0.68], [0.5, 1], [0, 0.68], [0, 0.32], [0.5, 0]]],
  1: [[[0.18, 0.2], [0.55, 0], [0.55, 1]], [[0.16, 1], [0.94, 1]]],
  2: [[[0, 0.2], [0.5, 0], [1, 0.22], [1, 0.4], [0, 1], [1, 1]]],
  3: [[[0, 0.15], [0.5, 0], [1, 0.2], [0.55, 0.45], [1, 0.7], [0.5, 1], [0, 0.85]]],
  4: [[[0.75, 0], [0.75, 1]], [[0.75, 0], [0, 0.68], [1, 0.68]]],
  5: [[[1, 0], [0.1, 0], [0.05, 0.42], [0.55, 0.34], [1, 0.56], [0.95, 0.85],
    [0.45, 1], [0, 0.85]]],
  6: [[[0.95, 0.1], [0.45, 0], [0.05, 0.36], [0.05, 0.8], [0.5, 1], [0.95, 0.8],
    [0.9, 0.55], [0.4, 0.45], [0.05, 0.6]]],
  7: [[[0, 0], [1, 0], [0.35, 1]]],
  8: [[[0.5, 0.45], [0.95, 0.2], [0.5, 0], [0.05, 0.2], [0.5, 0.45],
    [0.95, 0.72], [0.5, 1], [0.05, 0.72], [0.5, 0.45]]],
  9: [[[0.05, 0.9], [0.55, 1], [0.95, 0.64], [0.95, 0.2], [0.5, 0], [0.05, 0.2],
    [0.1, 0.45], [0.6, 0.55], [0.95, 0.4]]],
  ".": [[[0.5, 0.94], [0.5, 1]]],
  " ": [],
};

const px = new Float32Array(W * H * 3);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function blend(x, y, r, g, b, a) {
  if (a <= 0 || x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] += (r - px[i]) * a;
  px[i + 1] += (g - px[i + 1]) * a;
  px[i + 2] += (b - px[i + 2]) * a;
}

function add(x, y, r, g, b, a) {
  if (a <= 0 || x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = Math.min(255, px[i] + r * a);
  px[i + 1] = Math.min(255, px[i + 1] + g * a);
  px[i + 2] = Math.min(255, px[i + 2] + b * a);
}

const starX = W / 2;
const starY = HERO ? H * 0.40 : H * 0.505;
const ringY = HERO ? H * 0.735 : H * 0.79;
const ringRX = HERO ? W * 0.335 : W * 0.315;
const ringRY = HERO ? H * 0.105 : H * 0.085;

// Background: deep navy, radial lift toward the star, vignette at the corners.
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const dx = (x - starX) / W;
    const dy = (y - starY) / W;
    const d = Math.sqrt(dx * dx + dy * dy);
    const glow = clamp01(1 - d * 1.65) ** 2;
    const ex = (x - W / 2) / (W / 2);
    const ey = (y - H / 2) / (H / 2);
    const vignette = clamp01(1 - (ex * ex + ey * ey) * 0.33);
    const i = (y * W + x) * 3;
    px[i] = (5 + glow * 22) * vignette;
    px[i + 1] = (11 + glow * 40) * vignette;
    px[i + 2] = (23 + glow * 66) * vignette;
  }
}

function segDistance(pxx, pyy, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = pxx - ax;
  const wy = pyy - ay;
  const len = vx * vx + vy * vy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len));
  return Math.hypot(pxx - (ax + vx * t), pyy - (ay + vy * t));
}

function stroke(points, width, [r, g, b], alpha = 1, glow = 0) {
  const half = width / 2;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const pad = Math.ceil(half + glow + 2);
  for (let y = Math.floor(minY) - pad; y <= Math.ceil(maxY) + pad; y += 1) {
    for (let x = Math.floor(minX) - pad; x <= Math.ceil(maxX) + pad; x += 1) {
      let best = Infinity;
      for (let i = 0; i + 1 < points.length; i += 1) {
        const [ax, ay] = points[i];
        const [bx, by] = points[i + 1];
        best = Math.min(best, segDistance(x + 0.5, y + 0.5, ax, ay, bx, by));
        if (best <= half - 1) break;
      }
      if (glow > 0 && best < half + glow) {
        add(x, y, r, g, b, clamp01(1 - (best - half) / glow) ** 2 * 0.28 * alpha);
      }
      const coverage = clamp01(half + 0.5 - best);
      if (coverage > 0) blend(x, y, r, g, b, coverage * alpha);
    }
  }
}

function text(value, cx, top, glyphHeight, weight, colour, tracking = 0.34, glow = 0) {
  const chars = [...value.toUpperCase()];
  const w = glyphHeight * 0.66;
  const advance = w + glyphHeight * tracking;
  const total = chars.length * advance - glyphHeight * tracking;
  let x = cx - total / 2;
  for (const char of chars) {
    for (const line of G[char] ?? []) {
      stroke(line.map(([gx, gy]) => [x + gx * w, top + gy * glyphHeight]),
        weight, colour, 1, glow);
    }
    x += advance;
  }
}

// Beams from each ring node to the star, drawn before the star so it reads as the source.
const NODES = [0.14, 0.42, 0.58, 0.86, 1.14, 1.42, 1.58, 1.86].map((k) => k * Math.PI);
for (const angle of NODES) {
  const x = starX + Math.cos(angle) * ringRX;
  const y = ringY + Math.sin(angle) * ringRY;
  stroke([[x, y], [starX, starY]], 1.6, [70, 150, 200], 0.18);
}

// The lodestar: four-point star with a warm core and a soft bloom.
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const dx = Math.abs(x - starX);
    const dy = Math.abs(y - starY);
    const vertical = clamp01(1 - dx / 8) * clamp01(1 - dy / (H * (HERO ? 0.34 : 0.215)));
    const horizontal = clamp01(1 - dy / 8) * clamp01(1 - dx / (W * (HERO ? 0.24 : 0.235)));
    const core = clamp01(1 - Math.hypot(dx, dy) / (HERO ? 78 : 96)) ** 2.2;
    const bloom = clamp01(1 - Math.hypot(dx, dy) / (HERO ? 240 : 210)) ** 3 * 0.30;
    const a = clamp01(vertical ** 1.5 + horizontal ** 1.5 + core + bloom);
    if (a > 0.002) add(x, y, 255, 190 + core * 46, 110 + core * 100, a * 0.95);
  }
}

// Orbit ring: one registry every capability resolves through.
for (let t = 0; t < 5200; t += 1) {
  const angle = (t / 5200) * Math.PI * 2;
  const x = starX + Math.cos(angle) * ringRX;
  const y = ringY + Math.sin(angle) * ringRY;
  const warm = Math.sin(angle) > 0;
  stroke([[x, y], [x, y]], 4.4, warm ? [255, 184, 92] : [92, 194, 236], 0.5);
}

for (const angle of NODES) {
  const x = starX + Math.cos(angle) * ringRX;
  const y = ringY + Math.sin(angle) * ringRY;
  const s = HERO ? 26 : 30;
  stroke([[x, y - s], [x + s, y], [x, y + s], [x - s, y], [x, y - s]],
    4.6, [122, 216, 248], 0.95, 7);
  stroke([[x, y], [x, y]], 11, [255, 202, 132], 0.92);
}

if (HERO) {
  text("LODESTAR", W / 2, H * 0.075, 112, 18, [246, 250, 255], 0.34, 10);
  text("ONE CLI FOR AGENT PROJECT STATE", W / 2, H * 0.235, 26, 4.6, [132, 210, 238], 0.5);
} else {
  text("LODESTAR", W / 2, H * 0.093, 112, 18, [245, 249, 255], 0.34, 9);
  text(version, W / 2, H * 0.232, 50, 8, [255, 186, 96]);
  text("START KNOW WORK DECIDE HANDOFF", W / 2, H * 0.305, 24, 4.5, [128, 208, 236], 0.5);
}

// Encode: 8-bit RGB, filter type 0 per scanline.
const raw = Buffer.alloc(H * (W * 3 + 1));
let o = 0;
for (let y = 0; y < H; y += 1) {
  raw[o] = 0;
  o += 1;
  for (let x = 0; x < W; x += 1) {
    const i = (y * W + x) * 3;
    raw[o] = Math.round(clamp01(px[i] / 255) * 255);
    raw[o + 1] = Math.round(clamp01(px[i + 1] / 255) * 255);
    raw[o + 2] = Math.round(clamp01(px[i + 2] / 255) * 255);
    o += 3;
  }
}

const CRC = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return (buffer) => {
    let c = -1;
    for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body));
  return Buffer.concat([length, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const phys = Buffer.alloc(9);
phys.writeUInt32BE(2835, 0);
phys.writeUInt32BE(2835, 4);
phys[8] = 1;

writeFileSync(OUT, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("pHYs", phys),
  chunk("IDAT", deflateSync(raw, { level: 6 })),
  chunk("IEND", Buffer.alloc(0)),
]));
console.log(`wrote ${OUT}`);
