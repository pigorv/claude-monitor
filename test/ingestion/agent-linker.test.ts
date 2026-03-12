import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, closeDb } from '../../src/db/index.js';
import {
  insertAgentRelationship,
  updateAgentRelationship,
  getAgentRelationship,
  handleSubagentStart,
  handleSubagentStop,
} from '../../src/ingestion/agent-linker.js';
import { processHookLine, type EnrichedHookLine } from '../../src/ingestion/hook-handler.js';
import { getSession, getAgentRelationships } from '../../src/db/index.js';

let tmpDir: string;

function makeHookLine(overrides: Partial<EnrichedHookLine> = {}): string {
  return JSON.stringify({
    _event_type: 'subagent_start',
    _captured_at: '2026-03-12T00:00:00.000Z',
    _capture_version: '0.1.0',
    session_id: 'sess-agent-1',
    ...overrides,
  });
}

describe('agent-linker', () => {
  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-linker-test-'));
    getDb(join(tmpDir, 'test.sqlite'));

    // Create a parent session
    processHookLine(
      makeHookLine({
        _event_type: 'session_start',
        session_id: 'sess-agent-1',
        cwd: '/home/user/project',
      }),
    );
  });

  after(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── CRUD operations ─────────────────────────────────────────────────

  describe('insertAgentRelationship', () => {
    it('inserts and retrieves an agent relationship', () => {
      const id = insertAgentRelationship({
        parent_session_id: 'sess-agent-1',
        child_agent_id: 'agent-crud-1',
        child_transcript_path: null,
        prompt_preview: 'Do something',
        result_preview: null,
        prompt_data: 'Do something useful',
        result_data: null,
        started_at: '2026-03-12T00:00:00.000Z',
        ended_at: null,
        duration_ms: null,
        input_tokens_total: null,
        output_tokens_total: null,
        tool_call_count: 0,
        status: 'running',
      });

      assert.ok(id > 0);
      const rel = getAgentRelationship('sess-agent-1', 'agent-crud-1');
      assert.ok(rel);
      assert.equal(rel.parent_session_id, 'sess-agent-1');
      assert.equal(rel.child_agent_id, 'agent-crud-1');
      assert.equal(rel.prompt_preview, 'Do something');
      assert.equal(rel.status, 'running');
    });
  });

  describe('updateAgentRelationship', () => {
    it('updates an existing relationship', () => {
      const updated = updateAgentRelationship('sess-agent-1', 'agent-crud-1', {
        status: 'completed',
        result_preview: 'Done',
        result_data: 'Done with the task',
        ended_at: '2026-03-12T00:01:00.000Z',
        duration_ms: 60000,
      });

      assert.equal(updated, true);
      const rel = getAgentRelationship('sess-agent-1', 'agent-crud-1');
      assert.ok(rel);
      assert.equal(rel.status, 'completed');
      assert.equal(rel.result_preview, 'Done');
      assert.equal(rel.duration_ms, 60000);
    });

    it('returns false for non-existent relationship', () => {
      const updated = updateAgentRelationship('sess-agent-1', 'no-such-agent', {
        status: 'completed',
      });
      assert.equal(updated, false);
    });
  });

  describe('getAgentRelationship', () => {
    it('returns undefined for non-existent relationship', () => {
      const rel = getAgentRelationship('sess-agent-1', 'nonexistent');
      assert.equal(rel, undefined);
    });
  });

  // ── handleSubagentStart ─────────────────────────────────────────────

  describe('handleSubagentStart', () => {
    it('creates a relationship on subagent_start', () => {
      processHookLine(
        makeHookLine({
          _event_type: 'subagent_start',
          session_id: 'sess-agent-1',
          agent_id: 'agent-start-1',
          _captured_at: '2026-03-12T00:10:00.000Z',
        }),
      );

      const rel = getAgentRelationship('sess-agent-1', 'agent-start-1');
      assert.ok(rel);
      assert.equal(rel.status, 'running');
      assert.equal(rel.started_at, '2026-03-12T00:10:00.000Z');
    });

    it('does not create duplicate on repeated start', () => {
      processHookLine(
        makeHookLine({
          _event_type: 'subagent_start',
          session_id: 'sess-agent-1',
          agent_id: 'agent-start-1',
          _captured_at: '2026-03-12T00:10:01.000Z',
        }),
      );

      const rels = getAgentRelationships('sess-agent-1').filter(
        (r) => r.child_agent_id === 'agent-start-1',
      );
      assert.equal(rels.length, 1);
    });

    it('ignores start without agent_id', () => {
      const before = getAgentRelationships('sess-agent-1').length;
      handleSubagentStart({
        _event_type: 'subagent_start',
        _captured_at: '2026-03-12T00:10:02.000Z',
        _capture_version: '0.1.0',
        session_id: 'sess-agent-1',
      });
      const after = getAgentRelationships('sess-agent-1').length;
      assert.equal(before, after);
    });
  });

  // ── handleSubagentStop ──────────────────────────────────────────────

  describe('handleSubagentStop', () => {
    it('updates relationship on subagent_stop', () => {
      processHookLine(
        makeHookLine({
          _event_type: 'subagent_stop',
          session_id: 'sess-agent-1',
          agent_id: 'agent-start-1',
          _captured_at: '2026-03-12T00:15:00.000Z',
          agent_transcript_path: '/tmp/agent-start-1.jsonl',
          last_assistant_message: 'Task complete.',
        }),
      );

      const rel = getAgentRelationship('sess-agent-1', 'agent-start-1');
      assert.ok(rel);
      assert.equal(rel.status, 'completed');
      assert.equal(rel.child_transcript_path, '/tmp/agent-start-1.jsonl');
      assert.equal(rel.result_preview, 'Task complete.');
      assert.equal(rel.ended_at, '2026-03-12T00:15:00.000Z');
      assert.ok(rel.duration_ms! > 0);
    });

    it('creates a record on stop without prior start', () => {
      processHookLine(
        makeHookLine({
          _event_type: 'subagent_stop',
          session_id: 'sess-agent-1',
          agent_id: 'agent-orphan-1',
          _captured_at: '2026-03-12T00:20:00.000Z',
          last_assistant_message: 'Orphan result',
        }),
      );

      const rel = getAgentRelationship('sess-agent-1', 'agent-orphan-1');
      assert.ok(rel);
      assert.equal(rel.status, 'completed');
      assert.equal(rel.result_preview, 'Orphan result');
      assert.equal(rel.started_at, null);
      assert.equal(rel.duration_ms, null);
    });

    it('ignores stop without agent_id', () => {
      const before = getAgentRelationships('sess-agent-1').length;
      handleSubagentStop({
        _event_type: 'subagent_stop',
        _captured_at: '2026-03-12T00:20:01.000Z',
        _capture_version: '0.1.0',
        session_id: 'sess-agent-1',
      });
      const after = getAgentRelationships('sess-agent-1').length;
      assert.equal(before, after);
    });
  });

  // ── Integration: full start→stop lifecycle ──────────────────────────

  describe('full lifecycle', () => {
    it('tracks start through stop with computed duration', () => {
      processHookLine(
        makeHookLine({
          _event_type: 'subagent_start',
          session_id: 'sess-agent-1',
          agent_id: 'agent-lifecycle-1',
          _captured_at: '2026-03-12T01:00:00.000Z',
        }),
      );

      processHookLine(
        makeHookLine({
          _event_type: 'subagent_stop',
          session_id: 'sess-agent-1',
          agent_id: 'agent-lifecycle-1',
          _captured_at: '2026-03-12T01:05:00.000Z',
          agent_transcript_path: '/tmp/agent-lifecycle-1.jsonl',
          last_assistant_message: 'All done.',
        }),
      );

      const rel = getAgentRelationship('sess-agent-1', 'agent-lifecycle-1');
      assert.ok(rel);
      assert.equal(rel.status, 'completed');
      assert.equal(rel.duration_ms, 5 * 60 * 1000); // 5 minutes
      assert.equal(rel.child_transcript_path, '/tmp/agent-lifecycle-1.jsonl');
      assert.equal(rel.result_preview, 'All done.');
    });

    it('getAgentRelationships returns all agents for a session', () => {
      const rels = getAgentRelationships('sess-agent-1');
      // agent-crud-1, agent-start-1, agent-orphan-1, agent-lifecycle-1
      assert.ok(rels.length >= 4);
    });
  });
});
