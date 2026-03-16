import { Hono } from 'hono';
import { VERSION, DEFAULT_CONFIG } from '../../shared/constants.js';
import { getDbStats } from '../../db/queries/stats.js';
import { getDbPath } from '../../db/connection.js';

const health = new Hono();

health.get('/api/health', (c) => {
  const stats = getDbStats();
  return c.json({
    status: 'ok',
    version: VERSION,
    node_version: process.version,
    db_path: getDbPath(),
    db_engine: 'better-sqlite3 (WAL)',
    server_port: Number(process.env.PORT || DEFAULT_CONFIG.defaultPort),
    db_size_bytes: stats.dbSizeBytes,
    session_count: stats.sessionCount,
    event_count: stats.eventCount,
    oldest_session: stats.oldestSession,
    newest_session: stats.newestSession,
  });
});

export { health };
