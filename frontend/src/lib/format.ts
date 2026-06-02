export function projectColor(name: string): string {
  // Distinct hues used purely to visually disambiguate projects in DOM dots/swatches.
  const colors = [
    "var(--color-accent)", "var(--color-status-completed)", "var(--color-tool-read-text)",
    "var(--color-status-warning-text)", "var(--color-tool-write-text)", "var(--color-status-danger-text)",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return colors[Math.abs(hash) % colors.length];
}

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
