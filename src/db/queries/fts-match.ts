/**
 * Build an FTS5 MATCH expression from free-form Session List search text.
 *
 * Match mode (issue #67): every whitespace-separated word must appear somewhere
 * in a message, in any order (implicit AND). The last word is treated as a
 * prefix so the debounced search box responds while you are still typing
 * ("git workt" already matches "git worktree"), staying consistent with the
 * substring behaviour of the metadata search.
 *
 * Each token is wrapped as an FTS5 string literal with embedded double-quotes
 * doubled, so arbitrary user input (punctuation, quotes, operators like `OR`,
 * `NEAR`) is matched literally and can never inject FTS query syntax.
 *
 * Returns `null` when there is nothing searchable (empty input, or input with
 * no letters/numbers such as `!!!`). Callers treat `null` as "skip content
 * search" and fall back to metadata-only matching.
 */
export function buildFtsMatch(input: string): string | null {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return null;

  const tokens = trimmed.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t));
  if (tokens.length === 0) return null;

  return tokens
    .map((t, i) => {
      const literal = '"' + t.replace(/"/g, '""') + '"';
      return i === tokens.length - 1 ? literal + '*' : literal;
    })
    .join(' ');
}
