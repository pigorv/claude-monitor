import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const CLI = join(import.meta.dirname, '..', '..', 'dist', 'index.js');
const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'sample-session.jsonl');

let testHome: string;

function run(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: testHome },
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout: string; stderr: string; status: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.status ?? 1 };
  }
}

describe('CLI entry point', () => {
  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), 'claude-monitor-cli-home-'));
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
  });
  it('shows help with --help', () => {
    const { stdout, exitCode } = run('--help');
    assert.equal(exitCode, 0);
    assert.match(stdout, /Usage: claude-monitor/);
    assert.match(stdout, /import/);
  });

  it('shows help with no arguments', () => {
    const { stdout, exitCode } = run();
    assert.equal(exitCode, 0);
    assert.match(stdout, /Usage: claude-monitor/);
  });

  it('shows version with --version', () => {
    const { stdout, exitCode } = run('--version');
    assert.equal(exitCode, 0);
    assert.match(stdout, /^\d+\.\d+\.\d+/);
  });

  it('exits with error for unknown command', () => {
    const { stderr, exitCode } = run('nonexistent');
    assert.equal(exitCode, 1);
    assert.match(stderr, /Unknown command/);
  });
});

describe('import command', () => {
  let testDir: string;

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), 'claude-monitor-cli-home-'));
    testDir = mkdtempSync(join(tmpdir(), 'claude-monitor-cli-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    rmSync(testHome, { recursive: true, force: true });
  });

  it('shows help with --help', () => {
    const { stdout, exitCode } = run('import', '--help');
    assert.equal(exitCode, 0);
    assert.match(stdout, /Usage: claude-monitor import/);
  });

  it('errors when path does not exist', () => {
    const { stderr, exitCode } = run('import', '/nonexistent/path.jsonl');
    assert.equal(exitCode, 1);
    assert.match(stderr, /does not exist/);
  });

  it('errors when file is not .jsonl', () => {
    const txtFile = join(testDir, 'test.txt');
    writeFileSync(txtFile, 'hello');
    const { stderr, exitCode } = run('import', txtFile);
    assert.equal(exitCode, 1);
    assert.match(stderr, /not a \.jsonl file/);
  });

  it('prints message when directory has no .jsonl files', () => {
    const emptyDir = join(testDir, 'empty');
    mkdirSync(emptyDir);
    writeFileSync(join(emptyDir, 'readme.txt'), 'nothing here');
    const { stdout, exitCode } = run('import', emptyDir);
    assert.equal(exitCode, 0);
    assert.match(stdout, /No \.jsonl files found/);
  });

  it('imports a single transcript file', () => {
    const { stdout, exitCode } = run('import', FIXTURE);
    assert.equal(exitCode, 0);
    assert.match(stdout, /Importing 1 file/);
    assert.match(stdout, /sess-001/);
    assert.match(stdout, /1 imported/);
  });

  it('skips already imported sessions', () => {
    run('import', FIXTURE); // First import
    const { stdout, exitCode } = run('import', FIXTURE);
    assert.equal(exitCode, 0);
    assert.match(stdout, /already imported/);
    assert.match(stdout, /0 imported, 1 skipped/);
  });

  it('re-imports with --force', () => {
    run('import', FIXTURE); // First import
    const { stdout, exitCode } = run('import', '--force', FIXTURE);
    assert.equal(exitCode, 0);
    assert.match(stdout, /1 imported/);
  });

  it('imports all .jsonl files from a directory', () => {
    const dir = join(testDir, 'transcripts');
    mkdirSync(dir);

    const msg = (id: string) =>
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hi' },
        timestamp: '2026-01-01T00:00:00Z',
        sessionId: id,
      });

    writeFileSync(join(dir, 'a.jsonl'), msg('sess-a') + '\n');
    writeFileSync(join(dir, 'b.jsonl'), msg('sess-b') + '\n');
    writeFileSync(join(dir, 'readme.txt'), 'ignored'); // Should be ignored

    const { stdout, exitCode } = run('import', dir);
    assert.equal(exitCode, 0);
    assert.match(stdout, /Importing 2 files/);
  });
});
