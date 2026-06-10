import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { modelClass, modelLabel, isLargeContext } from '../../frontend/src/lib/model-meta.js';

describe('modelLabel', () => {
  it('labels a fable model "Fable"', () => {
    assert.equal(modelLabel('claude-fable-5'), 'Fable');
  });

  it('defaults null to the "—" empty-state label', () => {
    assert.equal(modelLabel(null), '—');
  });

  it('uses SessionDetail\'s "Unknown" null fallback when passed', () => {
    assert.equal(modelLabel(null, 'Unknown'), 'Unknown');
  });

  it('uses TokenChart\'s "unknown" null fallback when passed', () => {
    assert.equal(modelLabel(null, 'unknown'), 'unknown');
  });

  it('passes an unrecognized but present string through unchanged', () => {
    assert.equal(modelLabel('some-random-model'), 'some-random-model');
  });
});

describe('modelClass', () => {
  it('maps a fable model to the "fable" pill class', () => {
    assert.equal(modelClass('claude-fable-5'), 'fable');
  });

  it('returns "" for an unknown string', () => {
    assert.equal(modelClass('some-random-model'), '');
  });
});

describe('isLargeContext', () => {
  it('is true for fable (1M context)', () => {
    assert.equal(isLargeContext('claude-fable-5'), true);
  });

  it('is true for opus (1M context)', () => {
    assert.equal(isLargeContext('claude-opus-4-6'), true);
  });

  it('is false for sonnet (200K context)', () => {
    assert.equal(isLargeContext('claude-sonnet-4-6'), false);
  });

  it('is false for an unknown string', () => {
    assert.equal(isLargeContext('some-random-model'), false);
  });
});
