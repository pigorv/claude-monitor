import { html } from "htm/preact";
import type { RiskLevel } from "../../../src/shared/types";

interface RiskBadgeProps {
  level: RiskLevel | string;
  score?: number;
}

export function RiskBadge({ level, score }: RiskBadgeProps) {
  return html`<span class="risk-pill ${level}">${
    score != null ? score.toFixed(2) : level
  }</span>`;
}
