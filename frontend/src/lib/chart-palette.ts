/** Canvas-only color constants. The ONE place raw hex is allowed outside
 *  globals.css primitives, because <canvas> cannot read CSS var(). Keep values
 *  in sync with the ramps in globals.css. */
export const CHART = {
  // semantic accents used in tooltips / markers
  purple: '#534AB7',   // var(--purple-600)
  teal: '#1D9E75',     // var(--teal-400)
  grayMid: '#888780',  // var(--gray-400)
  grayLight: '#B4B2A9',// var(--gray-200)
  white: '#fffffe',
  // ctx threshold readout (teal/amber/red @ 40/65) — text-weight values
  ctxSafe: '#085041',  // var(--teal-800)
  ctxWarn: '#633806',  // var(--amber-800)
  ctxDanger: '#A32D2D',// var(--red-600)
  // threshold zone bands — rgba variants for fills/strokes
  amberZoneFill: 'rgba(161, 98, 7, 0.06)',    // warning-zone fill (#a16207 @ 6%)
  amberZoneStroke: 'rgba(161, 98, 7, 0.25)',  // warning-zone dashed line (#a16207 @ 25%)
  amberZoneLabel: 'rgba(161, 98, 7, 0.5)',    // warning-zone % label (#a16207 @ 50%)
  redZoneFill: 'rgba(163, 45, 45, 0.04)',     // danger-zone fill (red-600 @ 4%)
  redZoneStroke: 'rgba(163, 45, 45, 0.2)',    // danger-zone dashed line (red-600 @ 20%)
  redZoneLabel: 'rgba(163, 45, 45, 0.45)',    // danger-zone % label (red-600 @ 45%)
  redCompaction: 'rgba(163, 45, 45, 0.5)',    // compaction marker line (red-600 @ 50%)
  // legend swatch fills/strokes (mirror canvas zones at legend-specific alphas)
  amberLegendFill: 'rgba(161, 98, 7, 0.15)',   // warning legend dot fill (#a16207 @ 15%)
  amberLegendStroke: 'rgba(161, 98, 7, 0.3)',  // warning legend dot border (#a16207 @ 30%)
  redLegendFill: 'rgba(163, 45, 45, 0.1)',     // danger legend dot fill (red-600 @ 10%)
  redLegendStroke: 'rgba(163, 45, 45, 0.25)',  // danger legend dot border (red-600 @ 25%)
  // context % series (purple gradient fill — mirrors the purple-600 line stroke)
  purpleGradFill0: 'rgba(83, 74, 183, 0.08)',  // fallback / static fill (purple-600 @ 8%)
  purpleGradStop0: 'rgba(83, 74, 183, 0.18)',  // gradient top stop (purple-600 @ 18%)
  purpleGradStop1: 'rgba(83, 74, 183, 0.02)',  // gradient bottom stop (purple-600 @ 2%)
  // cache-read series (mirrors the teal-400 legend swatch)
  tealSeriesStroke: 'rgba(29, 158, 117, 0.4)', // cache-read line stroke (teal-400 @ 40%)
  tealSeriesFill: 'rgba(29, 158, 117, 0.08)',  // cache-read area fill (teal-400 @ 8%)
  tealCursorFill: 'rgba(29,158,117,0.6)',       // cursor hover fill point (teal-400 @ 60%)
  // grid
  gridStroke: 'rgba(232, 228, 223, 0.6)',       // Y-axis grid lines (warm gray)
} as const;
