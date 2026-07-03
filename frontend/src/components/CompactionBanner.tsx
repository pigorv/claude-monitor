import { html } from "htm/preact";
import type { Event } from "../../../src/shared/types";

interface CompactionBannerProps {
  event: Event;
}

/**
 * Human-readable description for a compaction event. The event row's own
 * context_pct/token columns are post-drop values (the re-typed turn is the
 * low-context message after compaction), so the pre-drop pressure comes from
 * the metadata the importer persisted at import time. Rows imported before
 * that metadata existed fall back to a neutral line.
 */
export function compactionDescription(event: Event): string {
  if (event.metadata) {
    try {
      const meta = JSON.parse(event.metadata);
      const pct = meta?.compaction?.context_pct_before;
      if (typeof pct === "number" && Number.isFinite(pct)) {
        return `Context pressure reached ${Math.round(pct)}% before compaction`;
      }
    } catch {
      // corrupt metadata — fall through to the neutral line
    }
  }
  return "Context window compacted to free up space";
}

export function CompactionBanner({ event }: CompactionBannerProps) {
  return html`
    <div class="compaction-banner-standalone">
      <span class="compaction-banner-icon">⚠</span>
      <div class="compaction-banner-info">
        <div class="compaction-banner-title">Auto-compaction triggered</div>
        <div class="compaction-banner-desc">
          ${compactionDescription(event)}
        </div>
      </div>
    </div>
  `;
}
