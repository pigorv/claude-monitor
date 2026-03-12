export function formatTokenCount(n: number | null | undefined): string | null {
  if (n == null || n < 100) return null;

  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    const s = v.toFixed(1);
    return (s.endsWith(".0") ? s.slice(0, -2) : s) + "M";
  }

  if (n >= 1_000) {
    const v = n / 1_000;
    const s = v.toFixed(1);
    return (s.endsWith(".0") ? s.slice(0, -2) : s) + "K";
  }

  return String(n);
}

export function formatTokenMeta(
  input: number | null,
  output: number | null,
  cache: number | null
): string {
  const parts: string[] = [];

  const inStr = formatTokenCount(input);
  if (inStr != null) parts.push(`in: ${inStr}`);

  const outStr = formatTokenCount(output);
  if (outStr != null) parts.push(`out: ${outStr}`);

  const cacheStr = formatTokenCount(cache);
  if (cacheStr != null) parts.push(`cache: ${cacheStr}`);

  return parts.join(" \u00B7 ");
}
