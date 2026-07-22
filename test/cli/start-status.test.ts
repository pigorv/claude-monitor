import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const CLI = join(import.meta.dirname, '..', '..', 'dist', 'index.js');

let testHome: string;

function run(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: testHome },
      timeout: 5000,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.status ?? 1 };
  }
}

describe('start command', () => {
  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), 'claude-monitor-cli-test-'));
    mkdirSync(join(testHome, '.claude-monitor'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it('shows usage with --help', () => {
    const { stdout } = run('start', '--help');
    assert.ok(stdout.includes('Usage: claude-monitor start'));
    assert.ok(stdout.includes('--port'));
    assert.ok(stdout.includes('--no-open'));
  });

  it('rejects a non-integer --port instead of truncating it', () => {
    // Matches parsePort/CLAUDE_MONITOR_PORT: "12.5" and "80abc" are invalid,
    // not silently coerced to 12/80 the way parseInt() used to.
    for (const bad of ['12.5', '80abc', 'abc', '0', '70000']) {
      const { exitCode, stderr } = run('start', '--port', bad);
      assert.equal(exitCode, 1, `--port ${bad} should exit 1`);
      assert.ok(stderr.includes('Invalid port number'), `--port ${bad} should print the error`);
    }
  });
});

describe('status command', () => {
  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), 'claude-monitor-cli-test-'));
    mkdirSync(join(testHome, '.claude-monitor'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it('shows usage with --help', () => {
    const { stdout } = run('status', '--help');
    assert.ok(stdout.includes('Usage: claude-monitor status'));
  });

  it('shows database info', () => {
    const { stdout } = run('status');
    assert.ok(stdout.includes('Database:'));
  });

  it('shows server status', () => {
    const { stdout } = run('status');
    // Server may be running (dev server) or not — just verify status line is present
    assert.ok(stdout.includes('Server:'), 'should show server status line');
  });

  it('shows version', () => {
    const { stdout } = run('status');
    assert.ok(stdout.includes('claude-monitor v'));
  });
});

describe('CLI help shows new commands', () => {
  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), 'claude-monitor-cli-test-'));
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it('help includes all commands', () => {
    const { stdout } = run('--help');
    assert.ok(stdout.includes('import'));
    assert.ok(stdout.includes('start'));
    assert.ok(stdout.includes('status'));
  });
});
