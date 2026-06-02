import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { ctxLevel } from '../../frontend/src/lib/ctx.js';

describe('ctxLevel', () => {
  it('is safe below 40', () => {
    assert.equal(ctxLevel(0), 'safe');
    assert.equal(ctxLevel(39.9), 'safe');
  });
  it('is warn from 40 up to 65 inclusive', () => {
    assert.equal(ctxLevel(40), 'warn');
    assert.equal(ctxLevel(65), 'warn');
  });
  it('is danger above 65', () => {
    assert.equal(ctxLevel(65.1), 'danger');
    assert.equal(ctxLevel(100), 'danger');
  });
});
