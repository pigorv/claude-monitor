import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, closeDb } from '../../src/db/index.js';
import { analyzeCompactions } from '../../src/analysis/compaction-analysis.js';

describe('analyzeCompactions', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'compaction-test-'));
    const dbPath = join(tmpDir, 'test.sqlite');
    const db = getDb(dbPath);

    db.prepare(`
      INSERT INTO sessions (id, project_path, status, started_at)
      VALUES (?, ?, ?, ?)
    `).run('sess-1', '/tmp/a', 'completed', '2026-01-15T10:00:00Z');

    const insertEvent = db.prepare(`
      INSERT INTO events (session_id, agent_id, event_type, event_source, tool_name,
        timestamp, sequence_num, input_tokens, cache_read_tokens, cache_write_tokens, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // seq 1 — parent assistant event forming the pre-drop peak. Effective
    // context = 20000 + 120000 + 10000 = 150000, well above raw input_tokens.
    insertEvent.run('sess-1', null, 'assistant_message', 'transcript_import', null,
      '2026-01-15T10:01:00Z', 1, 20000, 120000, 10000, null);
    // seq 2 — SUBAGENT event (non-NULL agent_id) with a huge effective context.
    //   It is the immediate predecessor of the first compaction. If the
    //   agent_id IS NULL filter were missing, this row would be chosen for
    //   tokens_before. It must NOT be (Behavior #6).
    insertEvent.run('sess-1', 'agent-x', 'assistant_message', 'transcript_import', null,
      '2026-01-15T10:01:30Z', 2, 900000, 900000, 900000, null);
    // seq 3 — Manual compaction (post-drop). Effective context =
    //   10000 + 30000 + 2000 = 42000, lower than the preceding parent peak.
    insertEvent.run('sess-1', null, 'compaction', 'transcript_import', null,
      '2026-01-15T10:02:00Z', 3, 10000, 30000, 2000, '{"trigger":"manual"}');
    // seq 4 — Thinking event (covers thinking_blocks branch in likely_dropped).
    insertEvent.run('sess-1', null, 'thinking', 'transcript_import', null,
      '2026-01-15T10:03:00Z', 4, null, null, null, null);
    // seq 5 — Tool event (covers the tool_name branch in likely_dropped).
    insertEvent.run('sess-1', null, 'tool_call_start', 'transcript_import', 'Read',
      '2026-01-15T10:04:00Z', 5, null, null, null, null);
    // seq 6 — Second compaction with corrupt metadata — exercises the
    //   JSON.parse catch path and leaves trigger at its 'auto' default.
    //   Effective context = 5000 + 90000 + 5000 = 100000.
    insertEvent.run('sess-1', null, 'compaction', 'transcript_import', null,
      '2026-01-15T10:05:00Z', 6, 5000, 90000, 5000, '{not valid json');
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports manual trigger, effective-context before/after, and likely_dropped descriptions', () => {
    const details = analyzeCompactions('sess-1');
    assert.equal(details.length, 2);

    const manual = details[0];
    assert.equal(manual.trigger, 'manual');
    // tokens_after = effective context of the compaction event itself (42000),
    // NOT its raw input_tokens (10000).
    assert.equal(manual.tokens_after, 42000);
    // tokens_before = effective context of the nearest preceding PARENT event
    // (seq 1 peak = 150000), NOT the subagent row at seq 2.
    assert.equal(manual.tokens_before, 150000);
    // Genuine drop: before >= after, so "Tokens Lost" >= 0.
    assert.ok(manual.tokens_before >= manual.tokens_after);

    // likely_dropped includes thinking, assistant, and tool descriptions.
    assert.ok(
      manual.likely_dropped.some((d) => d.includes('thinking blocks')),
      `Expected a thinking-blocks entry, got: ${JSON.stringify(manual.likely_dropped)}`,
    );
    assert.ok(
      manual.likely_dropped.some((d) => d.includes('assistant messages')),
      `Expected an assistant-messages entry, got: ${JSON.stringify(manual.likely_dropped)}`,
    );
    assert.ok(
      manual.likely_dropped.some((d) => d.includes('Read outputs')),
      `Expected a Read-outputs entry, got: ${JSON.stringify(manual.likely_dropped)}`,
    );
  });

  it('never uses a subagent row for tokens_before/after', () => {
    const details = analyzeCompactions('sess-1');
    // The subagent row at seq 2 has effective context 2,700,000. If it were
    // ever read, tokens_before would blow up. Assert both compactions stay
    // within the parent-event range.
    for (const d of details) {
      assert.ok(d.tokens_before < 900000, `subagent context leaked into tokens_before: ${d.tokens_before}`);
      assert.ok(d.tokens_after < 900000, `subagent context leaked into tokens_after: ${d.tokens_after}`);
    }
  });

  it('defaults to auto trigger when metadata is corrupt', () => {
    const details = analyzeCompactions('sess-1');
    const corrupt = details[1];
    assert.equal(corrupt.trigger, 'auto');
    // tokens_after = effective context of the second compaction event (100000).
    assert.equal(corrupt.tokens_after, 100000);
    // tokens_before = effective context of the nearest preceding parent event
    // with tokens — that is the first compaction (seq 3, effective 42000);
    // seq 4/5 carry no input_tokens.
    assert.equal(corrupt.tokens_before, 42000);
  });
});
