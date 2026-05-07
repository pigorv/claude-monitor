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
  '.webmanifest': 'application/manifest+json',
};

// Files that Vite copies from frontend/public/ to the build root and that
// browsers request at top-level paths (favicons, manifests, etc.).
const ROOT_STATIC_FILES = new Set([
  '/favicon.svg',
  '/favicon-16.png',
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/safari-pinned-tab.svg',
  '/site.webmanifest',
]);

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

  // Root-level static files (favicons, web manifest). Vite copies these from
  // frontend/public/ verbatim; without this handler they would fall through to
  // the SPA fallback below and be served as index.html.
  for (const path of ROOT_STATIC_FILES) {
    app.get(path, (c) => {
      const filePath = join(frontendDir, path);
      if (!existsSync(filePath)) return c.notFound();
      const ext = extname(filePath);
      const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
      const content = readFileSync(filePath);
      c.header('Content-Type', mime);
      c.header('Cache-Control', 'public, max-age=86400');
      return c.body(content);
    });
  }

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
