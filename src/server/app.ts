import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { DEFAULT_CONFIG } from '../shared/constants.js';
import * as logger from '../shared/logger.js';
import { corsMiddleware } from './middleware.js';
import { health } from './routes/health.js';
import { sessions } from './routes/sessions.js';
import { events } from './routes/events.js';
import { stats } from './routes/stats.js';
import { reimport } from './routes/reimport.js';
import { exportRoute } from './routes/export.js';
import { staticRoutes } from './static.js';

export interface AppOptions {
  frontendDir?: string;
}

export function createApp(options?: AppOptions): Hono {
  const app = new Hono();

  // Global error handler — catch unexpected exceptions in routes
  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Unhandled route error', { path: c.req.path, method: c.req.method, error: message });
    return c.json({ error: 'Internal server error', message }, 500);
  });

  app.use('*', corsMiddleware);
  app.route('/', health);
  app.route('/', sessions);
  app.route('/', events);
  app.route('/', stats);
  app.route('/', reimport);
  app.route('/', exportRoute);

  // Static file serving must be last (SPA fallback catches all non-API routes)
  if (options?.frontendDir) {
    app.route('/', staticRoutes(options.frontendDir));
  }

  return app;
}

export function startServer(port?: number, options?: AppOptions): Promise<ReturnType<typeof serve>> {
  const app = createApp(options);
  const resolvedPort = port ?? DEFAULT_CONFIG.defaultPort;

  return new Promise((resolve, reject) => {
    const server = serve({
      fetch: app.fetch,
      port: resolvedPort,
    }, () => {
      logger.info(`Server listening on http://localhost:${resolvedPort}`);
      resolve(server);
    });

    // Handle port conflicts and other startup errors
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${resolvedPort} is already in use. ` +
          `Either stop the other process or use --port <number> to pick a different port.`
        ));
      } else {
        reject(err);
      }
    });
  });
}
