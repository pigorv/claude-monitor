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
      INSERT INTO events (session_id, event_type, event_source, tool_name,
        timestamp, sequence_num, input_tokens, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // 1. Manual compaction with tokens_before and trigger metadata.
    insertEvent.run('sess-1', 'compaction', 'transcript_import', null,
      '2026-01-15T10:01:00Z', 1, 150000, '{"trigger":"manual"}');
    // 2. Later event carrying input_tokens — the lookahead at lines 44-46
    //    finds this and uses it for tokens_after.
    insertEvent.run('sess-1', 'assistant_message', 'transcript_import', null,
      '2026-01-15T10:02:00Z', 2, 42000, null);
    // 3. Thinking event (covers line 65 in likely_dropped).
    insertEvent.run('sess-1', 'thinking', 'transcript_import', null,
      '2026-01-15T10:03:00Z', 3, null, null);
    // 4. Tool event (covers the tool_name branch in likely_dropped).
    insertEvent.run('sess-1', 'tool_call_start', 'transcript_import', 'Read',
      '2026-01-15T10:04:00Z', 4, null, null);
    // 5. Second compaction with corrupt metadata — exercises the JSON.parse
    //    catch path and leaves trigger at its 'auto' default.
    insertEvent.run('sess-1', 'compaction', 'transcript_import', null,
      '2026-01-15T10:05:00Z', 5, 100000, '{not valid json');
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports manual trigger, tokens_after, and likely_dropped descriptions', () => {
    const details = analyzeCompactions('sess-1');
    assert.equal(details.length, 2);

    const manual = details[0];
    assert.equal(manual.trigger, 'manual');
    // tokens_after equals the seeded follow-up event's input_tokens (42000).
    assert.equal(manual.tokens_after, 42000);
    assert.equal(manual.tokens_before, 150000);

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

  it('defaults to auto trigger when metadata is corrupt', () => {
    const details = analyzeCompactions('sess-1');
    const corrupt = details[1];
    assert.equal(corrupt.trigger, 'auto');
    assert.equal(corrupt.tokens_before, 100000);
    // No later event carries input_tokens, so tokens_after stays 0.
    assert.equal(corrupt.tokens_after, 0);
  });
});
