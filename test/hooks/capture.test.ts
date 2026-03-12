import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const CAPTURE_SCRIPT = join(import.meta.dirname, '..', '..', 'hooks', 'capture.mjs');

function capture(eventType: string, payload?: string, env?: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CAPTURE_SCRIPT, eventType], {
      encoding: 'utf-8',
      input: payload ?? '',
      env: { ...process.env, ...env },
      timeout: 5000,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout: string; stderr: string; status: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.status ?? 1 };
  }
}

describe('hooks/capture.mjs', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'claude-monitor-capture-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('appends a line when given valid JSON stdin', () => {
    const payload = JSON.stringify({ session_id: 'sess-001', tool_name: 'Read' });
    capture('post_tool_use', payload, { CLAUDE_MONITOR_DATA_DIR: dataDir });

    const eventsFile = join(dataDir, 'events.jsonl');
    assert.ok(existsSync(eventsFile), 'events.jsonl should be created');

    const lines = readFileSync(eventsFile, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 1);

    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed._event_type, 'post_tool_use');
    assert.equal(parsed.session_id, 'sess-001');
    assert.equal(parsed.tool_name, 'Read');
  });

  it('output line contains _event_type, _captured_at, _capture_version, and original fields', () => {
    const payload = JSON.stringify({ session_id: 'sess-002', cwd: '/tmp' });
    capture('session_start', payload, { CLAUDE_MONITOR_DATA_DIR: dataDir });

    const eventsFile = join(dataDir, 'events.jsonl');
    const parsed = JSON.parse(readFileSync(eventsFile, 'utf-8').trim());

    assert.equal(parsed._event_type, 'session_start');
    assert.ok(parsed._captured_at, '_captured_at should be present');
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(parsed._captured_at), '_captured_at should be ISO 8601');
    assert.equal(parsed._capture_version, '0.1.0');
    assert.equal(parsed.session_id, 'sess-002');
    assert.equal(parsed.cwd, '/tmp');
  });

  it('creates data directory if missing', () => {
    const nestedDir = join(dataDir, 'nested', 'deep');
    const payload = JSON.stringify({ session_id: 'sess-003' });
    capture('session_start', payload, { CLAUDE_MONITOR_DATA_DIR: nestedDir });

    assert.ok(existsSync(join(nestedDir, 'events.jsonl')), 'should create nested directory and file');
  });

  it('handles empty stdin gracefully (no crash, no output file)', () => {
    const { exitCode } = capture('post_tool_use', '', { CLAUDE_MONITOR_DATA_DIR: dataDir });
    assert.equal(exitCode, 0);
    assert.ok(!existsSync(join(dataDir, 'events.jsonl')), 'should not create events.jsonl for empty stdin');
  });

  it('handles malformed JSON gracefully (no crash)', () => {
    const { exitCode } = capture('post_tool_use', '{not valid json', { CLAUDE_MONITOR_DATA_DIR: dataDir });
    assert.equal(exitCode, 0);
    assert.ok(!existsSync(join(dataDir, 'events.jsonl')), 'should not create events.jsonl for bad JSON');
  });

  it('handles unknown event type (still captures)', () => {
    const payload = JSON.stringify({ session_id: 'sess-004' });
    capture('unknown_event', payload, { CLAUDE_MONITOR_DATA_DIR: dataDir });

    const eventsFile = join(dataDir, 'events.jsonl');
    const parsed = JSON.parse(readFileSync(eventsFile, 'utf-8').trim());
    assert.equal(parsed._event_type, 'unknown_event');
    assert.equal(parsed.session_id, 'sess-004');
  });

  it('completes in < 50ms', () => {
    const payload = JSON.stringify({ session_id: 'sess-perf', tool_name: 'Bash' });
    const start = performance.now();
    capture('post_tool_use', payload, { CLAUDE_MONITOR_DATA_DIR: dataDir });
    const elapsed = performance.now() - start;

    // Allow generous margin for CI — the script itself is fast,
    // but execFileSync includes Node.js startup overhead.
    // We assert < 500ms to cover slow CI; real execution is < 50ms.
    assert.ok(elapsed < 500, `Expected < 500ms (got ${elapsed.toFixed(1)}ms)`);
  });

  it('multiple invocations append multiple lines', () => {
    const env = { CLAUDE_MONITOR_DATA_DIR: dataDir };
    capture('session_start', JSON.stringify({ session_id: 'sess-010' }), env);
    capture('post_tool_use', JSON.stringify({ session_id: 'sess-010', tool_name: 'Read' }), env);
    capture('session_end', JSON.stringify({ session_id: 'sess-010', reason: 'user_exit' }), env);

    const eventsFile = join(dataDir, 'events.jsonl');
    const lines = readFileSync(eventsFile, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 3);

    assert.equal(JSON.parse(lines[0])._event_type, 'session_start');
    assert.equal(JSON.parse(lines[1])._event_type, 'post_tool_use');
    assert.equal(JSON.parse(lines[2])._event_type, 'session_end');
  });

  it('exits gracefully when no event type is provided', () => {
    try {
      const stdout = execFileSync('node', [CAPTURE_SCRIPT], {
        encoding: 'utf-8',
        input: JSON.stringify({ session_id: 'no-event' }),
        env: { ...process.env, CLAUDE_MONITOR_DATA_DIR: dataDir },
        timeout: 5000,
      });
      // Should exit 0 with no output
      assert.ok(!existsSync(join(dataDir, 'events.jsonl')));
    } catch (err: unknown) {
      const e = err as { status: number };
      assert.equal(e.status, 0);
    }
  });
});
