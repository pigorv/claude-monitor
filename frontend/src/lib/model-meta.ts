import { MODEL_THRESHOLDS } from "../../../src/shared/model-thresholds";

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
  const key = modelKey(model);
  return key ? MODEL_THRESHOLDS[key].maxTokens >= 1_000_000 : false;
}
