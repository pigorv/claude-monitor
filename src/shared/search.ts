/**
 * Snippet match markers for Session List message-content search (issue #67).
 *
 * getMessageMatchesForSessions asks SQLite's FTS5 `snippet()` to wrap matched
 * tokens in these two control characters; the frontend splits the snippet on
 * them to render `<mark>` highlights. Using control chars (rather than `<b>` or
 * similar) keeps the payload free of HTML, so message text is always rendered
 * as inert text nodes — no injection risk even if a message contains markup.
 *
 * Browser-safe: this module has no Node-only imports, so the frontend can
 * import it directly.
 */
export const SNIPPET_MARK_START = String.fromCharCode(1); // U+0001
export const SNIPPET_MARK_END = String.fromCharCode(2); // U+0002
