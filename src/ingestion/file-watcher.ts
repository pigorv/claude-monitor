import { watch, openSync, readSync, closeSync, statSync, existsSync, type FSWatcher } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_CONFIG } from '../shared/constants.js';
import { eventExists, insertEvent, insertEvents } from '../db/queries/events.js';
import { processHookLine } from './hook-handler.js';
import * as logger from '../shared/logger.js';
import type { Event } from '../shared/types.js';

export interface FileWatcher {
  start(): void;
  stop(): void;
  readonly isRunning: boolean;
}

// Maximum bytes to read in a single processNewData call (10 MB)
const MAX_READ_CHUNK = 10 * 1024 * 1024;

export function createFileWatcher(eventsFilePath?: string): FileWatcher {
  const filePath = eventsFilePath ?? DEFAULT_CONFIG.eventsFilePath;
  let byteOffset = 0;
  let partialLine = '';
  let fsWatcher: FSWatcher | null = null;
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let running = false;

  function processNewData(): void {
    try {
      if (!existsSync(filePath)) return;

      const stats = statSync(filePath);

      // Handle file truncation
      if (stats.size < byteOffset) {
        logger.info('Events file truncated, resetting offset');
        byteOffset = 0;
        partialLine = '';
      }

      if (stats.size === byteOffset) return;

      // Cap read size to prevent OOM on very large files
      const bytesToRead = Math.min(stats.size - byteOffset, MAX_READ_CHUNK);
      const buffer = Buffer.alloc(bytesToRead);
      const fd = openSync(filePath, 'r');
      try {
        readSync(fd, buffer, 0, buffer.length, byteOffset);
      } finally {
        closeSync(fd);
      }

      byteOffset += bytesToRead;
      const chunk = partialLine + buffer.toString('utf-8');
      const lines = chunk.split('\n');

      // Last element is either empty (if chunk ended with \n) or a partial line
      partialLine = lines.pop() ?? '';

      // Batch events for insertion
      const batch: Omit<Event, 'id'>[] = [];
      const seenInBatch = new Set<string>();

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const event = processHookLine(line);
          if (!event) continue;

          // Dedup key for both DB and in-batch dedup
          const dedupKey = `${event.session_id}|${event.event_type}|${event.tool_name ?? ''}|${event.timestamp}`;

          // In-batch dedup
          if (seenInBatch.has(dedupKey)) {
            logger.debug('Duplicate event skipped (in-batch)', { session_id: event.session_id, type: event.event_type });
            continue;
          }

          // DB dedup check
          if (eventExists(event.session_id, event.event_type, event.tool_name, event.timestamp)) {
            logger.debug('Duplicate event skipped', { session_id: event.session_id, type: event.event_type });
            seenInBatch.add(dedupKey);
            continue;
          }

          seenInBatch.add(dedupKey);
          batch.push(event);
        } catch (err) {
          logger.error('Failed to process hook line', { error: String(err) });
        }
      }

      // Batch insert all events in a single transaction
      if (batch.length > 0) {
        try {
          insertEvents(batch);
          logger.debug('Batch inserted hook events', { count: batch.length });
        } catch (err) {
          logger.error('Failed to batch insert events, falling back to individual inserts', { error: String(err) });
          for (const event of batch) {
            try {
              insertEvent(event);
            } catch (innerErr) {
              logger.error('Failed to insert individual event', { error: String(innerErr) });
            }
          }
        }
      }

      // If there's more data to read, schedule another pass
      if (bytesToRead < stats.size - (byteOffset - bytesToRead)) {
        // Use setImmediate to avoid blocking, will catch up on next poll/watch
        logger.debug('More data to read, will continue on next cycle');
      }
    } catch (err) {
      logger.error('Error reading events file', { error: String(err) });
    }
  }

  function startWatching(): void {
    // Initialize offset to current file size (skip existing content)
    if (existsSync(filePath)) {
      byteOffset = statSync(filePath).size;
    }

    // Watch file or parent directory
    const watchTarget = existsSync(filePath) ? filePath : dirname(filePath);
    try {
      fsWatcher = watch(watchTarget, () => {
        processNewData();
      });
      fsWatcher.on('error', (err) => {
        logger.warn('File watcher error, relying on polling', { error: String(err) });
      });
    } catch {
      logger.warn('Could not create fs.watch, relying on polling');
    }

    // Safety-net polling
    pollInterval = setInterval(processNewData, 1000);

    logger.info('File watcher started', { path: filePath });
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      startWatching();
    },

    stop(): void {
      if (!running) return;
      running = false;

      if (fsWatcher) {
        fsWatcher.close();
        fsWatcher = null;
      }
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }

      logger.info('File watcher stopped');
    },

    get isRunning(): boolean {
      return running;
    },
  };
}
