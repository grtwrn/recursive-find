// Generates the extension's PNG icons procedurally (no external deps).
// Draws a magnifying glass with a recursive "orbit" motif on the accent bg.
// Run: node gen_icons.js
const zlib = require("zlib");
const fs = require("fs");

// --- minimal PNG encoder (truecolor + alpha) ---
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- drawing ---
function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const S = size;
  const cx = S * 0.42, cy = S * 0.42; // lens center
  const R = S * 0.26; // lens radius
  const ring = Math.max(1.2, S * 0.07); // ring thickness
  const accent = [124, 108, 255];
  const white = [244, 244, 250];
  const dot = [61, 220, 151]; // recursion accent dot

  function px(x, y, [r, g, b], a = 1) {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    const ia = 1 - a;
    buf[i] = Math.round(buf[i] * ia + r * a);
    buf[i + 1] = Math.round(buf[i + 1] * ia + g * a);
    buf[i + 2] = Math.round(buf[i + 2] * ia + b * a);
    buf[i + 3] = Math.max(buf[i + 3], Math.round(255 * a));
  }

  const rad = S * 0.22; // corner radius for rounded square bg
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // rounded-rect background
      const dxl = Math.max(rad - x, x - (S - 1 - rad), 0);
      const dyl = Math.max(rad - y, y - (S - 1 - rad), 0);
      const corner = Math.hypot(dxl, dyl);
      let bgA = corner <= rad ? 1 : Math.max(0, 1 - (corner - rad));
      if (bgA > 0) px(x, y, accent, bgA);

      // magnifying glass handle (thick diagonal from lens toward bottom-right)
      const hx0 = cx + Math.cos(Math.PI / 4) * R;
      const hy0 = cy + Math.sin(Math.PI / 4) * R;
      const hx1 = S * 0.82, hy1 = S * 0.82;
      const t = clamp(
        ((x - hx0) * (hx1 - hx0) + (y - hy0) * (hy1 - hy0)) /
          ((hx1 - hx0) ** 2 + (hy1 - hy0) ** 2),
        0, 1
      );
      const px_ = hx0 + t * (hx1 - hx0), py_ = hy0 + t * (hy1 - hy0);
      const hd = Math.hypot(x - px_, y - py_);
      if (hd < ring * 0.9) px(x, y, white, clamp(ring * 0.9 - hd, 0, 1));

      // lens ring
      const d = Math.hypot(x - cx, y - cy);
      const ringA = clamp(ring / 2 - Math.abs(d - R), 0, 1);
      if (ringA > 0) px(x, y, white, ringA);
    }
  }

  // recursion dot orbiting inside the lens
  if (S >= 32) {
    const ddx = cx + R * 0.35, ddy = cy - R * 0.35;
    const dr = Math.max(1, S * 0.05);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const d = Math.hypot(x - ddx, y - ddy);
        if (d < dr) px(x, y, dot, clamp(dr - d, 0, 1));
      }
  }
  return encodePNG(S, S, buf);
}
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

fs.mkdirSync("icons", { recursive: true });
for (const s of [16, 32, 48, 128]) {
  fs.writeFileSync(`icons/icon${s}.png`, draw(s));
  console.log(`icons/icon${s}.png`);
}
