import { html } from "htm/preact";
import type { Event } from "../../../src/shared/types";

interface CompactionBannerProps {
  event: Event;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
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
      ${event.input_tokens != null && html`
        <div class="compaction-banner-tokens">
          <div class="compaction-before">${formatTokens(event.input_tokens)} tokens</div>
          ${event.output_tokens != null && html`
            <div class="compaction-after">${formatTokens(event.output_tokens)} tokens</div>
          `}
        </div>
      `}
    </div>
  `;
}
