import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import { inflateRawSync } from 'node:zlib';
import { buildSessionBundle, SessionExportError } from '../../src/export/session-bundle.js';
import { importTranscripts } from '../../src/ingestion/transcript-importer.js';
import { getDb, closeDb } from '../../src/db/connection.js';
import { getSession, upsertSession } from '../../src/db/queries/sessions.js';
import { listEventsBySession } from '../../src/db/queries/events.js';
import type { Session } from '../../src/shared/types.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

// ── Minimal zip reader (mirrors the one in zip.test.ts) ─────────────

function parseZip(zip: Buffer): { name: string; data: Buffer }[] {
  const eocdOffset = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocdOffset), 0x06054b50, 'EOCD signature');
  const centralOffset = zip.readUInt32LE(eocdOffset + 16);

  const entries: { name: string; data: Buffer }[] = [];
  let pos = 0;
  while (pos < centralOffset) {
    assert.equal(zip.readUInt32LE(pos), 0x04034b50, 'local header signature');
    const method = zip.readUInt16LE(pos + 8);
    const compressedSize = zip.readUInt32LE(pos + 18);
    const nameLen = zip.readUInt16LE(pos + 26);
    const extraLen = zip.readUInt16LE(pos + 28);
    const nameStart = pos + 30;
    const name = zip.toString('utf8', nameStart, nameStart + nameLen);
    const payloadStart = nameStart + nameLen + extraLen;
    const payload = zip.subarray(payloadStart, payloadStart + compressedSize);
    const data = method === 8 ? inflateRawSync(payload) : Buffer.from(payload);
    entries.push({ name, data });
    pos = payloadStart + compressedSize;
  }
  return entries;
}

// A subagent transcript for sess-001 (its sessionId is the PARENT id — the
// way Claude Code records subagent transcripts).
const SUBAGENT_JSONL = [
  JSON.stringify({
    parentUuid: null, isSidechain: true, cwd: '/home/user/secret-proj', sessionId: 'sess-001',
    version: '2.1.0', type: 'user',
    message: { role: 'user', content: 'Investigate the config file at /home/user/secret-proj/config.json.' },
    timestamp: '2026-01-01T00:02:00.000Z', uuid: 'sub-uuid-user-1',
  }),
  JSON.stringify({
    parentUuid: 'sub-uuid-user-1', isSidechain: true, cwd: '/home/user/secret-proj', sessionId: 'sess-001',
    version: '2.1.0', type: 'assistant',
    message: {
      model: 'claude-sonnet-4-20250514', role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Reading the config file now.', signature: 'sub-sig-1' },
        { type: 'tool_use', id: 'sub-tool-1', name: 'Read', input: { file_path: '/home/user/secret-proj/config.json' } },
      ],
      usage: { input_tokens: 600, output_tokens: 120, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 },
    },
    timestamp: '2026-01-01T00:02:05.000Z', uuid: 'sub-uuid-asst-1',
  }),
].join('\n');

// ── Test layout ─────────────────────────────────────────────────────

const TEST_DIR = join(tmpdir(), `claude-monitor-bundle-test-${Date.now()}`);
const DB_PATH = join(TEST_DIR, 'test.sqlite');

/** Copy the parent fixture to <projDir>/sess-001.jsonl + write a subagent. */
function layOutTranscript(projDir: string): { parentPath: string } {
  mkdirSync(projDir, { recursive: true });
  const parentPath = join(projDir, 'sess-001.jsonl');
  copyFileSync(join(FIXTURES, 'happy', 'sample-session.jsonl'), parentPath);

  const subagentsDir = join(projDir, 'sess-001', 'subagents');
  mkdirSync(subagentsDir, { recursive: true });
  writeFileSync(join(subagentsDir, 'agent-aaa.jsonl'), SUBAGENT_JSONL);

  return { parentPath };
}

/** Seed a sessions row pointing at a real transcript so getSession resolves. */
function seedSessionRow(sessionId: string, transcriptPath: string): void {
  const row: Session = {
    id: sessionId,
    project_path: '/home/user/secret-proj',
    project_name: 'secret-proj',
    model: 'claude-opus-4-6',
    models_used: null,
    source: 'transcript_import',
    status: 'completed',
    started_at: '2026-01-01T00:00:00.000Z',
    ended_at: null,
    duration_ms: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_read_tokens: 0,
    total_cache_write_tokens: 0,
    total_input_tokens_billed: 0,
    total_cache_write_5m_tokens: 0,
    total_cache_write_1h_tokens: 0,
    peak_context_pct: null,
    compaction_count: 0,
    tool_call_count: 0,
    subagent_count: 0,
    summary: null,
    end_reason: null,
    transcript_path: transcriptPath,
    metadata: null,
    invocations: null,
    started_with: null,
    agent_avg_compression: null,
    agent_total_tokens: 0,
    agent_pressure_events: 0,
    agent_compacted_count: 0,
    peak_concurrency: 0,
  };
  upsertSession(row);
}

