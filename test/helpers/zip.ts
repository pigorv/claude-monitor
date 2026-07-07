import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { inflateRawSync } from 'node:zlib';

// Shared minimal zip reader for tests. `zipBuffer` (src/export/zip.ts) is the
// only writer, so this parser only needs to handle what it emits: store
// (method 0) and raw-deflate (method 8) entries, no zip64, no archive comment.

const SIG_EOCD = 0x06054b50;
const SIG_LOCAL = 0x04034b50;

export interface ZipTestEntry {
  name: string;
  data: Buffer;
  method: number;
  crc: number;
}

/** Total entry count reported by the End-Of-Central-Directory record. */
export function readZipEntryCount(zip: Buffer): number {
  const eocdOffset = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocdOffset), SIG_EOCD, 'EOCD signature');
  return zip.readUInt16LE(eocdOffset + 10);
}

/**
 * Parse a zip produced by `zipBuffer` by walking the local file headers
 * sequentially, recovering each entry's bytes (inflating deflate entries).
 */
export function parseZip(zip: Buffer): ZipTestEntry[] {
  const eocdOffset = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocdOffset), SIG_EOCD, 'EOCD signature');
  const centralOffset = zip.readUInt32LE(eocdOffset + 16);

  const entries: ZipTestEntry[] = [];
  let pos = 0;
  while (pos < centralOffset) {
    assert.equal(zip.readUInt32LE(pos), SIG_LOCAL, 'local header signature');
    const method = zip.readUInt16LE(pos + 8);
    const crc = zip.readUInt32LE(pos + 14);
    const compressedSize = zip.readUInt32LE(pos + 18);
    const nameLen = zip.readUInt16LE(pos + 26);
    const extraLen = zip.readUInt16LE(pos + 28);
    const nameStart = pos + 30;
    const name = zip.toString('utf8', nameStart, nameStart + nameLen);
    const payloadStart = nameStart + nameLen + extraLen;
    const payload = zip.subarray(payloadStart, payloadStart + compressedSize);
    const data = method === 8 ? inflateRawSync(payload) : Buffer.from(payload);
    entries.push({ name, data, method, crc });
    pos = payloadStart + compressedSize;
  }
  return entries;
}

/** Convenience: entry names only, in archive order. */
export function zipEntryNames(zip: Buffer): string[] {
  return parseZip(zip).map((e) => e.name);
}
