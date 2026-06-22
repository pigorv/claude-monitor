import { Buffer } from 'node:buffer';
import { deflateRawSync } from 'node:zlib';

// ── Zip writer ──────────────────────────────────────────────────────
//
// Dependency-free, spec-correct minimal ZIP writer over `node:zlib`.
// Produces local file headers + DEFLATE payloads (method 8, via
// `deflateRawSync`), a central directory, and an EOCD record. Falls back
// to store (method 0) per-entry when deflate does not shrink the data.
// CRC-32 is computed in-module (no reliance on `zlib.crc32`, which is
// not guaranteed across Node >= 20). All integers are little-endian.

export interface ZipEntry {
  name: string;
  data: Buffer;
}

// Fixed DOS mod time/date (epoch-ish constant). 1980-01-01 00:00:00.
const DOS_TIME = 0;
const DOS_DATE = 0x21; // year 1980 (0), month 1, day 1.

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

// Precomputed CRC-32 table (polynomial 0xEDB88320, reflected).
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** Standard zip CRC-32 of `data` (polynomial 0xEDB88320). */
export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface PreparedEntry {
  nameBytes: Buffer;
  payload: Buffer;
  method: number; // 8 = deflate, 0 = store.
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number; // offset of this entry's local header.
}

/**
 * Build a standard ZIP archive from `entries`. Each entry is DEFLATE
 * compressed (method 8); if compression does not reduce size the raw
 * bytes are stored (method 0). The result is readable by ordinary unzip
 * tools and by an `inflateRawSync`-based reader.
 */
export function zipBuffer(entries: ZipEntry[]): Buffer {
  const localChunks: Buffer[] = [];
  const prepared: PreparedEntry[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const uncompressedSize = entry.data.length;
    const crc = crc32(entry.data);

    const deflated = deflateRawSync(entry.data);
    let method: number;
    let payload: Buffer;
    // Store fallback: only use deflate when it is strictly smaller.
    if (deflated.length >= uncompressedSize) {
      method = 0;
      payload = entry.data;
    } else {
      method = 8;
      payload = deflated;
    }
    const compressedSize = payload.length;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(SIG_LOCAL, 0);
    header.writeUInt16LE(20, 4); // version needed to extract (2.0).
    header.writeUInt16LE(0, 6); // general purpose bit flag.
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressedSize, 18);
    header.writeUInt32LE(uncompressedSize, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28); // extra field length.

    localChunks.push(header, nameBytes, payload);

    prepared.push({
      nameBytes,
      payload,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      offset,
    });

    offset += header.length + nameBytes.length + payload.length;
  }

  const centralOffset = offset;
  const centralChunks: Buffer[] = [];
  let centralSize = 0;

  for (const e of prepared) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(SIG_CENTRAL, 0);
    header.writeUInt16LE(20, 4); // version made by.
    header.writeUInt16LE(20, 6); // version needed to extract.
    header.writeUInt16LE(0, 8); // general purpose bit flag.
    header.writeUInt16LE(e.method, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(e.crc, 16);
    header.writeUInt32LE(e.compressedSize, 20);
    header.writeUInt32LE(e.uncompressedSize, 24);
    header.writeUInt16LE(e.nameBytes.length, 28);
    header.writeUInt16LE(0, 30); // extra field length.
    header.writeUInt16LE(0, 32); // file comment length.
    header.writeUInt16LE(0, 34); // disk number start.
    header.writeUInt16LE(0, 36); // internal file attributes.
    header.writeUInt32LE(0, 38); // external file attributes.
    header.writeUInt32LE(e.offset, 42); // relative offset of local header.

    centralChunks.push(header, e.nameBytes);
    centralSize += header.length + e.nameBytes.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4); // number of this disk.
  eocd.writeUInt16LE(0, 6); // disk with start of central directory.
  eocd.writeUInt16LE(prepared.length, 8); // entries on this disk.
  eocd.writeUInt16LE(prepared.length, 10); // total entries.
  eocd.writeUInt32LE(centralSize, 12); // size of central directory.
  eocd.writeUInt32LE(centralOffset, 16); // offset of central directory.
  eocd.writeUInt16LE(0, 20); // comment length.

  return Buffer.concat([...localChunks, ...centralChunks, eocd]);
}
