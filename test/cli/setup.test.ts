import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { execSync } from 'node:child_process';

const CLI = join(process.cwd(), 'src', 'cli', 'index.ts');

function runCli(args: string, env: Record<string, string> = {}): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execSync(`node --import tsx ${CLI} ${args}`, {
      encoding: 'utf-8',
      env: { ...process.env, ...env },
      timeout: 10000,
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      code: e.status ?? 1,
    };
  }
}

describe('setup command', () => {
  it('shows usage with --help', () => {
    const { stdout } = runCli('setup --help');
    assert.ok(stdout.includes('Configure Claude Code hooks'));
    assert.ok(stdout.includes('--dry-run'));
  });

  it('--dry-run shows config without writing', () => {
    const { stdout } = runCli('setup --dry-run');
    assert.ok(stdout.includes('Dry run'));
    assert.ok(stdout.includes('PreToolUse'));
    assert.ok(stdout.includes('PostToolUse'));
    assert.ok(stdout.includes('SubagentStart'));
    assert.ok(stdout.includes('SubagentStop'));
    assert.ok(stdout.includes('PreCompact'));
    assert.ok(stdout.includes('SessionStart'));
    assert.ok(stdout.includes('SessionEnd'));
    assert.ok(stdout.includes('capture.mjs'));
  });

  it('--dry-run shows all 7 hook types', () => {
    const { stdout } = runCli('setup --dry-run');
    const config = JSON.parse(stdout.split('\n').slice(1).join('\n'));
    const hookTypes = Object.keys(config.hooks);
    assert.equal(hookTypes.length, 7);
    assert.ok(hookTypes.includes('PreToolUse'));
    assert.ok(hookTypes.includes('SessionEnd'));
  });

  it('--dry-run hook entries have async: true and timeout: 10', () => {
    const { stdout } = runCli('setup --dry-run');
    const config = JSON.parse(stdout.split('\n').slice(1).join('\n'));
    for (const [, matchers] of Object.entries(config.hooks) as [string, Array<{ hooks: Array<{ async: boolean; timeout: number }> }>][]) {
      for (const matcher of matchers) {
        for (const hook of matcher.hooks) {
          assert.equal(hook.async, true);
          assert.equal(hook.timeout, 10);
        }
      }
    }
  });
});

describe('CLI help includes setup', () => {
  it('help text mentions setup command', () => {
    const { stdout } = runCli('--help');
    assert.ok(stdout.includes('setup'));
    assert.ok(stdout.includes('Configure Claude Code hooks'));
  });
});
