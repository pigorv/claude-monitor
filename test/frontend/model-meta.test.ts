import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  modelClass,
  modelLabel,
  isLargeContext,
  modelVersion,
  isOneMSonnet,
  modelLabelFull,
} from '../../frontend/src/lib/model-meta.js';
import { resolveThresholds } from '../../frontend/src/lib/chart-config.js';

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

describe('modelVersion', () => {
  it('reads "4.6" from a sonnet model', () => {
    assert.equal(modelVersion('claude-sonnet-4-6'), '4.6');
  });

  it('reads "4.8" from an opus model', () => {
    assert.equal(modelVersion('claude-opus-4-8'), '4.8');
  });

  it('reads a major-only "5" from a fable model', () => {
    assert.equal(modelVersion('claude-fable-5'), '5');
  });

  it('ignores a trailing release date', () => {
    assert.equal(modelVersion('claude-haiku-4-5-20251001'), '4.5');
  });

  it('ignores a "[1m]" marker', () => {
    assert.equal(modelVersion('claude-sonnet-4-6[1m]'), '4.6');
  });

  it('returns null for a legacy id whose numbers precede the family', () => {
    assert.equal(modelVersion('claude-3-5-haiku'), null);
  });

  it('returns null for a legacy id where a date follows the family', () => {
    // family directly followed by a release date, no version — must not read
    // the date ("20241022") as the version
    assert.equal(modelVersion('claude-3-5-sonnet-20241022'), null);
  });

  it('returns null for null', () => {
    assert.equal(modelVersion(null), null);
  });

  it('returns null for an empty string', () => {
    assert.equal(modelVersion(''), null);
  });
});

describe('isOneMSonnet', () => {
  it('is true for a 1M sonnet', () => {
    assert.equal(isOneMSonnet('claude-sonnet-4-6[1m]'), true);
  });

  it('is false for a plain sonnet', () => {
    assert.equal(isOneMSonnet('claude-sonnet-4-6'), false);
  });

  it('is false for opus', () => {
    assert.equal(isOneMSonnet('claude-opus-4-8'), false);
  });

  it('is false for fable', () => {
    assert.equal(isOneMSonnet('claude-fable-5'), false);
  });

  it('is false for a [1m] non-sonnet (the family check, not just the marker)', () => {
    assert.equal(isOneMSonnet('claude-opus-4-8[1m]'), false);
  });

  it('is true for the default-1M claude-sonnet-5 (Behavior #8)', () => {
    assert.equal(isOneMSonnet('claude-sonnet-5'), true);
  });

  it('is false for null', () => {
    assert.equal(isOneMSonnet(null), false);
  });
});

describe('modelLabelFull', () => {
  it('composes family and version ("Sonnet 4.6")', () => {
    assert.equal(modelLabelFull('claude-sonnet-4-6'), 'Sonnet 4.6');
  });

  it('composes "Opus 4.8"', () => {
    assert.equal(modelLabelFull('claude-opus-4-8'), 'Opus 4.8');
  });

  it('composes "Fable 5"', () => {
    assert.equal(modelLabelFull('claude-fable-5'), 'Fable 5');
  });

  it('falls back to family-only when there is no version', () => {
    assert.equal(modelLabelFull('claude-3-5-haiku'), 'Haiku');
  });

  it('returns the nullLabel verbatim for null', () => {
    assert.equal(modelLabelFull(null, 'Unknown'), 'Unknown');
  });

  it('composes "Sonnet 5" for claude-sonnet-5 (Behavior #8)', () => {
    assert.equal(modelLabelFull('claude-sonnet-5'), 'Sonnet 5');
  });

  it('defaults null to the "—" empty-state label', () => {
    assert.equal(modelLabelFull(null), '—');
  });
});

// ── resolveThresholds (frontend chart profile) ─────────────────────

describe('resolveThresholds', () => {
  it('uses the 1M compaction profile for the default-1M claude-sonnet-5 (Behavior #5)', () => {
    const t = resolveThresholds('claude-sonnet-5');
    assert.equal(t.model, 'sonnet');
    assert.equal(t.autoCompactPct, 96.7);
    assert.equal(t.warningPct, 60.0);
    assert.equal(t.dangerPct, 70.0);
    assert.equal(t.maxTokens, 1_000_000);
  });
});
