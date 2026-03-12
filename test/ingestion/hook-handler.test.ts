import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, closeDb } from '../../src/db/index.js';
import {
  parseHookLine,
  mapEventType,
  buildEventFromHook,
  processHookLine,
  handleSessionEvent,
  type EnrichedHookLine,
} from '../../src/ingestion/hook-handler.js';
import { getSession, eventExists } from '../../src/db/index.js';

let tmpDir: string;

function makeHookLine(overrides: Partial<EnrichedHookLine> = {}): EnrichedHookLine {
  return {
    _event_type: 'pre_tool_use',
    _captured_at: '2026-03-12T00:00:00.000Z',
    _capture_version: '0.1.0',
    session_id: 'sess-test-1',
    ...overrides,
  };
}

describe('hook-handler', () => {
  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hook-handler-test-'));
    getDb(join(tmpDir, 'test.sqlite'));
  });

  after(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── parseHookLine ──────────────────────────────────────────────────

  describe('parseHookLine', () => {
    it('parses valid JSON with required fields', () => {
      const line = JSON.stringify(makeHookLine());
      const result = parseHookLine(line);
      assert.ok(result);
      assert.equal(result._event_type, 'pre_tool_use');
      assert.equal(result.session_id, 'sess-test-1');
    });

    it('returns null for empty line', () => {
      assert.equal(parseHookLine(''), null);
      assert.equal(parseHookLine('  '), null);
    });

    it('returns null for malformed JSON', () => {
      assert.equal(parseHookLine('{not valid json}'), null);
    });

    it('returns null when _event_type is missing', () => {
      const line = JSON.stringify({ _captured_at: 'x', session_id: 's' });
      assert.equal(parseHookLine(line), null);
    });

    it('returns null when session_id is missing', () => {
      const line = JSON.stringify({ _event_type: 'x', _captured_at: 'x' });
      assert.equal(parseHookLine(line), null);
    });

    it('returns null when _captured_at is missing', () => {
      const line = JSON.stringify({ _event_type: 'x', session_id: 's' });
      assert.equal(parseHookLine(line), null);
    });
  });

  // ── mapEventType ───────────────────────────────────────────────────

  describe('mapEventType', () => {
    it('maps pre_tool_use → tool_call_start', () => {
      assert.equal(mapEventType('pre_tool_use'), 'tool_call_start');
    });

    it('maps post_tool_use → tool_call_end', () => {
      assert.equal(mapEventType('post_tool_use'), 'tool_call_end');
    });

    it('maps session_start → session_start', () => {
      assert.equal(mapEventType('session_start'), 'session_start');
    });

    it('maps session_end → session_end', () => {
      assert.equal(mapEventType('session_end'), 'session_end');
    });

    it('maps pre_compact → compaction', () => {
      assert.equal(mapEventType('pre_compact'), 'compaction');
    });

    it('maps subagent_start → subagent_start', () => {
      assert.equal(mapEventType('subagent_start'), 'subagent_start');
    });

    it('maps subagent_stop → subagent_end', () => {
      assert.equal(mapEventType('subagent_stop'), 'subagent_end');
    });

    it('returns null for unknown type', () => {
      assert.equal(mapEventType('unknown_thing'), null);
    });
  });

  // ── buildEventFromHook ─────────────────────────────────────────────

  describe('buildEventFromHook', () => {
    it('builds event for tool call with previews', () => {
      const parsed = makeHookLine({
        _event_type: 'pre_tool_use',
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/test.ts' },
      });
      const event = buildEventFromHook(parsed);
      assert.ok(event);
      assert.equal(event.event_type, 'tool_call_start');
      assert.equal(event.event_source, 'hook');
      assert.equal(event.tool_name, 'Read');
      assert.ok(event.input_preview?.includes('file_path'));
    });

    it('truncates previews to 500 chars', () => {
      const longInput = { data: 'x'.repeat(600) };
      const parsed = makeHookLine({
        _event_type: 'pre_tool_use',
        tool_name: 'Write',
        tool_input: longInput,
      });
      const event = buildEventFromHook(parsed);
      assert.ok(event);
      assert.ok(event.input_preview!.length <= 501); // 500 + '…'
    });

    it('returns null for unknown event type', () => {
      const parsed = makeHookLine({ _event_type: 'unknown_type' });
      assert.equal(buildEventFromHook(parsed), null);
    });

    it('handles session events (no tool_name)', () => {
      const parsed = makeHookLine({ _event_type: 'session_start' });
      const event = buildEventFromHook(parsed);
      assert.ok(event);
      assert.equal(event.event_type, 'session_start');
      assert.equal(event.tool_name, null);
    });

    it('handles subagent events with agent_id', () => {
      const parsed = makeHookLine({
        _event_type: 'subagent_start',
        agent_id: 'agent-42',
      });
      const event = buildEventFromHook(parsed);
      assert.ok(event);
      assert.equal(event.event_type, 'subagent_start');
      assert.equal(event.agent_id, 'agent-42');
    });

    it('handles post_tool_use with output preview', () => {
      const parsed = makeHookLine({
        _event_type: 'post_tool_use',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: { output: 'file1.ts\nfile2.ts' },
      });
      const event = buildEventFromHook(parsed);
      assert.ok(event);
      assert.ok(event.output_preview);
      assert.ok(event.output_data);
    });
  });

  // ── handleSessionEvent + processHookLine integration ───────────────

  describe('processHookLine integration', () => {
    it('session_start creates a session', () => {
      const line = JSON.stringify(makeHookLine({
        _event_type: 'session_start',
        session_id: 'sess-int-1',
        cwd: '/home/user/project',
        model: 'claude-sonnet-4-20250514',
        source: 'startup',
        transcript_path: '/tmp/transcript.jsonl',
      }));
      const event = processHookLine(line);
      assert.ok(event);

      const session = getSession('sess-int-1');
      assert.ok(session);
      assert.equal(session.status, 'running');
      assert.equal(session.model, 'claude-sonnet-4-20250514');
      assert.equal(session.project_path, '/home/user/project');
      assert.equal(session.project_name, 'project');
    });

    it('session_end completes the session', () => {
      const endLine = JSON.stringify(makeHookLine({
        _event_type: 'session_end',
        session_id: 'sess-int-1',
        _captured_at: '2026-03-12T01:00:00.000Z',
        reason: 'user_exit',
      }));
      processHookLine(endLine);

      const session = getSession('sess-int-1');
      assert.ok(session);
      assert.equal(session.status, 'completed');
      assert.equal(session.end_reason, 'user_exit');
      assert.ok(session.duration_ms! > 0);
    });

    it('pre_tool_use increments tool_call_count', () => {
      // Create fresh session
      const startLine = JSON.stringify(makeHookLine({
        _event_type: 'session_start',
        session_id: 'sess-int-2',
        cwd: '/tmp',
      }));
      processHookLine(startLine);

      const toolLine = JSON.stringify(makeHookLine({
        _event_type: 'pre_tool_use',
        session_id: 'sess-int-2',
        tool_name: 'Read',
        _captured_at: '2026-03-12T00:00:01.000Z',
      }));
      processHookLine(toolLine);

      const session = getSession('sess-int-2');
      assert.ok(session);
      assert.equal(session.tool_call_count, 1);
    });

    it('pre_compact increments compaction_count', () => {
      const compactLine = JSON.stringify(makeHookLine({
        _event_type: 'pre_compact',
        session_id: 'sess-int-2',
        _captured_at: '2026-03-12T00:00:02.000Z',
        trigger: 'auto',
      }));
      processHookLine(compactLine);

      const session = getSession('sess-int-2');
      assert.ok(session);
      assert.equal(session.compaction_count, 1);
    });

    it('subagent_start increments subagent_count', () => {
      const agentLine = JSON.stringify(makeHookLine({
        _event_type: 'subagent_start',
        session_id: 'sess-int-2',
        _captured_at: '2026-03-12T00:00:03.000Z',
        agent_id: 'agent-1',
      }));
      processHookLine(agentLine);

      const session = getSession('sess-int-2');
      assert.ok(session);
      assert.equal(session.subagent_count, 1);
    });

    it('returns null for invalid line', () => {
      assert.equal(processHookLine('not json'), null);
    });

    it('returns null for unknown event type', () => {
      const line = JSON.stringify(makeHookLine({ _event_type: 'custom_unknown' }));
      assert.equal(processHookLine(line), null);
    });
  });
});
