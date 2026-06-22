import { createHash, randomBytes } from 'node:crypto';

// ── Pseudonymizer ───────────────────────────────────────────────────
//
// Sanitization primitives for transcript export. Deterministic
// pseudonyms are stable within a single export (one seed) but differ
// across exports. The seed is the only secret: with no constructor
// argument a fresh `crypto.randomBytes(16)` is generated per instance
// (the production path). A fixed seed is permitted only via explicit
// test injection. There is no hardcoded/default seed constant, and the
// seed is never returned or logged.

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
const SCRAMBLE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789 ';
// Garbage chars: printable ASCII excluding `{` and whitespace.
const GARBAGE_ALPHABET =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`|}~';

export class Pseudonymizer {
  readonly #seed: Buffer;
  readonly #tokenCache = new Map<string, string>();

  constructor(seed?: Buffer) {
    // No default seed constant: when omitted we generate fresh randomness.
    this.#seed = seed ?? randomBytes(16);
  }

  /**
   * Deterministic pseudonym for a token. Maps `sha256(seed + ':' + s)`
   * bytes to `[a-z]`, emitting exactly `s.length` letters. Cached for
   * coherence and speed. Empty string → empty string.
   */
  pseudonymizeToken(s: string): string {
    if (s.length === 0) return '';

    const cached = this.#tokenCache.get(s);
    if (cached !== undefined) return cached;

    const out: string[] = [];
    let counter = 0;
    // Produce enough bytes for `s.length` letters by re-hashing with a
    // counter until we have enough material.
    while (out.length < s.length) {
      const hash = createHash('sha256')
        .update(this.#seed)
        .update(`:${s}:${counter}`)
        .digest();
      for (let i = 0; i < hash.length && out.length < s.length; i++) {
        out.push(ALPHABET[hash[i] % ALPHABET.length]);
      }
      counter++;
    }

    const result = out.join('');
    this.#tokenCache.set(s, result);
    return result;
  }

  /**
   * Pseudonymize a path while preserving `/` separators and the final
   * extension. Each non-empty segment is pseudonymized with
   * `pseudonymizeToken`; on the last segment a trailing extension
   * (substring from the last `.`, if any) is kept verbatim and only the
   * stem is pseudonymized. The empty leading segment of an absolute path
   * is preserved.
   */
  pseudonymizePath(p: string): string {
    const segments = p.split('/');
    const lastIndex = segments.length - 1;

    return segments
      .map((segment, index) => {
        if (segment.length === 0) return segment;
        if (index !== lastIndex) return this.pseudonymizeToken(segment);

        // Last segment: preserve extension (from last `.`), if any.
        const dot = segment.lastIndexOf('.');
        if (dot <= 0) {
          // No extension, or leading dot only (e.g. ".env"): scramble whole.
          return this.pseudonymizeToken(segment);
        }
        const stem = segment.slice(0, dot);
        const ext = segment.slice(dot);
        return this.pseudonymizeToken(stem) + ext;
      })
      .join('/');
  }

  /**
   * Pseudonymize an MCP tool name, keeping the `mcp__<server>__<tool>`
   * skeleton and internal `_` separators. Splits on `__`, keeps the
   * `mcp` prefix, and for each remaining `__`-part pseudonymizes its
   * `_`-delimited subtokens (preserving `_`). Non-MCP names (built-ins)
   * are returned unchanged.
   */
  pseudonymizeMcpName(name: string): string {
    if (!name.startsWith('mcp__')) return name;

    const parts = name.split('__');
    return parts
      .map((part, index) => {
        if (index === 0) return part; // keep 'mcp'
        return part
          .split('_')
          .map((sub) => (sub.length === 0 ? sub : this.pseudonymizeToken(sub)))
          .join('_');
      })
      .join('__');
  }

  /**
   * Non-deterministic, size-preserving scramble of free text. Produces
   * `s.length` random `[a-z0-9 ]` chars, then places exactly the source's
   * newline count of `\n`s at random positions. Preserves total char
   * count and newline count only — no word/punctuation structure.
   */
  scrambleText(s: string): string {
    const length = s.length;
    if (length === 0) return '';

    let newlines = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\n') newlines++;
    }

    const chars = new Array<string>(length);
    for (let i = 0; i < length; i++) {
      chars[i] = SCRAMBLE_ALPHABET[randomInt(SCRAMBLE_ALPHABET.length)];
    }

    // Place exactly `newlines` newlines at distinct random positions.
    const positions = new Set<number>();
    while (positions.size < newlines && positions.size < length) {
      positions.add(randomInt(length));
    }
    for (const pos of positions) {
      chars[pos] = '\n';
    }

    return chars.join('');
  }

  /**
   * Produce `len` random non-`{`, non-whitespace chars, for replacing
   * malformed lines.
   */
  garbageLine(len: number): string {
    if (len <= 0) return '';
    const chars = new Array<string>(len);
    for (let i = 0; i < len; i++) {
      chars[i] = GARBAGE_ALPHABET[randomInt(GARBAGE_ALPHABET.length)];
    }
    return chars.join('');
  }
}

/** Uniformly random integer in `[0, max)` without modulo bias. */
function randomInt(max: number): number {
  if (max <= 0) return 0;
  // Rejection sampling over a single byte range scaled per call. For our
  // small alphabets a 4-byte sample with rejection is simple and unbiased.
  const limit = Math.floor(0xffffffff / max) * max;
  let value: number;
  do {
    value = randomBytes(4).readUInt32BE(0);
  } while (value >= limit);
  return value % max;
}
