import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_CONFIG } from '../shared/constants.js';
import * as logger from '../shared/logger.js';
import { runMigrations } from './migrations.js';

let instance: Database.Database | null = null;
let currentDbPath: string | null = null;

// Registry for statement cache reset callbacks — called on closeDb()
const statementCacheResetters: Array<() => void> = [];

/** Register a callback that resets cached prepared statements when the DB is closed. */
export function onDbClose(resetter: () => void): void {
  statementCacheResetters.push(resetter);
}

export function getDb(dbPath?: string): Database.Database {
  if (instance) return instance;

  const resolvedPath = dbPath ?? DEFAULT_CONFIG.dbPath;

  try {
    mkdirSync(dirname(resolvedPath), { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot create database directory at ${dirname(resolvedPath)}: ${msg}`);
  }

  logger.debug('Opening database', { path: resolvedPath });

  try {
    instance = new Database(resolvedPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('SQLITE_BUSY') || msg.includes('database is locked')) {
      throw new Error(
        `Database is locked at ${resolvedPath}. ` +
        `Check if another claude-monitor process is running, or delete the lock file.`
      );
    }
    if (msg.includes('not a database') || msg.includes('file is not a database')) {
      throw new Error(
        `Database file is corrupt at ${resolvedPath}. ` +
        `Delete it to start fresh: rm "${resolvedPath}"`
      );
    }
    throw new Error(`Cannot open database at ${resolvedPath}: ${msg}`);
  }

  currentDbPath = resolvedPath;

  try {
    instance.pragma('journal_mode = WAL');
    instance.pragma('busy_timeout = 5000');
    instance.pragma('foreign_keys = ON');
    instance.pragma('synchronous = NORMAL');
    instance.pragma('cache_size = -64000');
    instance.pragma('temp_store = MEMORY');
    instance.pragma('mmap_size = 268435456'); // 256MB memory-mapped I/O for read-heavy workloads
  } catch (err) {
    instance.close();
    instance = null;
    currentDbPath = null;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to configure database: ${msg}`);
  }

  try {
    runMigrations(instance);
  } catch (err) {
    instance.close();
    instance = null;
    currentDbPath = null;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Database migration failed: ${msg}. ` +
      `If the schema is corrupt, delete the database and re-import: rm "${resolvedPath}"`
    );
  }

  return instance;
}

export function closeDb(): void {
  if (instance) {
    logger.debug('Closing database');
    instance.close();
    instance = null;
    currentDbPath = null;
    // Invalidate all cached prepared statements
    for (const reset of statementCacheResetters) reset();
  }
}

export function getDbPath(): string {
  return currentDbPath ?? DEFAULT_CONFIG.dbPath;
}
