const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LEVELS;

let currentLevel: number = LEVELS[(process.env['LOG_LEVEL'] as LogLevel) ?? 'info'] ?? LEVELS.info;

export function setLogLevel(level: LogLevel): void {
  currentLevel = LEVELS[level];
}

function write(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < currentLevel) return;

  let line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}`;

  if (data !== undefined) {
    try {
      line += ` ${JSON.stringify(data)}`;
    } catch {
      line += ' [unserializable data]';
    }
  }

  process.stderr.write(line + '\n');
}

export function debug(message: string, data?: Record<string, unknown>): void {
  write('debug', message, data);
}

export function info(message: string, data?: Record<string, unknown>): void {
  write('info', message, data);
}

export function warn(message: string, data?: Record<string, unknown>): void {
  write('warn', message, data);
}

export function error(message: string, data?: Record<string, unknown>): void {
  write('error', message, data);
}
