/** Canvas-only color constants. The ONE place raw hex is allowed outside
 *  globals.css primitives, because <canvas> cannot read CSS var(). Keep values
 *  in sync with the ramps in globals.css. */
export const CHART = {
  // data-viz health ramp (mirrors --health-*)
  green: '#1f9d55', amber: '#f0a000', rose: '#e0457b', violet: '#8b5cf6',
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
  redZoneFill: 'rgba(185, 28, 28, 0.04)',     // danger-zone fill (#b91c1c @ 4%)
  redZoneStroke: 'rgba(185, 28, 28, 0.2)',    // danger-zone dashed line (#b91c1c @ 20%)
  redZoneLabel: 'rgba(185, 28, 28, 0.45)',    // danger-zone % label (#b91c1c @ 45%)
  redCompaction: 'rgba(185, 28, 28, 0.5)',    // compaction marker line (#b91c1c @ 50%)
  // legend swatch fills/strokes (mirror canvas zones at legend-specific alphas)
  amberLegendFill: 'rgba(161, 98, 7, 0.15)',   // warning legend dot fill (#a16207 @ 15%)
  amberLegendStroke: 'rgba(161, 98, 7, 0.3)',  // warning legend dot border (#a16207 @ 30%)
  redLegendFill: 'rgba(185, 28, 28, 0.1)',     // danger legend dot fill (#b91c1c @ 10%)
  redLegendStroke: 'rgba(185, 28, 28, 0.25)',  // danger legend dot border (#b91c1c @ 25%)
  // context % series (purple gradient fill)
  purpleGradFill0: 'rgba(109, 40, 217, 0.08)',  // fallback / static fill
  purpleGradStop0: 'rgba(109, 40, 217, 0.18)',  // gradient top stop
  purpleGradStop1: 'rgba(109, 40, 217, 0.02)',  // gradient bottom stop
  // cache-read series
  tealSeriesStroke: 'rgba(14, 116, 144, 0.4)', // cache-read line stroke
  tealSeriesFill: 'rgba(14, 116, 144, 0.08)',  // cache-read area fill
  tealCursorFill: 'rgba(29,158,117,0.6)',       // cursor hover fill point (teal-400 @ 60%)
  // grid
  gridStroke: 'rgba(232, 228, 223, 0.6)',       // Y-axis grid lines (warm gray)
} as const;
