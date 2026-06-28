import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const CLI = join(import.meta.dirname, '..', '..', 'dist', 'index.js');
const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'happy', 'sample-session.jsonl');

let testHome: string;
let testDir: string;

function run(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: testHome },
      timeout: 10_000,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.status ?? 1 };
  }
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
});
