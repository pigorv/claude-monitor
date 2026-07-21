import { Hono } from 'hono';
import { VERSION, CONFIG } from '../../shared/constants.js';
import { getDbStats } from '../../db/queries/stats.js';
import { getDbPath } from '../../db/connection.js';

export function health(port?: number): Hono {
  const app = new Hono();

  app.get('/api/health', (c) => {
    const stats = getDbStats();
    return c.json({
      status: 'ok',
      version: VERSION,
      node_version: process.version,
      platform: process.platform,
      db_path: getDbPath(),
      db_engine: 'better-sqlite3 (WAL)',
      server_port: port ?? CONFIG.defaultPort,
      db_size_bytes: stats.dbSizeBytes,
      session_count: stats.sessionCount,
      event_count: stats.eventCount,
      oldest_session: stats.oldestSession,
      newest_session: stats.newestSession,
    });
  });

  return app;
}
