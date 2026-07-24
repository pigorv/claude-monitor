import { Hono } from 'hono';
import { cloneSession, CloneError } from '../../clone/session-clone.js';

const sessionClone = new Hono();

// POST /api/sessions/:id/clone → clone one session's raw transcript into a
// chosen target directory under a fresh session id, returning the new
// session's `{ id, projectPath }`.
//
// The JSON body carries `{ targetDir }`, an absolute path to an EXISTING
// directory the clone should be rooted in. cloneSession validates it before
// touching disk and throws a CloneError for every known, user-actionable
// failure; the route maps that error's `code` to a distinct 4xx:
//   - unknown_session                     → 404 (no such session)
//   - transcript_missing / no_transcript_path → 410 (the raw transcript is gone;
//     cloning is tier-1-only)
//   - bad_target_dir                      → 400 (blank / relative / nonexistent
//     / not-a-dir targetDir)
// Anything unexpected is re-thrown so the app's global onError reports a real
// 500 instead of masquerading as a client mistake.
sessionClone.post('/api/sessions/:id/clone', async (c) => {
  const id = c.req.param('id');

  // A malformed / absent JSON body is a client mistake (bad targetDir), so
  // treat a parse failure as an empty body and let cloneSession reject the
  // missing targetDir with its actionable 400 message.
  let body: { targetDir?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const targetDir = typeof body?.targetDir === 'string' ? body.targetDir : '';

  let result;
  try {
    result = await cloneSession(id, { targetDir });
  } catch (err) {
    if (err instanceof CloneError) {
      const status =
        err.code === 'unknown_session'
          ? 404
          : err.code === 'transcript_missing' || err.code === 'no_transcript_path'
            ? 410
            : 400;
      return c.json({ error: err.message }, status);
    }
    throw err;
  }

  return c.json(result);
});

export { sessionClone };
