import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import render from 'preact-render-to-string';
import { html } from 'htm/preact';
import { CloneButton } from '../../frontend/src/components/CloneButton.js';

// SSR-only coverage (this repo has no jsdom). We drive the modal open with the
// `defaultModalOpen` seam and pre-seed the error / success views with the
// `defaultError` / `defaultResult` seams — the same pattern ExportButton uses
// for `defaultModalOpen`. The interactive edit → submit → success transition
// (event handlers + async state) needs jsdom, which isn't wired here; the seams
// let us assert each rendered state without it.

describe('CloneButton', () => {
  const PROJECT = '/Users/me/proj';

  it('renders a header button labelled "Clone" and no modal when closed', () => {
    const out = render(html`<${CloneButton} sessionId=${'sess-1'} projectPath=${PROJECT} />`);
    assert.ok(out.includes('clone-btn-header'), 'should render the header button');
    assert.ok(out.includes('Clone'), 'header button is labelled "Clone"');
    assert.ok(!out.includes('role="dialog"'), 'modal should not render when closed');
  });

  it('disables the header button with a tooltip when disabled (Expired)', () => {
    const out = render(html`<${CloneButton} sessionId=${'sess-1'} projectPath=${PROJECT} disabled=${true} />`);
    assert.ok(out.includes('disabled'), 'button should be disabled');
    assert.ok(out.includes("Expired sessions can't be cloned"), 'should carry the disabled tooltip');
  });

  it('pre-fills the target-directory field with the recorded projectPath', () => {
    const out = render(html`<${CloneButton} sessionId=${'sess-1'} projectPath=${PROJECT} defaultModalOpen=${true} />`);
    assert.ok(out.includes('role="dialog"'), 'modal should render when defaultModalOpen');
    assert.ok(out.includes('clone-input'), 'should render the target-dir input');
    assert.ok(out.includes(`value="${PROJECT}"`), 'input should be pre-filled with projectPath');
  });

  it('offers a "Use recorded path" reset that is inert until the field is edited', () => {
    // Pristine state: dir === projectPath, so the reset control is disabled.
    const pristine = render(html`<${CloneButton} sessionId=${'sess-1'} projectPath=${PROJECT} defaultModalOpen=${true} />`);
    assert.ok(pristine.includes('Use recorded path'), 'reset control should render');
    const resetIdx = pristine.indexOf('clone-reset-btn');
    assert.ok(pristine.slice(resetIdx, resetIdx + 120).includes('disabled'), 'reset disabled when dir matches recorded path');

    // Edited state (seam simulates a user edit): the reset control is enabled so
    // clicking it restores the recorded path.
    const edited = render(html`<${CloneButton} sessionId=${'sess-1'} projectPath=${PROJECT} defaultModalOpen=${true} defaultDir=${'/somewhere/else'} />`);
    assert.ok(edited.includes('value="/somewhere/else"'), 'edited value shows in the field');
    const editedResetIdx = edited.indexOf('clone-reset-btn');
    assert.ok(!edited.slice(editedResetIdx, editedResetIdx + 120).includes('disabled'), 'reset enabled after an edit');
  });

  it('renders a server error inline while keeping the form (modal stays open)', () => {
    const out = render(html`
      <${CloneButton}
        sessionId=${'sess-1'}
        projectPath=${PROJECT}
        defaultModalOpen=${true}
        defaultError=${'Target directory does not exist: /nope'}
      />
    `);
    assert.ok(out.includes('clone-error'), 'inline error element should render');
    assert.ok(out.includes('Target directory does not exist: /nope'), 'error message should render');
    assert.ok(out.includes('clone-input'), 'form stays present — modal does not close on error');
  });

  it('shows the success view with the resume command for the new id', () => {
    const out = render(html`
      <${CloneButton}
        sessionId=${'sess-1'}
        projectPath=${PROJECT}
        defaultModalOpen=${true}
        defaultResult=${{ id: 'new-abc123', projectPath: '/cloned/dir' }}
      />
    `);
    assert.ok(out.includes('clone-success'), 'success view should render');
    assert.ok(out.includes('claude --resume new-abc123'), 'should show the resume command for the new id');
    assert.ok(out.includes('href="#/session/new-abc123"'), 'should link to the cloned session detail route');
    assert.ok(out.includes('copy-btn'), 'should render a CopyButton for the resume command');
    assert.ok(out.includes('Open in Terminal'), 'should render an Open in Terminal for the clone');
    assert.ok(!out.includes('clone-input'), 'the form should be replaced by the success view');
  });
});
