import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, closeDb } from '../../src/db/index.js';
import { listEventsBySession, eventExists } from '../../src/db/index.js';
import { getSession } from '../../src/db/queries/sessions.js';
import { createFileWatcher } from '../../src/ingestion/file-watcher.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn: () => boolean, timeoutMs = 3000, intervalMs = 50): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('file-watcher', () => {
  let tmpDir: string;
  let eventsFile: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'file-watcher-test-'));
    eventsFile = join(tmpDir, 'events.jsonl');
    getDb(join(tmpDir, 'test.sqlite'));
  });

  after(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('picks up new events and inserts into DB', async () => {
    const watcher = createFileWatcher(eventsFile);
    watcher.start();

    try {
      const line = JSON.stringify({
        _event_type: 'session_start',
        _captured_at: '2026-03-12T10:00:00.000Z',
        _capture_version: '0.1.0',
        session_id: 'fw-sess-1',
        cwd: '/tmp/project',
        model: 'claude-sonnet-4-20250514',
        source: 'startup',
        transcript_path: '/tmp/t.jsonl',
      });
      appendFileSync(eventsFile, line + '\n');

      await waitFor(() => {
        const session = getSession('fw-sess-1');
        return session !== undefined;
      });

      const session = getSession('fw-sess-1');
      assert.ok(session);
      assert.equal(session.status, 'running');

      const { events } = listEventsBySession('fw-sess-1');
      assert.ok(events.length >= 1);
      assert.equal(events[0].event_type, 'session_start');
      assert.equal(events[0].event_source, 'hook');
    } finally {
      watcher.stop();
    }
  });

  it('skips duplicate events', async () => {
    const watcher = createFileWatcher(eventsFile);
    // Reset: watcher starts from current file size
    watcher.start();

    try {
      const line = JSON.stringify({
        _event_type: 'pre_tool_use',
        _captured_at: '2026-03-12T10:01:00.000Z',
        _capture_version: '0.1.0',
        session_id: 'fw-sess-1',
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/a.ts' },
      });

      // Append same line twice
      appendFileSync(eventsFile, line + '\n');
      appendFileSync(eventsFile, line + '\n');

      await sleep(1500);

      // Should only have one event with this exact timestamp and tool
      const { events } = listEventsBySession('fw-sess-1', { toolName: 'Read' });
      const matching = events.filter(
        (e) => e.timestamp === '2026-03-12T10:01:00.000Z' && e.tool_name === 'Read',
      );
      assert.equal(matching.length, 1, 'Duplicate should be skipped');
    } finally {
      watcher.stop();
    }
  });

  it('start/stop/isRunning work correctly', () => {
    const watcher = createFileWatcher(eventsFile);
    assert.equal(watcher.isRunning, false);

    watcher.start();
    assert.equal(watcher.isRunning, true);

    // Double-start is a no-op
    watcher.start();
    assert.equal(watcher.isRunning, true);

    watcher.stop();
    assert.equal(watcher.isRunning, false);

    // Double-stop is safe
    watcher.stop();
    assert.equal(watcher.isRunning, false);
  });

  it('handles file that does not exist yet', async () => {
    const newEventsFile = join(tmpDir, 'new-events.jsonl');
    const watcher = createFileWatcher(newEventsFile);
    watcher.start();

    try {
      // Write to file after watcher started
      const line = JSON.stringify({
        _event_type: 'session_start',
        _captured_at: '2026-03-12T11:00:00.000Z',
        _capture_version: '0.1.0',
        session_id: 'fw-sess-late',
        cwd: '/tmp',
      });
      appendFileSync(newEventsFile, line + '\n');

      await waitFor(() => {
        const session = getSession('fw-sess-late');
        return session !== undefined;
      });

      const session = getSession('fw-sess-late');
      assert.ok(session);
    } finally {
      watcher.stop();
    }
  });
});
