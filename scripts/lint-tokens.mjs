import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HEX = /#[0-9a-fA-F]{3,8}\b|\brgba?\(/;
const PRIMITIVE = /var\(--(?:purple|teal|amber|red|gray|blue|green)-\d{2,3}\)/;
const LEGACY = /var\(--(?:accent(?:-light|-border|-tint)?|text\d?|text-inv|bg(?:-card|-muted|-hover|-active)?|border(?:-hover|-accent)?|green|yellow|orange|red|blue|teal|purple)(?:-(?:bg|border|tint))?\)|var\(--(?:r|r-sm|r-xs|r-pill|mono|sans)\)/;
const LEGACY_DEF = /(^|\s)--(?:accent(?:-light|-border|-tint)?|text\d?|text-inv|bg(?:-card|-muted|-hover|-active)?|border(?:-hover|-accent)?|green|yellow|orange|red|blue|teal|purple)(?:-(?:bg|border|tint))?\s*:|(^|\s)--(?:r|r-sm|r-xs|r-pill|mono|sans)\s*:/;

function isAllowlisted(path) { return path.replace(/\\/g, '/').endsWith('frontend/src/lib/chart-palette.ts'); }
function isGlobals(path) { return path.replace(/\\/g, '/').endsWith('frontend/src/styles/globals.css'); }
function stripHealth(line) { return line.replace(/var\(--health-[a-z]+\)/g, ''); }

/** Returns an array of { line, snippet, rule } violations for one file's content. */
export function lintContent(path, content) {
  if (isAllowlisted(path)) return [];
  const p = path.replace(/\\/g, '/');
  const isCss = p.endsWith('.css');
  const isTsx = p.endsWith('.tsx') || p.endsWith('.ts');
  const out = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripHealth(raw);
    if (isGlobals(p)) {
      if (LEGACY_DEF.test(line) || LEGACY.test(line)) out.push({ line: i + 1, snippet: raw.trim(), rule: 'legacy-token' });
      continue; // hex + primitives are allowed in globals
    }
    if (isCss) {
      if (HEX.test(line)) out.push({ line: i + 1, snippet: raw.trim(), rule: 'raw-hex' });
      if (PRIMITIVE.test(line)) out.push({ line: i + 1, snippet: raw.trim(), rule: 'primitive-ref' });
      if (LEGACY.test(line)) out.push({ line: i + 1, snippet: raw.trim(), rule: 'legacy-token' });
    } else if (isTsx) {
      const styleBearing = /style\s*=|\b(?:background|color|fill|stroke)\b|var\(--/.test(line);
      const RGB = /\brgba?\(/;
      const HEXLIT = /#[0-9a-fA-F]{3,8}\b/;
      // A hex literal counts when it's on a style-bearing line (e.g. `style="color:#fff"`)
      // OR when it's a quoted string literal anywhere (`return "#abc"`, `const c = "#abc"`).
      // Comments (`// #abc`, no surrounding quote) are intentionally left alone.
      const QUOTED_HEX = /["'`]#[0-9a-fA-F]{3,8}\b/;
      if (RGB.test(line)) out.push({ line: i + 1, snippet: raw.trim(), rule: 'raw-hex' });
      else if (HEXLIT.test(line) && (styleBearing || QUOTED_HEX.test(line))) out.push({ line: i + 1, snippet: raw.trim(), rule: 'raw-hex' });
      if (PRIMITIVE.test(line)) out.push({ line: i + 1, snippet: raw.trim(), rule: 'primitive-ref' });
      if (LEGACY.test(line)) out.push({ line: i + 1, snippet: raw.trim(), rule: 'legacy-token' });
    }
  }
  return out;
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) { if (e !== 'node_modules' && e !== 'dist') walk(full, acc); }
    else if (/\.(css|tsx|ts)$/.test(e)) acc.push(full);
  }
  return acc;
}

// CLI: scan frontend/src, exit non-zero on any violation.
if (import.meta.url === `file://${process.argv[1]}`) {
  const files = walk('frontend/src');
  let total = 0;
  for (const f of files) {
    const violations = lintContent(f, readFileSync(f, 'utf8'));
    for (const v of violations) { console.log(`${f}:${v.line}: [${v.rule}] ${v.snippet}`); total++; }
  }
  if (total) { console.error(`\n✖ ${total} token violation(s).`); process.exit(1); }
  console.log('✓ tokens clean'); process.exit(0);
}
