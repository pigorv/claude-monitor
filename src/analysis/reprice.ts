import type Database from 'better-sqlite3';
import { sessionCostUsd } from '../shared/cost.js';

/** The session columns the cost reconstruction reads. */
export interface RepriceSessionRow {
  id: string;
  model: string | null;
  started_at: string | null;
  total_input_tokens_billed: number | null;
  total_cache_read_tokens: number | null;
  total_cache_write_tokens: number | null;
  total_cache_write_5m_tokens: number | null;
  total_cache_write_1h_tokens: number | null;
  total_output_tokens: number | null;
}

/** The agent_relationships columns the cost reconstruction reads. */
export interface RepriceAgentRow {
  model: string | null;
  input_tokens_total: number | null;
  output_tokens_total: number | null;
  cache_read_total: number | null;
  cache_write_5m_total: number | null;
  cache_write_1h_total: number | null;
}

/**
 * Recompute a session's cost from its already-stored aggregate token columns
 * (no JSONL re-parse), date-aware via the session's `started_at`. Pure function
 * over the row shapes — no db access. Returns null when no term resolves to a
 * known model (mirrors sessionCostUsd's unresolvable → null contract).
 *
 * Preserves backfillSessionCost's fidelity subtleties:
 *   - Undo the import-time agent-merge inflation of total_output_tokens: the
 *     parent is priced on parent-only output so sub-agent output isn't
 *     double-counted.
 *   - cacheWriteDefault is the residual after the 5m/1h split.
 */
export function recomputeSessionCostFromColumns(
  s: RepriceSessionRow,
  agentRows: RepriceAgentRow[],
): number | null {
  // Undo the import-time agent-merge inflation of total_output_tokens.
  const mergedAgentOutput = agentRows.reduce(
    (sum, a) => sum + (a.input_tokens_total != null ? a.output_tokens_total ?? 0 : 0),
    0,
  );
  const cacheWrite = s.total_cache_write_tokens ?? 0;
  const cw5m = s.total_cache_write_5m_tokens ?? 0;
  const cw1h = s.total_cache_write_1h_tokens ?? 0;
  const parentParts = {
    freshInput: s.total_input_tokens_billed ?? 0,
    cacheRead: s.total_cache_read_tokens ?? 0,
    cacheWrite5m: cw5m,
    cacheWrite1h: cw1h,
    cacheWriteDefault: Math.max(0, cacheWrite - cw5m - cw1h),
    output: Math.max(0, (s.total_output_tokens ?? 0) - mergedAgentOutput),
  };

  const agentParts = agentRows.map((a) => ({
    model: a.model ?? null,
    freshInput: a.input_tokens_total ?? 0,
    cacheRead: a.cache_read_total ?? 0,
    cacheWrite5m: a.cache_write_5m_total ?? 0,
    cacheWrite1h: a.cache_write_1h_total ?? 0,
    output: a.output_tokens_total ?? 0,
  }));

  return sessionCostUsd(s.model, parentParts, agentParts, s.started_at ?? undefined);
}

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

/**
 * Retroactively reprice EVERY existing session: recompute each session's cost
 * from its stored token columns (date-aware) and OVERWRITE cost_estimate_usd
 * unconditionally (no `IS NULL` guard — rewriting existing costs is the point).
 * Applies whatever discount rules are currently loaded; with no rules loaded the
 * recompute is list price, so this is a value-preserving no-op.
 *
 * Returns the number of rows updated (sessions whose recompute returned a
 * non-null cost). Skips (returns { repriced: 0 }) when the sessions aggregate
 * schema is incomplete — matching backfillSessionCost's defensive guards for the
 * minimal per-migration test fixtures.
 */
export function repriceAllSessions(db: Database.Database): { repriced: number } {
  const required = [
    'cost_estimate_usd',
    'model',
    'started_at',
    'total_input_tokens_billed',
    'total_cache_read_tokens',
    'total_cache_write_tokens',
    'total_cache_write_5m_tokens',
    'total_cache_write_1h_tokens',
    'total_output_tokens',
  ];
  if (!required.every((c) => tableHasColumn(db, 'sessions', c))) return { repriced: 0 };

  const sessions = db
    .prepare(
      `SELECT id, model, started_at, total_input_tokens_billed, total_cache_read_tokens,
              total_cache_write_tokens, total_cache_write_5m_tokens,
              total_cache_write_1h_tokens, total_output_tokens
       FROM sessions`,
    )
    .all() as RepriceSessionRow[];

  const agentStmt = tableExists(db, 'agent_relationships')
    ? db.prepare(
        `SELECT model, input_tokens_total, output_tokens_total, cache_read_total,
                cache_write_5m_total, cache_write_1h_total
         FROM agent_relationships
         WHERE parent_session_id = ?`,
      )
    : null;
  const update = db.prepare('UPDATE sessions SET cost_estimate_usd = ? WHERE id = ?');

  const run = db.transaction(() => {
    let repriced = 0;
    for (const s of sessions) {
      const agentRows = (agentStmt?.all(s.id) ?? []) as RepriceAgentRow[];
      const cost = recomputeSessionCostFromColumns(s, agentRows);
      if (cost !== null) {
        update.run(cost, s.id);
        repriced++;
      }
    }
    return repriced;
  });

  return { repriced: run() };
}
