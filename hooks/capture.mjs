#!/usr/bin/env node

// Standalone hook capture script for Claude Code.
// Zero dependencies — uses only node:fs and node:path.
// Must complete in < 50ms.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CAPTURE_VERSION = '0.1.0';

const eventType = process.argv[2];
if (!eventType) process.exit(0);

const dataDir = process.env.CLAUDE_MONITOR_DATA_DIR || join(homedir(), '.claude-monitor');
const eventsFile = join(dataDir, 'events.jsonl');

let input = '';

process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    if (!input.trim()) process.exit(0);

    let payload;
    try {
      payload = JSON.parse(input);
    } catch {
      // Malformed JSON — silently exit
      process.exit(0);
    }

    const enriched = {
      _event_type: eventType,
      _captured_at: new Date().toISOString(),
      _capture_version: CAPTURE_VERSION,
      ...payload,
    };

    mkdirSync(dataDir, { recursive: true });
    appendFileSync(eventsFile, JSON.stringify(enriched) + '\n');
  } catch {
    // Never crash — async hook, Claude Code doesn't check result
  }
});

// Handle stdin already closed (piped empty)
process.stdin.resume();
