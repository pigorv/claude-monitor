import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { inflateRawSync } from 'node:zlib';
import { crc32, zipBuffer, type ZipEntry } from '../../src/export/zip.js';

const SIG_EOCD = 0x06054b50;

/**
 * Parse a zip produced by `zipBuffer` by walking the local file headers
 * sequentially, recovering each entry's bytes. Returns the entries plus
 * the EOCD-reported total entry count.
 */
function parseZip(zip: Buffer): {
  entries: { name: string; data: Buffer; method: number; crc: number }[];
  eocdCount: number;
} {
  // Locate EOCD (no comment, so it is the trailing 22 bytes).
  const eocdOffset = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocdOffset), SIG_EOCD, 'EOCD signature');
  const eocdCount = zip.readUInt16LE(eocdOffset + 10);
  const centralOffset = zip.readUInt32LE(eocdOffset + 16);

  const entries: {
    name: string;
    data: Buffer;
    method: number;
    crc: number;
  }[] = [];

  let pos = 0;
  while (pos < centralOffset) {
    assert.equal(zip.readUInt32LE(pos), 0x04034b50, 'local header signature');
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

  return { entries, eocdCount };
}

describe('crc32', () => {
  it('matches known zlib/zip CRC-32 vectors', () => {
    assert.equal(crc32(Buffer.from('')), 0x00000000);
    // Standard CRC-32 of "123456789".
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
    assert.equal(crc32(Buffer.from('The quick brown fox jumps over the lazy dog')), 0x414fa339);
  });
});

describe('zipBuffer', () => {
  it('round-trips multi-entry archives with nested paths and store fallback (Behavior #9)', () => {
    const entries: ZipEntry[] = [
      // Highly compressible — should use deflate (method 8).
      { name: 'session.jsonl', data: Buffer.from('x'.repeat(2000), 'utf8') },
      // Nested subagent path mirroring real bundle layout.
      {
        name: 's/subagents/agent-1.jsonl',
        data: Buffer.from(JSON.stringify({ type: 'thinking', text: 'hi' }) + '\n', 'utf8'),
      },
      // Tiny/incompressible — should hit the store fallback (method 0).
      { name: 'tiny.bin', data: Buffer.from([0x42]) },
    ];

    const zip = zipBuffer(entries);
    const { entries: parsed, eocdCount } = parseZip(zip);

    assert.equal(eocdCount, entries.length, 'EOCD entry count');
    assert.equal(parsed.length, entries.length);

    for (let i = 0; i < entries.length; i++) {
      const input = entries[i];
      const out = parsed[i];
      assert.equal(out.name, input.name, `entry ${i} name`);
      assert.deepEqual(out.data, input.data, `entry ${i} data round-trip`);
      assert.equal(out.crc, crc32(out.data), `entry ${i} stored CRC matches recovered bytes`);
    }

    // The single-byte entry cannot shrink under deflate → stored.
    const tiny = parsed.find((e) => e.name === 'tiny.bin');
    assert.ok(tiny);
    assert.equal(tiny.method, 0, 'incompressible entry uses store fallback');

    // The repetitive entry compresses well → deflate.
    const big = parsed.find((e) => e.name === 'session.jsonl');
    assert.ok(big);
    assert.equal(big.method, 8, 'compressible entry uses deflate');
  });

  it('produces an empty but valid archive for zero entries', () => {
    const zip = zipBuffer([]);
    const { entries, eocdCount } = parseZip(zip);
    assert.equal(eocdCount, 0);
    assert.equal(entries.length, 0);
  });
});
