export type CtxLevel = 'safe' | 'warn' | 'danger';

/** Context-utilization band on the already window-normalized percentage.
 *  safe < 40 ≤ warn ≤ 65 < danger. */
export function ctxLevel(pct: number): CtxLevel {
  if (pct > 65) return 'danger';
  if (pct >= 40) return 'warn';
  return 'safe';
}
