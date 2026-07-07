import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { crc32, zipBuffer, type ZipEntry } from '../../src/export/zip.js';
import { parseZip, readZipEntryCount } from '../helpers/zip.js';

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
    const parsed = parseZip(zip);

    assert.equal(readZipEntryCount(zip), entries.length, 'EOCD entry count');
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
    assert.equal(readZipEntryCount(zip), 0);
    assert.equal(parseZip(zip).length, 0);
  });
});
