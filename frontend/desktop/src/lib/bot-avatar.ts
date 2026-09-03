/* Deterministic identicon avatars for Bots (mirror of roster.avatar_svg).
 *
 * Same name (+salt) → identical SVG bytes. Pure hash math — zero storage,
 * zero network, no deps. The backend endpoint exists for parity; the client
 * renders locally so roster rows never wait on a fetch.
 */

const PALETTE: Array<[string, string]> = [
  ['#6d28d9', '#a78bfa'],
  ['#0f766e', '#5eead4'],
  ['#b45309', '#fcd34d'],
  ['#be123c', '#fda4af'],
  ['#1d4ed8', '#93c5fd'],
  ['#4d7c0f', '#bef264'],
  ['#701a75', '#f0abfc'],
  ['#0e7490', '#67e8f9'],
];

function hexPairs(input: string): number[] {
  // SHA-256 → 64 hex chars → 8 points in [0,1) from the FIRST 32 hex chars
  // (step 4) — MUST mirror roster._hash_points
  // (backend-py/app/services/bot_mode/roster.py: range(0, 32, 4)) byte-for-byte
  // so the rail and the server-rendered avatar are the same face.
  const raw = sha256(input);
  const out: number[] = [];
  for (let i = 0; i < 32; i += 4) {
    out.push(parseInt(raw.slice(i, i + 4), 16) / 0xffff);
  }
  return out;
}

/** SHA-256 of a UTF-8 string → lowercase hex (no deps; pure TS, sync so the
 *  roster render path stays synchronous). */
function sha256(text: string): string {
  // UTF-8 encode without TextEncoder allocation churn per call is overkill;
  // correctness first: bytes must match Python's `.encode('utf-8')`.
  const bytes: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) {
      bytes.push(cp);
    } else if (cp < 0x800) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  // 64-bit big-endian length (high 32 bits first; JS length can't reach 2^53).
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  bytes.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff);
  bytes.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);

  // Initial hash values (FIPS 180-4 §5.3.3).
  let h0 = 0x6a09e667,
    h1 = 0xbb67ae85,
    h2 = 0x3c6ef372,
    h3 = 0xa54ff53a,
    h4 = 0x510e527f,
    h5 = 0x9b05688c,
    h6 = 0x1f83d9ab,
    h7 = 0x5be0cd19;
  // Round constants (FIPS 180-4 §4.2.2).
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const rotr = (x: number, n: number) => ((x >>> n) | (x << (32 - n))) >>> 0;
  const w = new Array<number>(64);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      const b = off + i * 4;
      w[i] = ((bytes[b] << 24) | (bytes[b + 1] << 16) | (bytes[b + 2] << 8) | bytes[b + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4,
      f = h5,
      g = h6,
      h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((x) => x.toString(16).padStart(8, '0'))
    .join('');
}

/** Same name (+salt) → identical blob-face SVG. */
export function botAvatarSvg(name: string, salt = ''): string {
  const points = hexPairs(`${salt}:${name}`);
  const [fg, bg] = PALETTE[Math.floor(points[0] * PALETTE.length) % PALETTE.length];
  const cx = 32;
  const cy = 32;
  const verts: string[] = [];
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * 2 * Math.PI;
    const r = 20 + (points[(i % 7) + 1] - 0.5) * 10;
    verts.push(`${(cx + r * Math.cos(ang)).toFixed(2)} ${(cy + r * Math.sin(ang)).toFixed(2)}`);
  }
  const path = `M ${verts.join(' L ')} Z`;
  const eyeY = cy - 2;
  const eyeDx = 5.5 + points[2] * 3;
  const eyeR = 2.2 + points[3] * 1.5;
  const smileW = 8 + points[4] * 4;
  const smileY = cy + 7 + points[5] * 2;
  const smileR = smileW * (0.8 + points[6] * 0.3);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="${escapeAttr(name)} avatar">` +
    `<path d="${path}" fill="${bg}"/>` +
    `<circle cx="${(cx - eyeDx).toFixed(2)}" cy="${eyeY.toFixed(2)}" r="${eyeR.toFixed(2)}" fill="${fg}"/>` +
    `<circle cx="${(cx + eyeDx).toFixed(2)}" cy="${eyeY.toFixed(2)}" r="${eyeR.toFixed(2)}" fill="${fg}"/>` +
    `<path d="M ${(cx - smileW).toFixed(2)} ${smileY.toFixed(2)} ` +
    `A ${smileR.toFixed(2)} ${smileR.toFixed(2)} 0 0 1 ${(cx + smileW).toFixed(2)} ${smileY.toFixed(2)}" ` +
    `stroke="${fg}" stroke-width="2.6" stroke-linecap="round" fill="none"/>` +
    `</svg>`
  );
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Inline the SVG as a data URL for <img src> (or render via dangerouslySetInnerHTML). */
export function botAvatarDataUrl(name: string, salt = ''): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(botAvatarSvg(name, salt))}`;
}
