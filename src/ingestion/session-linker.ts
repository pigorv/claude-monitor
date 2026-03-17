import { getDb } from '../db/connection.js';
import { insertSessionLink } from '../db/queries/sessions.js';
import * as logger from '../shared/logger.js';

const PLAN_PREFIX = 'Implement the following plan:';

/**
 * Number of leading characters from the plan body to use for content
 * matching between ExitPlanMode events and implementation user messages.
 */
const CONTENT_MATCH_LENGTH = 200;

/**
 * Detect and link plan→implementation session pairs after import.
 *
 * Uses ExitPlanMode tool-call events for reliable content matching:
 * the plan text in ExitPlanMode's input_data.plan field is identical
 * to the text after "Implement the following plan:" in the implementation
 * session's first user message.
 *
 * Forward: this session starts with the plan prefix → find a session
 * with an ExitPlanMode whose plan text matches.
 *
 * Reverse: this session has an ExitPlanMode event → find a later session
 * whose first user message contains that plan text.
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
    const planBody = extractPlanBody(firstUserMessage);
    if (planBody) {
      const planSessionId = findPlanningSession(sessionId, projectPath, startedAt, planBody);
      if (planSessionId) {
        insertSessionLink(planSessionId, sessionId, 'plan_implementation');
        logger.info('Linked planning session to implementation', {
          plan: planSessionId,
          implementation: sessionId,
        });
      }
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

/**
 * Extract the plan body after the prefix, trimmed and truncated for matching.
 */
function extractPlanBody(message: string): string | null {
  const trimmed = message.trimStart();
  const body = trimmed.slice(PLAN_PREFIX.length).trim();
  if (body.length < 20) return null;
  return body.slice(0, CONTENT_MATCH_LENGTH);
}

/**
 * Escape special SQL LIKE characters (%, _) in a string.
 */
function escapeLike(s: string): string {
  return s.replace(/[%_]/g, (ch) => `\\${ch}`);
}

/**
 * Forward: find the planning session for an implementation session.
 *
 * Looks for a session in the same project that ended before this one
 * started and has an ExitPlanMode tool call whose plan text matches
 * the beginning of this session's plan body.
 */
function findPlanningSession(
  currentSessionId: string,
  projectPath: string,
  startedAt: string,
  planBody: string,
): string | null {
  const db = getDb();
  const matchFragment = escapeLike(planBody);

  // Find sessions with an ExitPlanMode event whose plan field matches
  const row = db.prepare(`
    SELECT s.id FROM sessions s
    JOIN events e ON e.session_id = s.id
    WHERE s.project_path = ?
      AND s.id != ?
      AND s.ended_at IS NOT NULL
      AND datetime(s.ended_at) <= datetime(?, '+1 minutes')
      AND e.tool_name = 'ExitPlanMode'
      AND json_extract(e.input_data, '$.plan') LIKE ? ESCAPE '\\'
    ORDER BY datetime(s.ended_at) DESC
    LIMIT 1
  `).get(
    projectPath,
    currentSessionId,
    startedAt,
    `${matchFragment}%`,
  ) as { id: string } | undefined;

  return row?.id ?? null;
}

/**
 * Reverse: find the implementation session for a planning session.
 *
 * Checks if this session has an ExitPlanMode event, extracts the plan
 * text, and finds a later session whose first user message starts with
 * "Implement the following plan:" followed by the same plan text.
 */
function findImplementationSession(
  currentSessionId: string,
  projectPath: string,
  endedAt: string,
): string | null {
  const db = getDb();

  // Get plan text from this session's ExitPlanMode event
  const exitEvent = db.prepare(`
    SELECT json_extract(input_data, '$.plan') as plan_text
    FROM events
    WHERE session_id = ?
      AND tool_name = 'ExitPlanMode'
      AND input_data IS NOT NULL
    ORDER BY sequence_num DESC
    LIMIT 1
  `).get(currentSessionId) as { plan_text: string | null } | undefined;

  if (!exitEvent?.plan_text) return null;

  const planBody = exitEvent.plan_text.trim().slice(0, CONTENT_MATCH_LENGTH);
  if (planBody.length < 20) return null;

  const matchFragment = escapeLike(planBody);

  // Find implementation sessions whose first user message contains the
  // plan prefix AND whose plan body matches this session's ExitPlanMode text.
  // Use input_data (full text) for matching since input_preview is truncated.
  const row = db.prepare(`
    SELECT s.id FROM sessions s
    JOIN events e ON e.session_id = s.id
    WHERE s.project_path = ?
      AND s.id != ?
      AND datetime(s.started_at) >= datetime(?, '-1 minutes')
      AND e.event_type = 'user_message'
      AND e.input_data LIKE ? ESCAPE '\\'
    ORDER BY datetime(s.started_at) ASC, e.sequence_num ASC
    LIMIT 1
  `).get(
    projectPath,
    currentSessionId,
    endedAt,
    `${PLAN_PREFIX}%${matchFragment}%`,
  ) as { id: string } | undefined;

  return row?.id ?? null;
}
