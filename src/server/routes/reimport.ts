import { Hono } from 'hono';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../shared/constants.js';
import { importTranscripts } from '../../ingestion/transcript-importer.js';
import { getDb } from '../../db/connection.js';
import * as logger from '../../shared/logger.js';

function collectJsonlFilesRecursive(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsonlFilesRecursive(fullPath));
    } else if (entry.name.endsWith('.jsonl')) {
      files.push(fullPath);
    }
  }
  return files;
}

type ReimportPhase = 'idle' | 'importing' | 'vacuuming' | 'done';

interface ReimportStatus {
  running: boolean;
  phase: ReimportPhase;
  total: number;
  processed: number;
  imported: number;
  errors: number;
  done: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

let status: ReimportStatus = {
  running: false,
  phase: 'idle',
  total: 0,
  processed: 0,
  imported: 0,
  errors: 0,
  done: false,
  startedAt: null,
  finishedAt: null,
  error: null,
};

function publicStatus() {
  return {
    total: status.total,
    processed: status.processed,
    imported: status.imported,
    errors: status.errors,
    done: status.done,
    phase: status.phase,
    running: status.running,
    startedAt: status.startedAt,
    finishedAt: status.finishedAt,
    error: status.error,
  };
}

async function runReimport(): Promise<void> {
  // Yield once so the 202 response flushes before the synchronous directory scan.
  await new Promise((r) => setImmediate(r));

  const projectsDir = DEFAULT_CONFIG.claudeProjectsPath;

  try {
    const files = collectJsonlFilesRecursive(projectsDir).sort();
    status.total = files.length;

    const results = await importTranscripts(files, {
      force: true,
      onProgress: (p) => {
        status.processed = p.processed;
        status.total = p.total;
      },
    });

    status.imported = results.filter((r) => !r.error).length;
    status.errors = results.filter((r) => r.error).length;

    status.phase = 'vacuuming';
    // Yield so a status poll can observe `vacuuming` before the synchronous VACUUM freeze.
    await new Promise((r) => setImmediate(r));
    // VACUUM is best-effort cleanup; the import has already committed. A failure
    // here (e.g. SQLITE_BUSY, or no disk for the temp copy) must not be reported
    // as a failed re-import, so swallow it after logging rather than bubbling to
    // the catch below.
    try {
      getDb().exec('VACUUM');
    } catch (vacErr) {
      logger.warn('Reimport completed but VACUUM failed', { error: String(vacErr) });
    }

    status.phase = 'done';
    status.done = true;
    status.running = false;
    status.finishedAt = new Date().toISOString();
  } catch (e) {
    status.error = String(e);
    status.phase = 'done';
    status.done = true;
    status.running = false;
    status.finishedAt = new Date().toISOString();
  }
}

const reimport = new Hono();

reimport.post('/api/reimport', (c) => {
  if (status.running) {
    // A run is already in progress — reject and return the live status so the
    // caller can attach to it without a second round-trip.
    return c.json({ started: false, ...publicStatus() }, 409);
  }

  status = {
    running: true,
    phase: 'importing',
    total: 0,
    processed: 0,
    imported: 0,
    errors: 0,
    done: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };

  void runReimport();

  // Same shape as the 409 branch (a `started` flag plus the public status), so
  // callers see a stable body regardless of which branch they hit.
  return c.json({ started: true, ...publicStatus() }, 202);
});

reimport.get('/api/reimport/status', (c) => {
  return c.json(publicStatus());
});

reimport.post('/api/clear', (c) => {
  const confirm = c.req.query('confirm');
  if (confirm !== 'true') {
    return c.json({ error: 'Missing confirm=true query parameter. This action deletes all data.' }, 400);
  }

  const db = getDb();
  db.exec('DELETE FROM events; DELETE FROM agent_relationships; DELETE FROM sessions;');

  return c.json({ cleared: true, message: 'All data cleared' });
});

export { reimport };
