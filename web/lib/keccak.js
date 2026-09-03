// keccak256, because the browser does not have one and the console needs to derive
// its own function selectors.
//
// Hardcoding selectors was the alternative, and it is the worse one: a mistyped
// selector does not throw, it calls nothing and returns empty, so the UI silently
// shows a zero instead of failing. Deriving them from the signature makes that
// class of bug impossible — and `worker/test/selectors.test.js` checks every
// signature this app uses against the values `cast sig` prints, so the
// implementation below is pinned to the real thing rather than trusted.
//
// Keccak-f[1600], rate 136 bytes, 0x01 padding — Ethereum's variant, not the NIST
// SHA3-256 one, which is the same permutation with 0x06 padding.

const RC = [
  0x00000001, 0x00000000, 0x00008082, 0x00000000, 0x0000808a, 0x80000000, 0x80008000, 0x80000000,
  0x0000808b, 0x00000000, 0x80000001, 0x00000000, 0x80008081, 0x80000000, 0x00008009, 0x80000000,
  0x0000008a, 0x00000000, 0x00000088, 0x00000000, 0x80008009, 0x00000000, 0x8000000a, 0x00000000,
  0x8000808b, 0x00000000, 0x0000008b, 0x80000000, 0x00008089, 0x80000000, 0x00008003, 0x80000000,
  0x00008002, 0x80000000, 0x00000080, 0x80000000, 0x0000800a, 0x00000000, 0x8000000a, 0x80000000,
  0x80008081, 0x80000000, 0x00008080, 0x80000000, 0x80000001, 0x00000000, 0x80008008, 0x80000000,
];

// Rotation offsets, indexed [y * 5 + x].
const R = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];

// The state is 25 lanes of 64 bits, held as 50 32-bit words: [lo0, hi0, lo1, hi1, …].
function keccakF(s) {
  const C = new Uint32Array(10);
  const D = new Uint32Array(10);
  const B = new Uint32Array(50);

  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) {
      const i = x * 2;
      C[i] = s[i] ^ s[i + 10] ^ s[i + 20] ^ s[i + 30] ^ s[i + 40];
      C[i + 1] = s[i + 1] ^ s[i + 11] ^ s[i + 21] ^ s[i + 31] ^ s[i + 41];
    }
    for (let x = 0; x < 5; x++) {
      const i = x * 2;
      const p = ((x + 4) % 5) * 2;
      const n = ((x + 1) % 5) * 2;
      D[i] = C[p] ^ (((C[n] << 1) | (C[n + 1] >>> 31)) >>> 0);
      D[i + 1] = C[p + 1] ^ (((C[n + 1] << 1) | (C[n] >>> 31)) >>> 0);
    }
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const i = (y * 5 + x) * 2;
        s[i] ^= D[x * 2];
        s[i + 1] ^= D[x * 2 + 1];
      }
    }

    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const i = (y * 5 + x) * 2;
        const r = R[y * 5 + x];
        const dst = (((2 * x + 3 * y) % 5) * 5 + y) * 2;
        let lo;
        let hi;
        if (r === 0) {
          lo = s[i];
          hi = s[i + 1];
        } else if (r < 32) {
          lo = ((s[i] << r) | (s[i + 1] >>> (32 - r))) >>> 0;
          hi = ((s[i + 1] << r) | (s[i] >>> (32 - r))) >>> 0;
        } else if (r === 32) {
          lo = s[i + 1];
          hi = s[i];
        } else {
          const q = r - 32;
          lo = ((s[i + 1] << q) | (s[i] >>> (32 - q))) >>> 0;
          hi = ((s[i] << q) | (s[i + 1] >>> (32 - q))) >>> 0;
        }
        B[dst] = lo;
        B[dst + 1] = hi;
      }
    }

    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const i = (y * 5 + x) * 2;
        const a = (y * 5 + ((x + 1) % 5)) * 2;
        const b = (y * 5 + ((x + 2) % 5)) * 2;
        s[i] = B[i] ^ (~B[a] & B[b]);
        s[i + 1] = B[i + 1] ^ (~B[a + 1] & B[b + 1]);
      }
    }

    s[0] ^= RC[round * 2];
    s[1] ^= RC[round * 2 + 1];
  }
}

/// keccak256 over raw bytes. Returns 32 bytes.
export function keccak256(bytes) {
  const RATE = 136;
  const s = new Uint32Array(50);

  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / RATE) * RATE);
  padded.set(bytes);
  padded[bytes.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE; i += 4) {
      const w =
        padded[off + i] | (padded[off + i + 1] << 8) | (padded[off + i + 2] << 16) | (padded[off + i + 3] << 24);
      s[i / 4] ^= w >>> 0;
    }
    keccakF(s);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 4) {
    const w = s[i / 4];
    out[i] = w & 0xff;
    out[i + 1] = (w >>> 8) & 0xff;
    out[i + 2] = (w >>> 16) & 0xff;
    out[i + 3] = (w >>> 24) & 0xff;
  }
  return out;
}

export const toHex = (bytes) => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

export const utf8 = (s) => new TextEncoder().encode(s);

/// The first four bytes of keccak256(signature) — an Ethereum function selector.
export function selector(signature) {
  return toHex(keccak256(utf8(signature)).slice(0, 4));
}

/// keccak256 of a UTF-8 string, as 0x-hex.
export function keccakHex(text) {
  return toHex(keccak256(utf8(text)));
}
