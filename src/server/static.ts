import { Hono } from 'hono';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, resolve, normalize } from 'node:path';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function staticRoutes(frontendDir: string): Hono {
  const app = new Hono();
  const indexPath = join(frontendDir, 'index.html');
  const resolvedFrontendDir = resolve(frontendDir);

  app.get('/assets/*', (c) => {
    // Prevent path traversal: resolve and verify the path stays within frontendDir
    const filePath = resolve(join(frontendDir, normalize(c.req.path)));
    if (!filePath.startsWith(resolvedFrontendDir)) {
      return c.text('Forbidden', 403);
    }
    if (!existsSync(filePath)) return c.notFound();
    const ext = extname(filePath);
    const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
    const content = readFileSync(filePath);
    c.header('Content-Type', mime);
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    return c.body(content);
  });

  // SPA fallback: serve index.html for non-API, non-asset routes
  app.get('*', (c) => {
    if (c.req.path.startsWith('/api')) return c.notFound();
    if (!existsSync(indexPath)) {
      return c.text('Frontend not built. Run: npm run build', 404);
    }
    const content = readFileSync(indexPath, 'utf-8');
    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.body(content);
  });

  return app;
}
