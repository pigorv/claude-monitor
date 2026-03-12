/**
 * Simple line-level diff using LCS (Longest Common Subsequence).
 * No dependencies.
 */

export interface DiffLine {
  type: 'add' | 'remove' | 'unchanged';
  text: string;
}

const MAX_LINES = 500;

/**
 * Compute a line-level diff between two strings.
 * Returns an array of DiffLine objects suitable for rendering.
 */
export function computeLineDiff(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  // Cap for performance
  if (oldLines.length > MAX_LINES || newLines.length > MAX_LINES) {
    return [
      ...oldLines.slice(0, MAX_LINES).map((text): DiffLine => ({ type: 'remove', text })),
      { type: 'unchanged', text: `... (diff truncated, ${oldLines.length + newLines.length} total lines)` },
      ...newLines.slice(0, MAX_LINES).map((text): DiffLine => ({ type: 'add', text })),
    ];
  }

  const lcs = computeLCS(oldLines, newLines);
  const result: DiffLine[] = [];

  let oi = 0;
  let ni = 0;

  for (const common of lcs) {
    // Lines removed before this common line
    while (oi < common.oldIdx) {
      result.push({ type: 'remove', text: oldLines[oi] });
      oi++;
    }
    // Lines added before this common line
    while (ni < common.newIdx) {
      result.push({ type: 'add', text: newLines[ni] });
      ni++;
    }
    // Common line
    result.push({ type: 'unchanged', text: oldLines[oi] });
    oi++;
    ni++;
  }

  // Remaining lines after last common
  while (oi < oldLines.length) {
    result.push({ type: 'remove', text: oldLines[oi] });
    oi++;
  }
  while (ni < newLines.length) {
    result.push({ type: 'add', text: newLines[ni] });
    ni++;
  }

  return result;
}

interface LCSMatch {
  oldIdx: number;
  newIdx: number;
}

function computeLCS(oldLines: string[], newLines: string[]): LCSMatch[] {
  const m = oldLines.length;
  const n = newLines.length;

  // DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find the actual LCS
  const result: LCSMatch[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      result.push({ oldIdx: i - 1, newIdx: j - 1 });
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return result.reverse();
}
