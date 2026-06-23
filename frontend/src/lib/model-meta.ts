import { MODEL_THRESHOLDS } from "../../../src/shared/model-thresholds";
import { contextWindowFor } from "../../../src/shared/cost";

// Display labels per MODEL_THRESHOLDS key.
const MODEL_LABELS: Record<string, string> = {
  fable: "Fable",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
};

/** The MODEL_THRESHOLDS key a model string belongs to, or null if unknown. */
function modelKey(model: string | null | undefined): string | null {
  if (!model) return null;
  const lower = model.toLowerCase();
  for (const key of Object.keys(MODEL_THRESHOLDS)) {
    if (lower.includes(key)) return key;
  }
  return null;
}

/** CSS class suffix for `.model-pill.<class>`. "" when unknown/null. */
export function modelClass(model: string | null | undefined): string {
  return modelKey(model) ?? "";
}

/**
 * Human label ("Fable"/"Opus"/…). For an unrecognized but present string,
 * returns the raw string. For null/empty, returns `nullLabel`.
 * `nullLabel` preserves each call site's existing empty-state text.
 */
export function modelLabel(
  model: string | null | undefined,
  nullLabel = "—",
): string {
  const key = modelKey(model);
  if (key) return MODEL_LABELS[key] ?? key;
  return model ? model : nullLabel;
}

/** True when the model's context window is ≥1M (drives the "1M" badge). */
export function isLargeContext(model: string | null | undefined): boolean {
  const window = contextWindowFor(model);
  return window != null && window >= 1_000_000;
}

/**
 * Version suffix following the family token ("4.6", "4.8", "5"), or null when
 * no version follows the family (e.g. legacy "claude-3-5-haiku") or null/empty.
 * A trailing release date (e.g. "-20251001") and a "[1m]" marker are ignored.
 * Legacy ids where the family is followed directly by a date instead of a
 * version (e.g. "claude-3-5-sonnet-20241022") also return null — a major above
 * 99 is a date, not a version.
 */
export function modelVersion(model: string | null | undefined): string | null {
  const key = modelKey(model);
  if (!key || !model) return null;
  const lower = model.toLowerCase();
  const idx = lower.indexOf(key);
  const rest = lower.slice(idx + key.length);
  const match = /^-(\d+)(?:-(\d+))?/.exec(rest);
  if (!match) return null;
  if (Number(match[1]) > 99) return null;
  return match[2] != null ? `${match[1]}.${match[2]}` : match[1];
}

/** True when the model is a Sonnet running with a 1M context window. */
export function isOneMSonnet(model: string | null | undefined): boolean {
  return modelKey(model) === "sonnet" && isLargeContext(model);
}

/**
 * Family + version label ("Sonnet 4.6"). Family-only when no version follows
 * (e.g. "Haiku"). Returns `nullLabel` verbatim when model is null/empty.
 */
export function modelLabelFull(
  model: string | null | undefined,
  nullLabel = "—",
): string {
  const label = modelLabel(model, nullLabel);
  const version = modelVersion(model);
  return `${label}${version ? ` ${version}` : ""}`;
}
