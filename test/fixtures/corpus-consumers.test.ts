import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseTranscript } from '../../src/ingestion/jsonl-parser.js';
import { buildTokenSnapshots } from '../../src/ingestion/token-tracker.js';
import { importTranscript } from '../../src/ingestion/transcript-importer.js';
import { getDb, closeDb } from '../../src/db/connection.js';
import { listEventsBySession } from '../../src/db/queries/events.js';
import { getAgentRelationships, getLinkedSessions } from '../../src/db/queries/sessions.js';
import type { TranscriptMessage } from '../../src/shared/types.js';

// This spec lives IN test/fixtures/, so fixtures resolve from its own directory.
const fx = (rel: string): string => join(import.meta.dirname, rel);

async function collect(path: string): Promise<TranscriptMessage[]> {
  const out: TranscriptMessage[] = [];
  for await (const msg of parseTranscript(path)) out.push(msg);
  return out;
}

// The corpus is committed test DATA; these specs are what actually exercise it
// through the real pipeline. The PII gate proves the fixtures are clean; this
// proves they still drive the behavior each taxonomy dir was authored to cover.

describe('corpus consumers: corrupt/ — parser degrades, never throws', () => {
  // Each corrupt file holds 3 source records with exactly one unparseable line;
  // parseTranscript must skip the bad line and yield the other two.
  for (const file of ['malformed-midfile.jsonl', 'truncated.jsonl', 'non-utf8.jsonl']) {
    it(`skips the bad line in ${file} and yields the 2 valid ones`, async () => {
      const msgs = await collect(fx(join('corrupt', file)));
      assert.equal(msgs.length, 2);
    });
  }
});

describe('corpus consumers: legacy-format/ — older shapes still ingest', () => {
  const counts: Array<[string, number]> = [
    ['bare-string-content.jsonl', 4],
    ['missing-usage.jsonl', 5],
    ['no-version.jsonl', 4],
  ];
  for (const [file, expected] of counts) {
    it(`parses ${file} into ${expected} messages without throwing`, async () => {
      const msgs = await collect(fx(join('legacy-format', file)));
      assert.equal(msgs.length, expected);
    });
  }

  it('normalizes bare-string message.content into content blocks', async () => {
    const msgs = await collect(fx('legacy-format/bare-string-content.jsonl'));
    for (const m of msgs) {
      assert.ok(Array.isArray(m.content), 'content should be normalized to an array');
    }
  });

  it('tolerates assistant messages with no usage object', async () => {
    const msgs = await collect(fx('legacy-format/missing-usage.jsonl'));
    const noUsage = msgs.filter((m) => m.type === 'assistant' && m.usage === undefined);
    assert.ok(noUsage.length > 0, 'expected at least one assistant message with no usage');
  });
});

describe('corpus consumers: large/ — big session parses', () => {
  it('parses the large session without throwing', async () => {
    const msgs = await collect(fx('large/large-session.jsonl'));
    assert.ok(msgs.length >= 200, `expected a large message count, got ${msgs.length}`);
  });
});

describe('corpus consumers: compaction/ — token tracker flags the drop', () => {
  it('flags exactly one is_compaction snapshot', async () => {
    const msgs = await collect(fx('compaction/compaction-session.jsonl'));
    const snapshots = buildTokenSnapshots(msgs);
    assert.ok(snapshots.length > 0, 'expected snapshots from the compaction fixture');
    const compactions = snapshots.filter((s) => s.is_compaction);
    assert.equal(compactions.length, 1);
  });
});

describe('corpus consumers: DB-backed import', () => {
  const TEST_DIR = join(tmpdir(), `corpus-consumers-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    getDb(join(TEST_DIR, 'test.sqlite'));
  });

  afterEach(() => {
    closeDb();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('subagent/ — importing the parent attributes the child to its parent', async () => {
    const parent = fx('subagent/9f5e3bfd-73b8-4421-9e78-e736180128b4.jsonl');
    const result = await importTranscript(parent);
    assert.ok(result.sessionId);

    const { events } = listEventsBySession(result.sessionId, { limit: 1000 });
    const attributed = events.filter((e) => e.agent_id != null);
    assert.ok(attributed.length > 0, 'expected subagent events carrying an agent_id');

    const relationships = getAgentRelationships(result.sessionId);
    assert.equal(relationships.length, 1);
    assert.ok(relationships[0].child_agent_id, 'relationship should name the child agent');
  });

  it('plan-impl-pair/ — importing both links plan → implementation exactly once', async () => {
    await importTranscript(fx('plan-impl-pair/plan-session.jsonl'));
    await importTranscript(fx('plan-impl-pair/impl-session.jsonl'));

    const links = getLinkedSessions('impl-session-001');
    const planLinks = links.filter((l) => l.relationship === 'planning_session');
    assert.equal(planLinks.length, 1);
    assert.equal(planLinks[0].session_id, 'plan-session-001');
  });
});
