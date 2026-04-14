import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import {
  getDb,
  closeDb,
  insertSession,
  getSession,
  upsertSession,
  listSessions,
  updateSession,
  deleteSession,
  sessionExists,
  insertEvent,
  insertEvents,
  getEvent,
  listEventsBySession,
  getTokenTimeline,
  getEventCountBySession,
  getDbStats,
  getToolFrequency,
  getSessionStats,
} from '../src/db/index.js';
import type { Session, Event } from '../src/shared/types.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'test-session-1',
    project_path: '/tmp/test-project',
    project_name: 'test-project',
    model: 'claude-sonnet-4-20250514',
    models_used: null,
    source: 'startup',
    status: 'completed',
    started_at: '2025-01-01T00:00:00.000Z',
    ended_at: '2025-01-01T01:00:00.000Z',
    duration_ms: 3600000,
    total_input_tokens: 50000,
    total_output_tokens: 10000,
    total_cache_read_tokens: 5000,
    total_cache_write_tokens: 2000,
    peak_context_pct: 65.5,
    compaction_count: 1,
    tool_call_count: 25,
    subagent_count: 2,
    risk_score: 0.35,
    summary: 'Test session summary',
    end_reason: 'user_exit',
    transcript_path: '/tmp/transcript.jsonl',
    metadata: null,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<Omit<Event, 'id'>> = {}): Omit<Event, 'id'> {
  return {
    session_id: 'test-session-1',
    parent_event_id: null,
    agent_id: null,
    event_type: 'assistant_message',
    event_source: 'transcript_import',
    tool_name: 'Read',
    timestamp: '2025-01-01T00:05:00.000Z',
    sequence_num: 1,
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_tokens: 200,
    cache_write_tokens: 100,
    context_pct: 10.5,
    input_preview: 'file.ts',
    input_data: JSON.stringify({ file_path: '/tmp/file.ts' }),
    output_preview: 'const x = 1;',
    output_data: JSON.stringify({ content: 'const x = 1;' }),
    thinking_summary: null,
    thinking_text: null,
    duration_ms: 50,
    metadata: null,
    ...overrides,
  };
}

let tmpDir: string;

