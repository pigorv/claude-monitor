import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, closeDb } from '../../src/db/index.js';
import { getSession } from '../../src/db/queries/sessions.js';
import { createTranscriptWatcher } from '../../src/ingestion/transcript-watcher.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn: () => boolean, timeoutMs = 5000, intervalMs = 100): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

const FIXTURE = join(import.meta.dirname!, '..', 'fixtures', 'sample-session.jsonl');

describe('transcript-watcher', () => {
  let tmpDir: string;
  let projectsDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'transcript-watcher-test-'));
    projectsDir = join(tmpDir, 'projects');
    mkdirSync(projectsDir, { recursive: true });
    getDb(join(tmpDir, 'test.sqlite'));
  });

  after(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('auto-imports new transcript files', async () => {
    // Create a project directory and copy a fixture transcript into it
    const projDir = join(projectsDir, '-tmp-my-project');
    mkdirSync(projDir, { recursive: true });

    const watcher = createTranscriptWatcher({
      projectsPath: projectsDir,
      pollIntervalMs: 200,
    });
    watcher.start();

    try {
      // Copy transcript into the projects directory — watcher should pick it up
      copyFileSync(FIXTURE, join(projDir, 'sess-001.jsonl'));

      await waitFor(() => {
        const session = getSession('sess-001');
        return session !== undefined;
      });

      const session = getSession('sess-001');
      assert.ok(session, 'Session should be imported');
      assert.equal(session.id, 'sess-001');
    } finally {
      watcher.stop();
    }
  });

  it('does not re-import unchanged files', async () => {
    // sess-001 was imported in the previous test. Start a new watcher —
    // it should seed mtimes and skip it.
    const watcher = createTranscriptWatcher({
      projectsPath: projectsDir,
      pollIntervalMs: 200,
    });
    watcher.start();

    try {
      // Wait a few poll cycles
      await sleep(600);

      // Session still exists, no errors
      const session = getSession('sess-001');
      assert.ok(session);
    } finally {
      watcher.stop();
    }
  });

  it('start/stop/isRunning work correctly', () => {
    const watcher = createTranscriptWatcher({
      projectsPath: projectsDir,
      pollIntervalMs: 1000,
    });

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

  it('handles non-existent projects directory', () => {
    const watcher = createTranscriptWatcher({
      projectsPath: join(tmpDir, 'does-not-exist'),
      pollIntervalMs: 1000,
    });

    // Should not throw
    watcher.start();
    assert.equal(watcher.isRunning, true);
    watcher.stop();
  });

  it('skips invalid JSONL files gracefully', async () => {
    const projDir = join(projectsDir, '-tmp-bad-project');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, 'bad-session.jsonl'), 'not valid json\n');

    const watcher = createTranscriptWatcher({
      projectsPath: projectsDir,
      pollIntervalMs: 200,
    });
    watcher.start();

    try {
      // Wait a couple poll cycles — should not crash
      await sleep(600);
      assert.equal(watcher.isRunning, true);
    } finally {
      watcher.stop();
    }
  });
});
