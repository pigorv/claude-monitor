import { Hono } from 'hono';
import { buildSessionBundle, SessionExportError } from '../../export/session-bundle.js';

const sessionExport = new Hono();

// GET /api/sessions/:id/export → sanitized, importable zip bundle for one
// session. Goes through the ONE shared sanitizer layer (buildSessionBundle),
// the same code path the CLI uses. Only the known actionable errors from
// buildSessionBundle (unknown session / null transcript_path / missing file)
// become a 404 carrying the error's actionable message. Anything unexpected is
// re-thrown so the app's global onError reports a real 500 instead of a
// misleading "not found".
sessionExport.get('/api/sessions/:id/export', async (c) => {
  const id = c.req.param('id');

  let bundle;
  try {
    bundle = await buildSessionBundle(id);
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
