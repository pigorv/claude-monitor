import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import render from 'preact-render-to-string';
import { html } from 'htm/preact';
import { renderSnippet } from '../../frontend/src/pages/SessionList.js';
import { SNIPPET_MARK_START as S, SNIPPET_MARK_END as E } from '../../src/shared/search.js';

describe('renderSnippet', () => {
  it('wraps marked runs in <mark> and leaves surrounding text plain', () => {
    const out = render(html`<div>${renderSnippet(`before ${S}match${E} after`)}</div>`);
    assert.ok(out.includes('before '), 'leading text preserved');
    assert.ok(out.includes(' after'), 'trailing text preserved');
    assert.ok(out.includes('<mark class="srow-hl">match</mark>'), 'matched run wrapped in <mark>');
  });

  it('handles multiple marked runs', () => {
    const out = render(html`<div>${renderSnippet(`${S}a${E} mid ${S}b${E}`)}</div>`);
    assert.ok(out.includes('<mark class="srow-hl">a</mark>'), 'first mark');
    assert.ok(out.includes('<mark class="srow-hl">b</mark>'), 'second mark');
    assert.ok(out.includes(' mid '), 'text between marks preserved');
  });

  it('never emits raw markup — message text is rendered as inert text', () => {
    const out = render(html`<div>${renderSnippet(`${S}<script>alert(1)</script>${E}`)}</div>`);
    assert.ok(!out.includes('<script>'), 'no live script tag');
    // Preact escapes the angle bracket that opens a tag (`<` → `&lt;`); a bare
    // `>` is left as-is (harmless in text). The escaped `<` is what matters.
    assert.ok(out.includes('&lt;script'), 'opening angle bracket is escaped');
    assert.ok(out.includes('<mark class="srow-hl">'), 'still highlighted');
  });

  it('emits no <mark> when there are no sentinels', () => {
    const out = render(html`<div>${renderSnippet('just plain text')}</div>`);
    assert.ok(!out.includes('<mark'), 'no highlight without sentinels');
    assert.ok(out.includes('just plain text'), 'text rendered');
  });
});
