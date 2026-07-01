import { html } from "htm/preact";
import type { Event } from "../../../src/shared/types";

interface CompactionBannerProps {
  event: Event;
}

export function CompactionBanner({ event }: CompactionBannerProps) {
  return html`
    <div class="compaction-banner-standalone">
      <span class="compaction-banner-icon">\u26A0</span>
      <div class="compaction-banner-info">
        <div class="compaction-banner-title">Auto-compaction triggered</div>
        <div class="compaction-banner-desc">
          Context pressure exceeded ${event.context_pct != null ? Math.round(event.context_pct) : "75"}% threshold
        </div>
      </div>
    </div>
  `;
}
