import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const CLI = join(import.meta.dirname, '..', '..', 'dist', 'index.js');
const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'happy', 'sample-session.jsonl');

// Minimal zip reader — returns entry names (mirrors test/export/session-bundle.test.ts).
function zipEntryNames(zip: Buffer): string[] {
  const eocdOffset = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocdOffset), 0x06054b50, 'EOCD signature');
  const centralOffset = zip.readUInt32LE(eocdOffset + 16);
  const names: string[] = [];
  let pos = 0;
  while (pos < centralOffset) {
    assert.equal(zip.readUInt32LE(pos), 0x04034b50, 'local header signature');
    const compressedSize = zip.readUInt32LE(pos + 18);
    const nameLen = zip.readUInt16LE(pos + 26);
    const extraLen = zip.readUInt16LE(pos + 28);
    const nameStart = pos + 30;
    names.push(zip.toString('utf8', nameStart, nameStart + nameLen));
    pos = nameStart + nameLen + extraLen + compressedSize;
  }
  return names;
}

let testHome: string;
let testDir: string;

function run(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const res = spawnSync('node', [CLI, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: testHome },
    timeout: 10_000,
  });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', exitCode: res.status ?? 1 };
}

describe('export command', () => {
  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), 'claude-monitor-cli-home-'));
    testDir = mkdtempSync(join(tmpdir(), 'claude-monitor-cli-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    rmSync(testHome, { recursive: true, force: true });
  });

  it('appears in CLI help', () => {
    const { stdout } = run('--help');
    assert.match(stdout, /export/);
  });

  it('shows usage with --help', () => {
    const { stdout, exitCode } = run('export', '--help');
    assert.equal(exitCode, 0);
    assert.match(stdout, /Usage: claude-monitor export/);
  });

  it('errors with non-zero exit on missing session id', () => {
    const { stderr, exitCode } = run('export');
    assert.equal(exitCode, 1);
    assert.match(stderr, /missing <session-id>/);
  });

  it('errors with actionable message (no stack trace) for unknown session', () => {
    const { stderr, exitCode } = run('export', 'does-not-exist');
    assert.equal(exitCode, 1);
    assert.match(stderr, /no such session/);
    assert.doesNotMatch(stderr, /at \w+/); // no stack-trace frames
  });

  it('exports an imported session to --out and prints the audit summary', () => {
    run('import', FIXTURE);
    const outFile = join(testDir, 'bundle.zip');
    const { stdout, exitCode } = run('export', 'sess-001', '--out', outFile);
    assert.equal(exitCode, 0);
    assert.match(stdout, /Exported session sess-001/);
    assert.match(stdout, /Sanitization summary/);
    assert.match(stdout, /Lines emitted/);
    assert.ok(existsSync(outFile), 'zip file should be written');
    // PK zip magic bytes — confirms a binary zip, not corrupted text.
    const head = readFileSync(outFile);
    assert.equal(head[0], 0x50);
    assert.equal(head[1], 0x4b);
  });

  it('writes into a directory passed as --out', () => {
    run('import', FIXTURE);
    const { stdout, exitCode } = run('export', 'sess-001', '--out', testDir);
    assert.equal(exitCode, 0);
    const expected = join(testDir, 'claude-monitor-session-sess-001.zip');
    assert.ok(existsSync(expected), 'zip should be written into the directory');
    assert.match(stdout, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('--raw exports an unsanitized bundle with a warning and no sanitization summary', () => {
    run('import', FIXTURE);
    const outFile = join(testDir, 'raw.zip');
    const { stdout, stderr, exitCode } = run('export', 'sess-001', '--raw', '--out', outFile);
    assert.equal(exitCode, 0);
    assert.match(stdout, /Exported session sess-001/);
    assert.doesNotMatch(stdout, /Sanitization summary/);
    assert.match(stderr, /UNSANITIZED/);
    assert.match(stderr, /real filesystem paths and message content/);
    assert.ok(existsSync(outFile), 'zip file should be written');
    const names = zipEntryNames(readFileSync(outFile));
    assert.ok(names.includes('export-manifest.json'), 'raw bundle has export-manifest.json');
    assert.ok(
      !names.includes('sanitization-report.json'),
      'raw bundle has no sanitization-report.json',
    );
  });

  it('--no-sanitize behaves identically to --raw', () => {
    run('import', FIXTURE);
    const outFile = join(testDir, 'no-sanitize.zip');
    const { stdout, stderr, exitCode } = run(
      'export',
      'sess-001',
      '--no-sanitize',
      '--out',
      outFile,
    );
    assert.equal(exitCode, 0);
    assert.doesNotMatch(stdout, /Sanitization summary/);
    assert.match(stderr, /UNSANITIZED/);
    const names = zipEntryNames(readFileSync(outFile));
    assert.ok(names.includes('export-manifest.json'), 'raw bundle has export-manifest.json');
    assert.ok(!names.includes('sanitization-report.json'));
  });

  it('no flag prints the sanitization summary, no warning, and a sanitization report', () => {
    run('import', FIXTURE);
    const outFile = join(testDir, 'sanitized.zip');
    const { stdout, stderr, exitCode } = run('export', 'sess-001', '--out', outFile);
    assert.equal(exitCode, 0);
    assert.match(stdout, /Sanitization summary/);
    assert.doesNotMatch(stderr, /UNSANITIZED/);
    const names = zipEntryNames(readFileSync(outFile));
    assert.ok(
      names.includes('sanitization-report.json'),
      'sanitized bundle has sanitization-report.json',
    );
    assert.ok(!names.includes('export-manifest.json'));
  });
});
