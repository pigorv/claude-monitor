import { Hono } from 'hono';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../shared/constants.js';
import { importTranscript } from '../../ingestion/transcript-importer.js';
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

const reimport = new Hono();

reimport.post('/api/reimport', async (c) => {
  const projectsDir = DEFAULT_CONFIG.claudeProjectsPath;
  let imported = 0;
  let errors = 0;

  try {
    const files = collectJsonlFilesRecursive(projectsDir).sort();
    for (const file of files) {
      try {
        const result = await importTranscript(file, { force: true });
        if (!result.error) imported++;
        else errors++;
      } catch (e) {
        errors++;
        logger.warn(`Failed to import ${file}`, { error: String(e) });
      }
    }
  } catch (e) {
    return c.json({ imported, errors, message: `Error scanning projects: ${e}` }, 500);
  }

  return c.json({ imported, errors });
});

reimport.post('/api/clear', (c) => {
  // Security fix: Replaced trivial 'confirm=true' check with a secure Admin API key 
  // requirement to prevent unauthorized database deletion (auth bypass).
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    return c.json({ error: 'Server misconfiguration: ADMIN_API_KEY is not set.' }, 500);
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader || authHeader !== `Bearer ${adminKey}`) {
    return c.json({ error: 'Unauthorized: Invalid or missing admin API key.' }, 401);
  }

  const db = getDb();
  db.exec('DELETE FROM events; DELETE FROM agent_relationships; DELETE FROM sessions;');

  return c.json({ cleared: true, message: 'All data cleared' });
});

export { reimport };
