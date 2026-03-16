import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, VERSION } from '../../shared/constants.js';
import * as logger from '../../shared/logger.js';
import { getDb, closeDb } from '../../db/connection.js';
import { startServer } from '../../server/app.js';

const USAGE = `Usage: claude-monitor start [options]

  Start the dashboard server.

Options:
  --port, -p <number>   Port number (default: ${DEFAULT_CONFIG.defaultPort})
  --no-open             Don't open browser automatically
  --db <path>           Custom database path
  --verbose             Enable debug logging`;

function parseArgs(args: string[]): { port?: number; open: boolean; dbPath?: string; verbose: boolean } {
  const result = { open: true, verbose: false } as { port?: number; open: boolean; dbPath?: string; verbose: boolean };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg === '--port' || arg === '-p') {
      const val = parseInt(args[++i], 10);
      if (isNaN(val) || val < 1 || val > 65535) {
        console.error('Error: Invalid port number');
        process.exit(1);
      }
      result.port = val;
    } else if (arg === '--no-open') {
      result.open = false;
    } else if (arg === '--db') {
      result.dbPath = args[++i];
    } else if (arg === '--verbose') {
      result.verbose = true;
    }
  }

  return result;
}

export async function startCommand(args: string[]): Promise<void> {
  const opts = parseArgs(args);

  if (opts.verbose) {
    logger.setLogLevel('debug');
  }

  // Ensure data directory exists
  const dbPath = opts.dbPath ?? DEFAULT_CONFIG.dbPath;
  const dataDir = dirname(dbPath);
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // Initialize database
  getDb(dbPath);
  logger.debug('Database initialized', { path: dbPath });

  const port = opts.port ?? DEFAULT_CONFIG.defaultPort;

  // Resolve frontend directory (relative to this CLI entry point)
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const frontendDir = join(__dirname, 'frontend');

  // Start server
  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer(port, {
      frontendDir: existsSync(frontendDir) ? frontendDir : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }

  const shutdown = () => {
    closeDb();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`claude-monitor v${VERSION}`);
  console.log(`Dashboard running at http://localhost:${port}`);

  // Open browser
  if (opts.open) {
    try {
      const { default: open } = await import('open');
      await open(`http://localhost:${port}`);
    } catch {
      // open is optional — skip if not installed
      logger.debug('Could not open browser automatically');
    }
  }
}
