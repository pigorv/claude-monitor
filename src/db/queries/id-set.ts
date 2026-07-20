// Shared helpers for id-set (WHERE id IN (...)) queries.

// The measured better-sqlite3 / SQLite 3.53.1 bound-parameter ceiling.
export const SQLITE_MAX_IN_PARAMS = 32766;

// Build a `?,?,…` placeholder string of the given length.
export function idPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

// Split an id list into batches of at most `size` items. Returns `[]` for an empty input.
export function chunkIds<T>(ids: T[], size = SQLITE_MAX_IN_PARAMS): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}
