import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { getDbPath } from '../../db/connection.js';

const exportRoute = new Hono();

exportRoute.get('/api/export', (c) => {
  const dbPath = getDbPath();
  const data = readFileSync(dbPath);
  const filename = `claude-monitor-${new Date().toISOString().slice(0, 10)}.sqlite`;

  c.header('Content-Type', 'application/x-sqlite3');
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  c.header('Content-Length', String(data.length));

  return c.body(data);
});

export { exportRoute };
