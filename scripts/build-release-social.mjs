// Generates the version-pinned social card for a release.
//
// The encoder is hand-rolled rather than pulled from a dependency for two reasons: the
// package ships with no dependencies, and the release check admits only IHDR, pHYs,
// IDAT and IEND chunks. Most encoders add ancillary chunks (tEXt, gAMA, sRGB) that
// would fail that check, so emitting the chunk list directly is the reliable path.
//
// Usage: node scripts/build-release-social.mjs <version> [--out <path>]
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SIZE = 1254;
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/u.test(version)) {
  throw new Error("Usage: build-release-social.mjs <x.y.z> [--out <path>]");
}
const outFlag = process.argv.indexOf("--out");
const OUT = outFlag > -1
  ? path.resolve(process.argv[outFlag + 1])
  : path.join(ROOT, "docs", "assets", `lodestar-v${version}-social.png`);

// Stroke font on a 0..1 box. Each glyph is a list of polylines, rendered as round-capped
// strokes; distance-to-segment coverage anti-aliases without supersampling.
const G = {
  A: [[[0, 1], [0.5, 0], [1, 1]], [[0.18, 0.62], [0.82, 0.62]]],
  C: [[[1, 0.18], [0.5, 0], [0, 0.35], [0, 0.65], [0.5, 1], [1, 0.82]]],
  D: [[[0, 0], [0, 1]], [[0, 0], [0.55, 0.06], [1, 0.4], [1, 0.6], [0.55, 0.94], [0, 1]]],
  E: [[[1, 0], [0, 0], [0, 1], [1, 1]], [[0, 0.5], [0.75, 0.5]]],
  F: [[[1, 0], [0, 0], [0, 1]], [[0, 0.5], [0.72, 0.5]]],
  H: [[[0, 0], [0, 1]], [[1, 0], [1, 1]], [[0, 0.5], [1, 0.5]]],
  I: [[[0.5, 0], [0.5, 1]]],
  K: [[[0, 0], [0, 1]], [[1, 0], [0, 0.55]], [[0.32, 0.38], [1, 1]]],
  L: [[[0, 0], [0, 1], [1, 1]]],
  N: [[[0, 1], [0, 0], [1, 1], [1, 0]]],
  O: [[[0.5, 0], [1, 0.32], [1, 0.68], [0.5, 1], [0, 0.68], [0, 0.32], [0.5, 0]]],
  R: [[[0, 1], [0, 0], [0.7, 0], [1, 0.16], [1, 0.36], [0.7, 0.52], [0, 0.52]],
    [[0.5, 0.52], [1, 1]]],
  S: [[[1, 0.14], [0.5, 0], [0.06, 0.16], [0.06, 0.36], [0.94, 0.64], [0.94, 0.84],
    [0.5, 1], [0, 0.86]]],
  T: [[[0, 0], [1, 0]], [[0.5, 0], [0.5, 1]]],
  W: [[[0, 0], [0.22, 1], [0.5, 0.36], [0.78, 1], [1, 0]]],
  0: [[[0.5, 0], [1, 0.32], [1, 0.68], [0.5, 1], [0, 0.68], [0, 0.32], [0.5, 0]]],
  1: [[[0.18, 0.2], [0.55, 0], [0.55, 1]], [[0.16, 1], [0.94, 1]]],
  2: [[[0, 0.2], [0.5, 0], [1, 0.22], [1, 0.4], [0, 1], [1, 1]]],
  ".": [[[0.5, 0.94], [0.5, 1]]],
  " ": [],
};

const px = new Float32Array(SIZE * SIZE * 3);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function blend(x, y, r, g, b, a) {
  if (a <= 0 || x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 3;
  px[i] += (r - px[i]) * a;
  px[i + 1] += (g - px[i + 1]) * a;
  px[i + 2] += (b - px[i + 2]) * a;
}

// Background: deep navy radial falloff with a subtle vertical lift, matching the
// established dark-blue identity of earlier release art.
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const dx = (x - SIZE / 2) / SIZE;
    const dy = (y - SIZE * 0.42) / SIZE;
    const d = Math.sqrt(dx * dx + dy * dy);
    const glow = clamp01(1 - d * 1.75) ** 2;
    const i = (y * SIZE + x) * 3;
    px[i] = 6 + glow * 20;
    px[i + 1] = 12 + glow * 38;
    px[i + 2] = 24 + glow * 62;
  }
}

