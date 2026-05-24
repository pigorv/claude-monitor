import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { hasNonEmptySelection } from '../../frontend/src/lib/selection.js';

// Regression coverage for issue #47: EventCard.toggleExpand suppresses the
// click-toggle when the user has an active text selection. The DOM call
// `window.getSelection()?.toString()` is one trivial line in EventCard.tsx;
// the decision logic lives here and is what actually decides the bug.

describe('hasNonEmptySelection', () => {
  it('returns false for null', () => {
    assert.equal(hasNonEmptySelection(null), false);
  });

  it('returns false for undefined', () => {
    assert.equal(hasNonEmptySelection(undefined), false);
  });

  it('returns false for an empty string', () => {
    assert.equal(hasNonEmptySelection(''), false);
  });

  it('returns true for a single character', () => {
    assert.equal(hasNonEmptySelection('x'), true);
  });

  it('returns true for a multi-character word', () => {
    assert.equal(hasNonEmptySelection('hello'), true);
  });

  // The bug in #47 fires on any non-empty selection the user dragged, including
  // whitespace-only ranges. Encode that explicitly: a selection of " " still
  // suppresses the toggle.
  it('returns true for whitespace-only selection', () => {
    assert.equal(hasNonEmptySelection(' '), true);
  });
});
