import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  utimesSync,
} from 'node:fs';
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

/** Materialize the sample transcript under a chosen session id (the fixture bakes "sess-001"). */
function writeTranscriptWithId(destPath: string, sessionId: string): void {
  const rewritten = readFileSync(FIXTURE, 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      // The fixture intentionally contains a malformed line to exercise the
      // parser's resilience — pass anything that isn't JSON through untouched.
      try {
        const obj = JSON.parse(line);
        if (obj.sessionId) obj.sessionId = sessionId;
        return JSON.stringify(obj);
      } catch {
        return line;
      }
    })
    .join('\n');
  writeFileSync(destPath, rewritten + '\n');
}

describe('transcript-watcher', () => {
  let tmpDir: string;
  let projectsDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'transcript-watcher-test-'));
    projectsDir = join(tmpDir, 'projects');
    mkdirSync(projectsDir, { recursive: true });
    getDb(join(tmpDir, 'test.sqlite'));
  });

  afterAll(() => {
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

  it('imports a transcript already on disk before start() (regression: #62)', async () => {
    // A transcript that appeared while the server was down: it exists on disk
    // BEFORE the watcher starts and has never been imported. It must import on
    // the first scan, not get silently skipped by mtime seeding.
    const projDir = join(projectsDir, '-tmp-cold-start');
    mkdirSync(projDir, { recursive: true });
    writeTranscriptWithId(join(projDir, 'sess-cold.jsonl'), 'sess-cold');

    assert.equal(getSession('sess-cold'), undefined, 'precondition: not yet imported');

    const watcher = createTranscriptWatcher({
      projectsPath: projectsDir,
      pollIntervalMs: 200,
    });
    watcher.start();

    try {
      await waitFor(() => getSession('sess-cold') !== undefined);
      const session = getSession('sess-cold');
      assert.ok(session, 'Transcript present before start() should import on first scan');
      assert.equal(session.id, 'sess-cold');
    } finally {
      watcher.stop();
    }
  });

  it('re-imports a session appended-to while the watcher was down (regression: #62)', async () => {
    const projDir = join(projectsDir, '-tmp-append-while-down');
    mkdirSync(projDir, { recursive: true });
    const file = join(projDir, 'sess-append.jsonl');
    writeTranscriptWithId(file, 'sess-append');

    // First run: import the session, then stop the watcher.
    const first = createTranscriptWatcher({ projectsPath: projectsDir, pollIntervalMs: 200 });
    first.start();
    await waitFor(() => getSession('sess-append') !== undefined);
    const before = getSession('sess-append');
    assert.ok(before);
    first.stop();
    await sleep(250); // let any in-flight scan settle

    // While "down", append a later message and force a newer mtime so the change
    // is unambiguous regardless of filesystem mtime resolution.
    const appended =
      JSON.stringify({
        parentUuid: 'x',
        cwd: '/tmp/project',
        sessionId: 'sess-append',
        version: '2.1.0',
        type: 'user',
        message: { role: 'user', content: 'a message added while the watcher was down' },
        timestamp: '2026-12-31T00:00:00.000Z',
        uuid: 'uuid-appended-while-down',
      }) + '\n';
    writeFileSync(file, readFileSync(file, 'utf8') + appended);
    const future = new Date('2031-01-01T00:00:00.000Z');
    utimesSync(file, future, future);

    // A fresh watcher (empty in-memory state) seeds from the persisted mtime,
    // sees the file is newer, and re-imports — reflecting the appended message.
    const second = createTranscriptWatcher({ projectsPath: projectsDir, pollIntervalMs: 200 });
    second.start();
    try {
      await waitFor(() => getSession('sess-append')?.ended_at !== before!.ended_at);
      const after = getSession('sess-append');
      assert.equal(
        after?.ended_at,
        '2026-12-31T00:00:00.000Z',
        'appended message should be picked up after restart',
      );
    } finally {
      second.stop();
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