describe('Database Layer', () => {
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-monitor-test-'));
    getDb(join(tmpDir, 'test.sqlite'));
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('connection', () => {
    it('should create database with WAL mode', () => {
      const db = getDb();
      const result = db.pragma('journal_mode') as { journal_mode: string }[];
      assert.equal(result[0].journal_mode, 'wal');
    });

    it('should have foreign keys enabled', () => {
      const db = getDb();
      const result = db.pragma('foreign_keys') as { foreign_keys: number }[];
      assert.equal(result[0].foreign_keys, 1);
    });

    it('should create all tables', () => {
      const db = getDb();
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      ).all() as { name: string }[];
      const names = tables.map((t) => t.name);
      assert.ok(names.includes('sessions'));
      assert.ok(names.includes('events'));
      assert.ok(names.includes('agent_relationships'));
      assert.ok(names.includes('_migrations'));
    });
  });

  describe('sessions', () => {
    it('should insert and retrieve a session', () => {
      const session = makeSession();
      insertSession(session);
      const retrieved = getSession('test-session-1');
      assert.ok(retrieved);
      assert.equal(retrieved.id, session.id);
      assert.equal(retrieved.project_path, session.project_path);
      assert.equal(retrieved.model, session.model);
      assert.equal(retrieved.total_input_tokens, session.total_input_tokens);
      assert.equal(retrieved.peak_context_pct, session.peak_context_pct);
    });

    it('sessionExists should return true for existing session', () => {
      assert.equal(sessionExists('test-session-1'), true);
      assert.equal(sessionExists('nonexistent'), false);
    });

    it('should upsert a session', () => {
      const updated = makeSession({ summary: 'Updated summary', total_input_tokens: 60000 });
      upsertSession(updated);
      const retrieved = getSession('test-session-1');
      assert.ok(retrieved);
      assert.equal(retrieved.summary, 'Updated summary');
      assert.equal(retrieved.total_input_tokens, 60000);
    });

    it('should update partial session fields', () => {
      updateSession('test-session-1', { status: 'running', risk_score: 0.8 });
      const retrieved = getSession('test-session-1');
      assert.ok(retrieved);
      assert.equal(retrieved.status, 'running');
      assert.equal(retrieved.risk_score, 0.8);
    });

    it('should list sessions with filters', () => {
      insertSession(makeSession({ id: 'test-session-2', status: 'completed', model: 'claude-haiku-4-5' }));
      insertSession(makeSession({ id: 'test-session-3', status: 'completed', risk_score: 0.9 }));

      const { sessions, total } = listSessions({ status: 'completed' });
      assert.equal(total, 2);
      assert.equal(sessions.length, 2);

      const { sessions: risky } = listSessions({ minRisk: 0.85 });
      assert.equal(risky.length, 1);
      assert.equal(risky[0].id, 'test-session-3');

      const { sessions: haiku } = listSessions({ model: 'haiku' });
      assert.equal(haiku.length, 1);
      assert.equal(haiku[0].id, 'test-session-2');
    });

    it('should list sessions with pagination', () => {
      const { sessions } = listSessions({ limit: 1, offset: 0 });
      assert.equal(sessions.length, 1);
    });

    it('should delete session', () => {
      deleteSession('test-session-2');
      assert.equal(sessionExists('test-session-2'), false);
    });
  });

  describe('events', () => {
    it('should insert and retrieve an event', () => {
      const id = insertEvent(makeEvent());
      assert.ok(id > 0);
      const event = getEvent(id);
      assert.ok(event);
      assert.equal(event.session_id, 'test-session-1');
      assert.equal(event.tool_name, 'Read');
    });

    it('should bulk insert events', () => {
      const events = [
        makeEvent({ sequence_num: 2, tool_name: 'Write', timestamp: '2025-01-01T00:06:00.000Z',
          input_data: JSON.stringify({ file_path: '/tmp/out.ts' }) }),
        makeEvent({ sequence_num: 3, tool_name: 'Bash', timestamp: '2025-01-01T00:07:00.000Z' }),
        makeEvent({ sequence_num: 4, tool_name: 'Read', timestamp: '2025-01-01T00:08:00.000Z',
          input_tokens: 5000, context_pct: 25.0,
          input_data: JSON.stringify({ file_path: '/tmp/other.ts' }) }),
      ];
      const ids = insertEvents(events);
      assert.equal(ids.length, 3);
      ids.forEach((id) => assert.ok(id > 0));
    });

    it('should list events by session with filters', () => {
      const { events, total } = listEventsBySession('test-session-1');
      assert.ok(total >= 4);
      assert.ok(events.length >= 4);

      const { events: readEvents } = listEventsBySession('test-session-1', { toolName: 'Read' });
      assert.ok(readEvents.length >= 2);
      readEvents.forEach((e) => assert.equal(e.tool_name, 'Read'));
    });

    it('should paginate events', () => {
      const { events } = listEventsBySession('test-session-1', { limit: 2, offset: 0 });
      assert.equal(events.length, 2);
    });

    it('should get token timeline', () => {
      const timeline = getTokenTimeline('test-session-1');
      assert.ok(timeline.length > 0);
      timeline.forEach((point) => {
        assert.ok('timestamp' in point);
        assert.ok('input_tokens' in point);
        assert.ok('context_pct' in point);
        assert.ok('is_compaction' in point);
      });
    });

    it('should get event count', () => {
      const count = getEventCountBySession('test-session-1');
      assert.ok(count >= 4);
    });

    it('should enforce foreign key on invalid session_id', () => {
      assert.throws(() => {
        insertEvent(makeEvent({ session_id: 'nonexistent-session' }));
      });
    });
  });

  describe('cascade delete', () => {
    it('should cascade delete events when session is deleted', () => {
      const countBefore = getEventCountBySession('test-session-1');
      assert.ok(countBefore > 0);
      deleteSession('test-session-1');
      const countAfter = getEventCountBySession('test-session-1');
      assert.equal(countAfter, 0);
    });
  });

  describe('stats', () => {
    it('should get db stats', () => {
      // Re-insert data for stats testing
      insertSession(makeSession({ id: 'stats-session-1' }));
      insertEvent(makeEvent({ session_id: 'stats-session-1', tool_name: 'Read', sequence_num: 1,
        input_data: JSON.stringify({ file_path: '/tmp/a.ts' }) }));
      insertEvent(makeEvent({ session_id: 'stats-session-1', tool_name: 'Read', sequence_num: 2,
        input_data: JSON.stringify({ file_path: '/tmp/b.ts' }) }));
      insertEvent(makeEvent({ session_id: 'stats-session-1', tool_name: 'Write', sequence_num: 3,
        input_data: JSON.stringify({ file_path: '/tmp/c.ts' }) }));

      const stats = getDbStats();
      assert.ok(stats.sessionCount >= 1);
      assert.ok(stats.eventCount >= 3);
      assert.ok(stats.dbSizeBytes > 0);
      assert.ok(stats.oldestSession);
      assert.ok(stats.newestSession);
    });

    it('should get tool frequency', () => {
      const freq = getToolFrequency('stats-session-1');
      assert.ok(freq.length >= 2);
      const readEntry = freq.find((f) => f.tool_name === 'Read');
      assert.ok(readEntry);
      assert.equal(readEntry.count, 2);
    });

    it('should get session stats', () => {
      const stats = getSessionStats('stats-session-1');
      assert.ok(stats.uniqueTools.includes('Read'));
      assert.ok(stats.uniqueTools.includes('Write'));
      assert.ok(stats.filesRead.length >= 2);
      assert.ok(stats.filesWritten.length >= 1);
    });
  });
});

// ── DB Connection error handling ──────────────────────────────────────

describe('DB connection error handling', () => {
  it('throws actionable error for unwritable directory', () => {
    assert.throws(
      () => getDb('/dev/null/deep/path/test.sqlite'),
      (err: Error) => {
        return err.message.includes('Cannot create database directory');
      },
    );
  });

  it('throws actionable error for corrupt DB file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db-corrupt-'));
    const dbPath = join(dir, 'data.sqlite');
    writeFileSync(dbPath, 'this is not a sqlite database at all');
    try {
      assert.throws(
        () => getDb(dbPath),
        (err: Error) => {
          return err.message.includes('corrupt') || err.message.includes('not a database') || err.message.includes('Cannot open');
        },
      );
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
