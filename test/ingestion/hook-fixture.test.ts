import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { getDb, closeDb } from '../../src/db/index.js';
import {
  parseHookLine,
  buildEventFromHook,
  processHookLine,
} from '../../src/ingestion/hook-handler.js';
import { getSession } from '../../src/db/index.js';

const FIXTURE_PATH = join(import.meta.dirname, '..', 'fixtures', 'sample-hook-events.jsonl');

describe('Hook handler with fixture data', () => {
  let tmpDir: string;
  let lines: string[];

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hook-fixture-test-'));
    getDb(join(tmpDir, 'test.sqlite'));

    const content = readFileSync(FIXTURE_PATH, 'utf-8');
    lines = content.split('\n').filter(l => l.trim());
  });

  after(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses all hook event lines from fixture', () => {
    for (const line of lines) {
      const parsed = parseHookLine(line);
      assert.ok(parsed, `Failed to parse: ${line.slice(0, 80)}`);
      assert.ok(parsed._event_type);
      assert.ok(parsed.session_id);
      assert.ok(parsed._captured_at);
    }
  });

  it('builds events from all fixture lines', () => {
    let builtCount = 0;
    for (const line of lines) {
      const parsed = parseHookLine(line);
      if (parsed) {
        const event = buildEventFromHook(parsed);
        if (event) builtCount++;
      }
    }
    // All 9 lines should produce valid events
    assert.equal(builtCount, 9);
  });

  it('processes full lifecycle from fixture', () => {
    // Process all events in order
    for (const line of lines) {
      processHookLine(line);
    }

    // Verify session was created and completed
    const session = getSession('hook-sess-1');
    assert.ok(session);
    assert.equal(session.status, 'completed');
    assert.equal(session.model, 'claude-sonnet-4-20250514');
    assert.equal(session.project_path, '/home/user/my-project');
    assert.equal(session.project_name, 'my-project');
    assert.equal(session.end_reason, 'user_exit');
    assert.ok(session.duration_ms! > 0);

    // Counts should reflect the fixture events
    assert.equal(session.tool_call_count, 2); // 2 pre_tool_use events
    assert.equal(session.compaction_count, 1); // 1 pre_compact event
    assert.equal(session.subagent_count, 1); // 1 subagent_start event
  });

  it('extracts tool names from pre_tool_use events', () => {
    const toolLines = lines.filter(l => {
      const p = parseHookLine(l);
      return p?._event_type === 'pre_tool_use';
    });

    assert.equal(toolLines.length, 2);

    const parsed1 = parseHookLine(toolLines[0])!;
    assert.equal(parsed1.tool_name, 'Read');

    const parsed2 = parseHookLine(toolLines[1])!;
    assert.equal(parsed2.tool_name, 'Write');
  });

  it('extracts agent info from subagent events', () => {
    const agentStartLine = lines.find(l => {
      const p = parseHookLine(l);
      return p?._event_type === 'subagent_start';
    })!;

    const parsed = parseHookLine(agentStartLine)!;
    assert.equal(parsed.agent_id, 'agent-abc123');
    assert.equal(parsed.agent_type, 'general-purpose');

    const event = buildEventFromHook(parsed)!;
    assert.equal(event.event_type, 'subagent_start');
    assert.equal(event.agent_id, 'agent-abc123');
  });

  it('captures output data from post_tool_use events', () => {
    const postLine = lines.find(l => {
      const p = parseHookLine(l);
      return p?._event_type === 'post_tool_use' && p.tool_name === 'Read';
    })!;

    const parsed = parseHookLine(postLine)!;
    const event = buildEventFromHook(parsed)!;
    assert.ok(event.output_preview);
    assert.ok(event.output_data);
    assert.ok(event.output_preview!.includes('main'));
  });
});

describe('Hook handler dedup with eventExists', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hook-dedup-test-'));
    getDb(join(tmpDir, 'test.sqlite'));
  });

  after(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('eventExists returns false then true after insertion', async () => {
    const { eventExists, insertEvent } = await import('../../src/db/queries/events.js');

    // Create a session first
    processHookLine(JSON.stringify({
      _event_type: 'session_start',
      _captured_at: '2026-03-12T00:00:00.000Z',
      _capture_version: '0.1.0',
      session_id: 'dedup-sess',
      cwd: '/tmp',
    }));

    // Check event doesn't exist
    assert.equal(
      eventExists('dedup-sess', 'tool_call_start', 'Read', '2026-03-12T00:01:00.000Z'),
      false,
    );

    // Insert an event
    insertEvent({
      session_id: 'dedup-sess',
      parent_event_id: null,
      agent_id: null,
      event_type: 'tool_call_start',
      event_source: 'hook',
      tool_name: 'Read',
      timestamp: '2026-03-12T00:01:00.000Z',
      sequence_num: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      context_pct: null,
      input_preview: null,
      input_data: null,
      output_preview: null,
      output_data: null,
      thinking_summary: null,
      thinking_text: null,
      duration_ms: null,
      metadata: null,
    });

    // Now it should exist
    assert.equal(
      eventExists('dedup-sess', 'tool_call_start', 'Read', '2026-03-12T00:01:00.000Z'),
      true,
    );
  });
});
