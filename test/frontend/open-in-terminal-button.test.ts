import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import render from 'preact-render-to-string';
import { html } from 'htm/preact';
import { OpenInTerminalButton } from '../../frontend/src/components/OpenInTerminalButton.js';

// SSR-only coverage (this repo has no jsdom). The async click handler sets the
// `error` state on a failed open; the `defaultError` seam pre-seeds that same
// state so we can assert the inline alert renders without driving handlers —
// the pattern CloneButton uses with `defaultError`.

describe('OpenInTerminalButton', () => {
  const PROJECT = '/Users/me/proj';

  it('renders the button and no inline error by default', () => {
    const out = render(html`<${OpenInTerminalButton} sessionId=${'sess-1'} projectPath=${PROJECT} />`);
    assert.ok(out.includes('Open in Terminal'), 'button label should render');
    assert.ok(!out.includes('terminal-error'), 'no inline error element when there is no error');
    assert.ok(!out.includes('role="alert"'), 'no alert region when there is no error');
  });

  it('surfaces a failed open inline as an ARIA alert next to the button', () => {
    const msg =
      'macOS blocked claude-monitor from controlling iTerm. Open System Settings to enable it, then try again.';
    const out = render(
      html`<${OpenInTerminalButton} sessionId=${'sess-1'} projectPath=${PROJECT} defaultError=${msg} />`,
    );
    assert.ok(out.includes('terminal-error'), 'inline error element should render');
    assert.ok(out.includes('role="alert"'), 'error should be an ARIA alert region');
    assert.ok(out.includes('System Settings to enable it'), 'the actionable message text should render');
  });
});
