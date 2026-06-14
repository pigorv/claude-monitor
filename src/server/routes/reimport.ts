import { Hono } from 'hono';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../shared/constants.js';
import { importTranscripts } from '../../ingestion/transcript-importer.js';
import { getDb } from '../../db/connection.js';

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

const reimport = new Hono();

reimport.post('/api/reimport', async (c) => {
  const projectsDir = DEFAULT_CONFIG.claudeProjectsPath;
  let imported = 0;
  let errors = 0;

  try {
    const files = collectJsonlFilesRecursive(projectsDir).sort();
    const results = await importTranscripts(files, { force: true });
    imported = results.filter((r) => !r.error).length;
    errors = results.filter((r) => r.error).length;
  } catch (e) {
    return c.json({ imported, errors, message: `Error scanning projects: ${e}` }, 500);
  }

  return c.json({ imported, errors });
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
