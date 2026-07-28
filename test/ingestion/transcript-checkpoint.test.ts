import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  captureCheckpoint,
  validatePrefix,
} from '../../src/ingestion/transcript-checkpoint.js';

describe('transcript-checkpoint', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'transcript-checkpoint-test-'));
    filePath = join(tmpDir, 'transcript.jsonl');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('captures size and hash of the whole file', () => {
    const content = '{"line":1}\n{"line":2}\n';
    writeFileSync(filePath, content);

    const cp = captureCheckpoint(filePath);
    assert.equal(cp.sizeBytes, Buffer.byteLength(content));
    assert.match(cp.prefixHash, /^[0-9a-f]{40}$/);
  });

  it('validates true for an unchanged file', () => {
    writeFileSync(filePath, '{"line":1}\n{"line":2}\n');
    const cp = captureCheckpoint(filePath);

    assert.equal(validatePrefix(filePath, cp.sizeBytes, cp.prefixHash), true);
  });

  it('validates true for an appended file against the old checkpoint', () => {
    writeFileSync(filePath, '{"line":1}\n{"line":2}\n');
    const cp = captureCheckpoint(filePath);

    appendFileSync(filePath, '{"line":3}\n{"line":4}\n');

    assert.equal(validatePrefix(filePath, cp.sizeBytes, cp.prefixHash), true);
  });

  it('validates false when a byte inside the prefix is flipped', () => {
    writeFileSync(filePath, '{"line":1}\n{"line":2}\n');
    const cp = captureCheckpoint(filePath);

    // Rewrite same length but change a byte within the captured prefix.
    writeFileSync(filePath, '{"line":9}\n{"line":2}\n');

    assert.equal(validatePrefix(filePath, cp.sizeBytes, cp.prefixHash), false);
  });

  it('validates false when the file has shrunk', () => {
    writeFileSync(filePath, '{"line":1}\n{"line":2}\n');
    const cp = captureCheckpoint(filePath);

    writeFileSync(filePath, '{"line":1}\n');

    assert.equal(validatePrefix(filePath, cp.sizeBytes, cp.prefixHash), false);
  });

  it('validates false for a missing file', () => {
    const cp = { sizeBytes: 10, prefixHash: 'deadbeef' };
    assert.equal(
      validatePrefix(join(tmpDir, 'nope.jsonl'), cp.sizeBytes, cp.prefixHash),
      false,
    );
  });
});
