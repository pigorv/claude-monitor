import { getDb } from '../db/connection.js';
import { insertSessionLink } from '../db/queries/sessions.js';
import * as logger from '../shared/logger.js';

const PLAN_PREFIX = 'Implement the following plan:';
const TIME_WINDOW_MINUTES = 5;

/**
 * Detect and link plan→implementation session pairs after import.
 *
 * Forward detection: if this session's first user message starts with
 * "Implement the following plan:", find the most recent session in the
 * same project that ended within 5 minutes before this session started.
 *
 * Reverse detection: check if any session starting within 5 minutes
 * after this session ended has a first user_message event starting
 * with the plan prefix.
 */
export function detectAndLinkSessions(
  sessionId: string,
  firstUserMessage: string | null,
  projectPath: string,
  startedAt: string,
  endedAt: string | null,
): void {
  // Forward: this session is the implementation
  if (firstUserMessage && firstUserMessage.trimStart().startsWith(PLAN_PREFIX)) {
    const planSessionId = findPlanningSession(sessionId, projectPath, startedAt);
    if (planSessionId) {
      insertSessionLink(planSessionId, sessionId, 'plan_implementation');
      logger.info('Linked planning session to implementation', {
        plan: planSessionId,
        implementation: sessionId,
      });
    }
  }

  // Reverse: this session might be the planning session
  if (endedAt) {
    const implSessionId = findImplementationSession(sessionId, projectPath, endedAt);
    if (implSessionId) {
      insertSessionLink(sessionId, implSessionId, 'plan_implementation');
      logger.info('Linked planning session to implementation (reverse)', {
        plan: sessionId,
        implementation: implSessionId,
      });
    }
  }
}

function findPlanningSession(
  currentSessionId: string,
  projectPath: string,
  startedAt: string,
): string | null {
  const db = getDb();
  // Use datetime() to normalize ISO timestamps for comparison.
  // Allow ended_at up to 1 minute AFTER startedAt to handle plan-mode overlap
  // where the planning session's final message arrives after implementation begins.
  const row = db.prepare(`
    SELECT id FROM sessions
    WHERE project_path = ?
      AND id != ?
      AND ended_at IS NOT NULL
      AND datetime(ended_at) >= datetime(?, '-${TIME_WINDOW_MINUTES} minutes')
      AND datetime(ended_at) <= datetime(?, '+1 minutes')
    ORDER BY datetime(ended_at) DESC
    LIMIT 1
  `).get(projectPath, currentSessionId, startedAt, startedAt) as { id: string } | undefined;

  return row?.id ?? null;
}

function findImplementationSession(
  currentSessionId: string,
  projectPath: string,
  endedAt: string,
): string | null {
  const db = getDb();
  // Use datetime() to normalize ISO timestamps for comparison.
  const row = db.prepare(`
    SELECT s.id FROM sessions s
    JOIN events e ON e.session_id = s.id
    WHERE s.project_path = ?
      AND s.id != ?
      AND datetime(s.started_at) >= datetime(?)
      AND datetime(s.started_at) <= datetime(?, '+${TIME_WINDOW_MINUTES} minutes')
      AND e.event_type = 'user_message'
      AND e.input_preview LIKE ?
    ORDER BY e.sequence_num ASC
    LIMIT 1
  `).get(
    projectPath,
    currentSessionId,
    endedAt,
    endedAt,
    `${PLAN_PREFIX}%`,
  ) as { id: string } | undefined;

  return row?.id ?? null;
}
