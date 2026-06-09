import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_CONFIG } from '../shared/constants.js';
import { importTranscript } from './transcript-importer.js';
import { getImportedMtimes } from '../db/queries/sessions.js';
import * as logger from '../shared/logger.js';

export interface TranscriptWatcher {
  start(): void;
  stop(): void;
  readonly isRunning: boolean;
}

const DEFAULT_POLL_MS = 5_000;

/**
 * Create a watcher that polls ~/.claude/projects/ for new or modified
 * transcript files and auto-imports them into the database.
 */
export function createTranscriptWatcher(options?: {
  projectsPath?: string;
  pollIntervalMs?: number;
}): TranscriptWatcher {
  const projectsPath = options?.projectsPath ?? DEFAULT_CONFIG.claudeProjectsPath;
  const pollMs = options?.pollIntervalMs ?? DEFAULT_POLL_MS;

  // Track mtime per file so we only import new/modified transcripts
  const knownMtimes = new Map<string, number>();
  // Track last import time per file to debounce rapid changes
  const lastImportTime = new Map<string, number>();
  const DEBOUNCE_MS = 10_000; // Don't reimport the same file more than once per 10s
  let interval: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let scanning = false;

  /**
   * Collect all .jsonl files under the projects directory,
   * sorted so parent transcripts come before subagent transcripts.
   */
  function collectFiles(): string[] {
    if (!existsSync(projectsPath)) return [];

    const files: string[] = [];
    function walk(dir: string): void {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.name.endsWith('.jsonl')) {
          files.push(fullPath);
        }
      }
    }
    walk(projectsPath);

    // Parents before subagents — same sort as import command
    return files.sort((a, b) => {
      const aIsSub = a.includes('/subagents/');
      const bIsSub = b.includes('/subagents/');
      if (aIsSub !== bIsSub) return aIsSub ? 1 : -1;
      return a.localeCompare(b);
    });
  }

  async function scan(): Promise<void> {
    if (scanning) return;
    scanning = true;

    try {
      const files = collectFiles();

      for (const filePath of files) {
        let mtime: number;
        try {
          mtime = statSync(filePath).mtimeMs;
        } catch {
          continue;
        }

        const prev = knownMtimes.get(filePath);
        if (prev !== undefined && prev >= mtime) continue;

        // Debounce: skip if we recently imported this file
        const isReimport = prev !== undefined;
        if (isReimport) {
          const lastImport = lastImportTime.get(filePath);
          if (lastImport && (Date.now() - lastImport) < DEBOUNCE_MS) continue;
        }

        // New or modified file — attempt import.
        // Always force re-import when the file has been modified since last scan,
        // so that in-progress sessions get updated as more data is written.
        try {
          const result = await importTranscript(filePath, { force: isReimport });
          knownMtimes.set(filePath, mtime);
          lastImportTime.set(filePath, Date.now());

          if (!result.skipped) {
            logger.info('Auto-imported transcript', {
              sessionId: result.sessionId,
              events: result.eventCount,
            });
          }
        } catch (err) {
          logger.error('Auto-import failed', {
            file: filePath,
            error: err instanceof Error ? err.message : String(err),
          });
          // Still update mtime to avoid retrying a broken file every 5s
          knownMtimes.set(filePath, mtime);
        }
      }
    } catch (err) {
      logger.error('Transcript scan failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      scanning = false;
    }
  }

  return {
    start(): void {
      if (running) return;
      running = true;

      // Seed knownMtimes from each session's last-imported mtime (persisted in the
      // DB) rather than the live filesystem. A session created OR appended-to while
      // the server was down then has no entry (or an older one) than its current
      // file mtime, so the first scan imports it; unchanged sessions match exactly
      // and are skipped without a full re-parse.
      //
      // Subagent files have no session row of their own — keep seeding them from the
      // filesystem so we don't blindly re-parse them every startup. They're imported
      // via their parent (and importSubagentFile is idempotent), so a missed subagent
      // change is recovered whenever the parent re-imports.
      const persisted = new Map<string, number>();
      for (const row of getImportedMtimes()) {
        persisted.set(resolve(row.transcript_path), row.last_imported_mtime);
      }
      for (const filePath of collectFiles()) {
        const isSubagent =
          filePath.includes('/subagents/') || filePath.includes('\\subagents\\');
        if (isSubagent) {
          try {
            knownMtimes.set(filePath, statSync(filePath).mtimeMs);
          } catch {
            // ignore
          }
        } else {
          const mtime = persisted.get(filePath);
          // Leave unseeded when absent → first scan imports it (new while down).
          if (mtime !== undefined) knownMtimes.set(filePath, mtime);
        }
      }

      // Run first scan immediately to pick up anything that changed while server was down
      scan();

      interval = setInterval(scan, pollMs);
      logger.info('Transcript watcher started', { path: projectsPath, pollMs });
    },

    stop(): void {
      if (!running) return;
      running = false;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      logger.info('Transcript watcher stopped');
    },

    get isRunning(): boolean {
      return running;
    },
  };
}
