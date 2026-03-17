import { Hono } from 'hono';
import { listEventsBySession } from '../../db/queries/events.js';
import { sessionExists } from '../../db/queries/sessions.js';
import type { EventFilters } from '../../db/queries/events.js';

const events = new Hono();

events.get('/api/sessions/:id/events', (c) => {
  const sessionId = c.req.param('id');

  if (!sessionExists(sessionId)) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const q = c.req.query.bind(c.req);
  const filters: EventFilters = {};

  if (q('event_type')) filters.eventType = q('event_type');
  if (q('tool_name')) filters.toolName = q('tool_name');
  if (q('agent_id')) filters.agentId = q('agent_id');
  if (q('parent_only') === 'true') filters.parentOnly = true;
  if (q('include_thinking') === 'true') filters.includeThinking = true;
  if (q('limit')) {
    const v = parseInt(q('limit')!, 10);
    if (!isNaN(v) && v > 0) filters.limit = v;
  }
  if (q('offset')) {
    const v = parseInt(q('offset')!, 10);
    if (!isNaN(v) && v >= 0) filters.offset = v;
  }

  const { events: rows, total } = listEventsBySession(sessionId, filters);

  return c.json({
    events: rows,
    total,
    limit: filters.limit ?? 100,
    offset: filters.offset ?? 0,
  });
});

export { events };