describe('buildSessionBundle', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    getDb(DB_PATH);
  });

  afterEach(() => {
    closeDb();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('throws an actionable error for an unknown session id', async () => {
    await assert.rejects(
      () => buildSessionBundle('does-not-exist'),
      (err: Error) => {
        // Typed so the route can 404 these without masking unexpected 500s.
        assert.ok(err instanceof SessionExportError);
        assert.match(err.message, /does-not-exist/);
        assert.match(err.message, /no such session|import/i);
        return true;
      },
    );
  });

  it('throws an actionable error when transcript_path is null', async () => {
    seedSessionRow('null-path', null as unknown as string);
    await assert.rejects(
      () => buildSessionBundle('null-path'),
      (err: Error) => {
        assert.ok(err instanceof SessionExportError);
        assert.match(err.message, /null-path/);
        assert.match(err.message, /transcript/i);
        return true;
      },
    );
  });

  it('throws an actionable error when the transcript file is gone', async () => {
    seedSessionRow('gone', join(TEST_DIR, 'projA', 'nope.jsonl'));
    await assert.rejects(
      () => buildSessionBundle('gone'),
      (err: Error) => {
        assert.ok(err instanceof SessionExportError);
        assert.match(err.message, /no longer exists/i);
        return true;
      },
    );
  });

  it('produces the expected entry layout + counts-only report', async () => {
    const { parentPath } = layOutTranscript(join(TEST_DIR, 'projA'));
    seedSessionRow('sess-001', parentPath);

    const { zip, filename, audit } = await buildSessionBundle('sess-001');
    assert.equal(filename, 'claude-monitor-session-sess-001.zip');

    const names = parseZip(zip).map((e) => e.name).sort();
    assert.deepEqual(names, [
      'sanitization-report.json',
      'sess-001.jsonl',
      'sess-001/subagents/agent-aaa.jsonl',
    ]);

    // sanitization-report.json is the counts-only audit, nothing else.
    const report = parseZip(zip).find((e) => e.name === 'sanitization-report.json')!;
    const parsed = JSON.parse(report.data.toString('utf8'));
    assert.deepEqual(Object.keys(parsed).sort(), Object.keys(audit).sort());
    assert.equal(typeof parsed.emitted, 'number');
    assert.ok(parsed.emitted > 0);
  });

  it('round-trips: unzip → import reconstructs session + events + agents', async () => {
    const { parentPath } = layOutTranscript(join(TEST_DIR, 'projA'));
    seedSessionRow('sess-001', parentPath);

    const { zip } = await buildSessionBundle('sess-001');
    const entries = parseZip(zip);

    // Unzip the bundle (sans report) into a fresh on-disk layout.
    const unzipRoot = join(TEST_DIR, 'unzipped');
    const importPaths: string[] = [];
    for (const e of entries) {
      if (e.name === 'sanitization-report.json') continue;
      const dest = join(unzipRoot, e.name);
      mkdirSync(join(dest, '..'), { recursive: true });
      writeFileSync(dest, e.data);
      if (!e.name.includes('/subagents/')) importPaths.push(dest);
    }

    // Also write the SAME sanitized bytes to a separate dir for a direct
    // import, to compare event count/order (zip→unzip must be lossless).
    const directRoot = join(TEST_DIR, 'direct');
    const directPaths: string[] = [];
    for (const e of entries) {
      if (e.name === 'sanitization-report.json') continue;
      const dest = join(directRoot, e.name);
      mkdirSync(join(dest, '..'), { recursive: true });
      writeFileSync(dest, e.data);
      if (!e.name.includes('/subagents/')) directPaths.push(dest);
    }

    // Import the unzipped bundle into a fresh DB.
    closeDb();
    rmSync(DB_PATH, { force: true });
    getDb(DB_PATH);
    await importTranscripts(importPaths, { force: true });

    const session = getSession('sess-001');
    assert.ok(session, 'session row reconstructed from unzipped bundle');

    const { events: bundleEvents } = listEventsBySession('sess-001', { includeThinking: true });
    assert.ok(bundleEvents.length > 0, 'events reconstructed');
    assert.ok(bundleEvents.some((e) => e.agent_id), 'subagent events discovered');

    const rel = getDb()
      .prepare('SELECT COUNT(*) AS n FROM agent_relationships WHERE parent_session_id = ?')
      .get('sess-001') as { n: number };
    assert.ok(rel.n > 0, 'agent relationship row created');

    const bundleOrder = bundleEvents.map((e) => `${e.event_type}:${e.sequence_num}`);

    // Direct import of the same sanitized bytes into a fresh DB.
    closeDb();
    const DB2 = join(TEST_DIR, 'direct.sqlite');
    getDb(DB2);
    await importTranscripts(directPaths, { force: true });
    const { events: directEvents } = listEventsBySession('sess-001', { includeThinking: true });
    const directOrder = directEvents.map((e) => `${e.event_type}:${e.sequence_num}`);

    assert.equal(bundleEvents.length, directEvents.length, 'event count matches direct import');
    assert.deepEqual(bundleOrder, directOrder, 'event order matches direct import');
  });

  it('explicit { sanitize: true } produces the same layout as the default call', async () => {
    const { parentPath } = layOutTranscript(join(TEST_DIR, 'projA'));
    seedSessionRow('sess-001', parentPath);

    const { zip: defaultZip, audit: defaultAudit } = await buildSessionBundle('sess-001');
    const { zip: explicitZip, audit: explicitAudit } = await buildSessionBundle('sess-001', {
      sanitize: true,
    });

    const defaultNames = parseZip(defaultZip).map((e) => e.name).sort();
    const explicitNames = parseZip(explicitZip).map((e) => e.name).sort();
    assert.deepEqual(explicitNames, defaultNames);
    assert.deepEqual(explicitNames, [
      'sanitization-report.json',
      'sess-001.jsonl',
      'sess-001/subagents/agent-aaa.jsonl',
    ]);
    // Both modes populate a counts-only audit with the same shape.
    assert.ok(defaultAudit);
    assert.ok(explicitAudit);
    assert.deepEqual(Object.keys(explicitAudit).sort(), Object.keys(defaultAudit).sort());
  });

  it('{ sanitize: false } copies each transcript byte-for-byte from disk', async () => {
    const { parentPath } = layOutTranscript(join(TEST_DIR, 'projA'));
    seedSessionRow('sess-001', parentPath);

    const { zip } = await buildSessionBundle('sess-001', { sanitize: false });
    const entries = parseZip(zip);

    const parentEntry = entries.find((e) => e.name === 'sess-001.jsonl')!;
    assert.ok(
      parentEntry.data.equals(readFileSync(parentPath)),
      'parent transcript is byte-for-byte identical to the on-disk fixture',
    );

    const subPath = join(TEST_DIR, 'projA', 'sess-001', 'subagents', 'agent-aaa.jsonl');
    const subEntry = entries.find((e) => e.name === 'sess-001/subagents/agent-aaa.jsonl')!;
    assert.ok(
      subEntry.data.equals(readFileSync(subPath)),
      'subagent transcript is byte-for-byte identical to the on-disk file',
    );
  });

  it('{ sanitize: false } adds export-manifest.json, drops the report, and has no audit', async () => {
    const { parentPath } = layOutTranscript(join(TEST_DIR, 'projA'));
    seedSessionRow('sess-001', parentPath);

    const { zip, filename, audit } = await buildSessionBundle('sess-001', { sanitize: false });
    assert.equal(filename, 'claude-monitor-session-sess-001.zip');
    assert.equal(audit, undefined);

    const names = parseZip(zip).map((e) => e.name).sort();
    assert.deepEqual(names, [
      'export-manifest.json',
      'sess-001.jsonl',
      'sess-001/subagents/agent-aaa.jsonl',
    ]);
    assert.ok(!names.includes('sanitization-report.json'));

    const manifest = parseZip(zip).find((e) => e.name === 'export-manifest.json')!;
    assert.deepEqual(JSON.parse(manifest.data.toString('utf8')), { sanitized: false });
  });

  it('raw round-trips: unzip → import reconstructs session + events + agents', async () => {
    const { parentPath } = layOutTranscript(join(TEST_DIR, 'projA'));
    seedSessionRow('sess-001', parentPath);

    const { zip } = await buildSessionBundle('sess-001', { sanitize: false });
    const entries = parseZip(zip);

    const unzipRoot = join(TEST_DIR, 'unzipped-raw');
    const importPaths: string[] = [];
    for (const e of entries) {
      if (e.name === 'export-manifest.json') continue;
      const dest = join(unzipRoot, e.name);
      mkdirSync(join(dest, '..'), { recursive: true });
      writeFileSync(dest, e.data);
      if (!e.name.includes('/subagents/')) importPaths.push(dest);
    }

    closeDb();
    rmSync(DB_PATH, { force: true });
    getDb(DB_PATH);
    await importTranscripts(importPaths, { force: true });

    const session = getSession('sess-001');
    assert.ok(session, 'session row reconstructed from unzipped raw bundle');

    const { events } = listEventsBySession('sess-001', { includeThinking: true });
    assert.ok(events.length > 0, 'events reconstructed');
    assert.ok(events.some((e) => e.agent_id), 'subagent events discovered');

    const rel = getDb()
      .prepare('SELECT COUNT(*) AS n FROM agent_relationships WHERE parent_session_id = ?')
      .get('sess-001') as { n: number };
    assert.ok(rel.n > 0, 'agent relationship row created');
  });

  it('never serializes the injected seed into any bundle entry (hex + raw)', async () => {
    const { parentPath } = layOutTranscript(join(TEST_DIR, 'projA'));
    seedSessionRow('sess-001', parentPath);

    // TEST-ONLY: inject a known seed, then assert its bytes appear nowhere.
    const seed = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    const seedHex = seed.toString('hex');

    const { zip } = await buildSessionBundle('sess-001', { seed });
    for (const e of parseZip(zip)) {
      assert.equal(e.data.toString('utf8').includes(seedHex), false, `${e.name} contains seed hex`);
      assert.equal(e.data.includes(seed), false, `${e.name} contains raw seed bytes`);
    }
  });
});
