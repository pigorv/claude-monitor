import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { lintContent } from '../../scripts/lint-tokens.mjs';

describe('lintContent', () => {
  it('flags raw hex in a component css file', () => {
    const v = lintContent('frontend/src/styles/session-list.css', '.x{color:#ff0000;}');
    assert.equal(v.length, 1);
  });
  it('flags a Tier-1 primitive ref in a component css file', () => {
    const v = lintContent('frontend/src/styles/pills.css', '.x{color:var(--purple-600);}');
    assert.equal(v.length, 1);
  });
  it('flags a legacy token in a component css file', () => {
    const v = lintContent('frontend/src/styles/pills.css', '.x{color:var(--accent);}');
    assert.equal(v.length, 1);
  });
  it('accepts a semantic token in a component css file', () => {
    const v = lintContent('frontend/src/styles/pills.css', '.x{color:var(--color-accent);}');
    assert.equal(v.length, 0);
  });
  it('allows hex and primitives in globals.css but flags legacy tokens', () => {
    assert.equal(lintContent('frontend/src/styles/globals.css', '--purple-600:#534AB7;').length, 0);
    assert.equal(lintContent('frontend/src/styles/globals.css', '--accent:#6d28d9;').length, 1);
  });
  it('allows --health- everywhere', () => {
    assert.equal(lintContent('frontend/src/styles/session-list.css', '.x{color:var(--health-amber);}').length, 0);
  });
  it('exempts chart-palette.ts entirely', () => {
    assert.equal(lintContent('frontend/src/lib/chart-palette.ts', 'const c="#6d28d9";').length, 0);
  });
  it('flags hex on a style-bearing line in tsx', () => {
    assert.equal(lintContent('frontend/src/components/X.tsx', 'html`<div style="color:#fff">`').length, 1);
  });
});
