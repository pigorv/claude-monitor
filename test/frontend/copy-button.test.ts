import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import render from 'preact-render-to-string';
import { html } from 'htm/preact';
import { CopyButton } from '../../frontend/src/components/CopyButton.js';

// SSR-only coverage: vitest runs in node-env with no DOM, so we can only
// exercise the initial "idle" render. The "copied" and "failed" branches
// require navigator.clipboard plus event-driven state transitions, which
// need jsdom — not in this repo today. The next person to add jsdom for
// any reason should come back and add a fireEvent.click test here.

describe('CopyButton', () => {
  it('renders the copy-btn class and clipboard title', () => {
    const out = render(html`<${CopyButton} text="hello" />`);
    assert.ok(out.includes('copy-btn'), 'copy-btn class should be present');
    assert.ok(out.includes('title="Copy to clipboard"'), 'tooltip should be present');
  });

  it('renders the default "Copy" label when none is provided', () => {
    const out = render(html`<${CopyButton} text="hello" />`);
    assert.ok(out.includes('Copy'), 'default label should be Copy');
  });

  it('uses the custom label when one is provided', () => {
    const out = render(html`<${CopyButton} text="hello" label="Copy command" />`);
    assert.ok(out.includes('Copy command'), 'custom label should render');
  });

  it('renders the clipboard SVG icon in the idle state', () => {
    const out = render(html`<${CopyButton} text="hello" />`);
    assert.ok(out.includes('<svg'), 'svg icon should be present');
    assert.ok(out.includes('viewBox="0 0 12 12"'), 'svg viewBox should match');
  });

  it('does not render "Copied!" or "Failed" in the initial render', () => {
    const out = render(html`<${CopyButton} text="hello" />`);
    assert.ok(!out.includes('Copied!'), 'no Copied! in idle state');
    assert.ok(!out.includes('Failed'), 'no Failed in idle state');
  });
});
