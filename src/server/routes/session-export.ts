import { Hono } from 'hono';
import { buildSessionBundle } from '../../export/session-bundle.js';

const sessionExport = new Hono();

// GET /api/sessions/:id/export → sanitized, importable zip bundle for one
// session. Goes through the ONE shared sanitizer layer (buildSessionBundle),
// the same code path the CLI uses. The known actionable errors from
// buildSessionBundle (unknown session / null transcript_path / missing file)
// become a 404 carrying the error's actionable message — never a 500 stack.
sessionExport.get('/api/sessions/:id/export', async (c) => {
  const id = c.req.param('id');

  let bundle;
  try {
    bundle = await buildSessionBundle(id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 404);
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