function segDistance(pxx, pyy, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = pxx - ax;
  const wy = pyy - ay;
  const len = vx * vx + vy * vy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len));
  const cx = ax + vx * t;
  const cy = ay + vy * t;
  return Math.hypot(pxx - cx, pyy - cy);
}

function stroke(points, width, [r, g, b], alpha = 1) {
  const half = width / 2;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const pad = Math.ceil(half + 2);
  for (let y = Math.floor(minY) - pad; y <= Math.ceil(maxY) + pad; y += 1) {
    for (let x = Math.floor(minX) - pad; x <= Math.ceil(maxX) + pad; x += 1) {
      let best = Infinity;
      for (let i = 0; i + 1 < points.length; i += 1) {
        const [ax, ay] = points[i];
        const [bx, by] = points[i + 1];
        best = Math.min(best, segDistance(x + 0.5, y + 0.5, ax, ay, bx, by));
        if (best <= half - 1) break;
      }
      const coverage = clamp01(half + 0.5 - best);
      if (coverage > 0) blend(x, y, r, g, b, coverage * alpha);
    }
  }
}

function text(value, cx, top, glyphHeight, weight, colour, tracking = 0.34) {
  const chars = [...value.toUpperCase()];
  const w = glyphHeight * 0.66;
  const advance = w + glyphHeight * tracking;
  const total = chars.length * advance - glyphHeight * tracking;
  let x = cx - total / 2;
  for (const char of chars) {
    for (const line of G[char] ?? []) {
      stroke(line.map(([gx, gy]) => [x + gx * w, top + gy * glyphHeight]), weight, colour);
    }
    x += advance;
  }
}

// The lodestar itself: a four-point star with a warm core.
const starX = SIZE / 2;
const starY = SIZE * 0.505;
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const dx = Math.abs(x - starX);
    const dy = Math.abs(y - starY);
    const vertical = clamp01(1 - dx / 9) * clamp01(1 - dy / (SIZE * 0.215));
    const horizontal = clamp01(1 - dy / 9) * clamp01(1 - dx / (SIZE * 0.235));
    const core = clamp01(1 - Math.hypot(dx, dy) / 96) ** 2.2;
    const a = clamp01(vertical ** 1.5 + horizontal ** 1.5 + core);
    if (a > 0.002) blend(x, y, 255, 196 + core * 40, 120 + core * 90, a);
  }
}

// Orbit ring beneath the star, echoing the single-registry motif.
for (let t = 0; t < 4000; t += 1) {
  const angle = (t / 4000) * Math.PI * 2;
  const rx = SIZE * 0.315;
  const ry = SIZE * 0.085;
  const x = starX + Math.cos(angle) * rx;
  const y = SIZE * 0.79 + Math.sin(angle) * ry;
  const warm = Math.sin(angle) > 0;
  stroke([[x, y], [x, y]], 4.2, warm ? [255, 186, 96] : [96, 196, 235], 0.55);
}

// Four capability nodes on the ring: start, know, work, handoff — now joined by
// decisions and managed skills, so the nodes read as a set rather than a checklist.
for (const angle of [Math.PI * 0.18, Math.PI * 0.82, Math.PI * 1.18, Math.PI * 1.82]) {
  const x = starX + Math.cos(angle) * SIZE * 0.315;
  const y = SIZE * 0.79 + Math.sin(angle) * SIZE * 0.085;
  const s = 30;
  const diamond = [[x, y - s], [x + s, y], [x, y + s], [x - s, y], [x, y - s]];
  stroke(diamond, 5, [120, 214, 246], 0.95);
  stroke([[x, y], [x, y]], 12, [255, 200, 130], 0.9);
}

text("LODESTAR", SIZE / 2, SIZE * 0.093, 112, 18, [245, 249, 255]);
text(version, SIZE / 2, SIZE * 0.232, 50, 8, [255, 186, 96]);
text("START KNOW WORK DECIDE HANDOFF", SIZE / 2, SIZE * 0.305, 24, 4.5, [128, 208, 236], 0.5);

// Encode: 8-bit RGB, filter type 0 per scanline.
const raw = Buffer.alloc(SIZE * (SIZE * 3 + 1));
let o = 0;
for (let y = 0; y < SIZE; y += 1) {
  raw[o] = 0;
  o += 1;
  for (let x = 0; x < SIZE; x += 1) {
    const i = (y * SIZE + x) * 3;
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
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
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
