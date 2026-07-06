import { Hono } from 'hono';
import { buildSessionBundle, SessionExportError } from '../../export/session-bundle.js';

const sessionExport = new Hono();

// GET /api/sessions/:id/export → importable zip bundle for one session.
// Sanitized by default (the ONE shared sanitizer layer in buildSessionBundle,
// the same code path the CLI uses); `?sanitize=false` opts into a raw bundle
// with real filesystem paths and message content.
// Only the known actionable errors from
// buildSessionBundle (unknown session / null transcript_path / missing file)
// become a 404 carrying the error's actionable message. Anything unexpected is
// re-thrown so the app's global onError reports a real 500 instead of a
// misleading "not found".
sessionExport.get('/api/sessions/:id/export', async (c) => {
  const id = c.req.param('id');

  // Sanitized by default. Only the exact query value `sanitize=false` opts out
  // into a raw bundle; any other value (or no param) keeps the safe default.
  const sanitize = c.req.query('sanitize') !== 'false';

  let bundle;
  try {
    bundle = await buildSessionBundle(id, { sanitize });
  } catch (err) {
    if (err instanceof SessionExportError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }

  const { zip, filename } = bundle;

  c.header('Content-Type', 'application/zip');
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  c.header('Content-Length', String(zip.length));

  // Return the raw zip bytes unchanged. buildSessionBundle hands back a Node
  // `Buffer` (typed `Uint8Array<ArrayBufferLike>`); copy it into a plain
  // `Uint8Array<ArrayBuffer>` so Hono's `c.body` accepts it and the binary
  // payload is sent byte-for-byte.
  return c.body(Uint8Array.from(zip));
});

export { sessionExport };
