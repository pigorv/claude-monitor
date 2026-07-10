import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { filenameFromDisposition } from '../../frontend/src/api/client.js';

describe('filenameFromDisposition', () => {
  it('extracts a quoted filename', () => {
    assert.equal(
      filenameFromDisposition('attachment; filename="claude-monitor-session-abc.zip"', 'fallback.zip'),
      'claude-monitor-session-abc.zip',
    );
  });

  it('extracts an unquoted filename', () => {
    assert.equal(
      filenameFromDisposition('attachment; filename=claude-monitor-session-abc-raw.zip', 'fallback.zip'),
      'claude-monitor-session-abc-raw.zip',
    );
  });

  it('trims whitespace around an unquoted filename', () => {
    assert.equal(
      filenameFromDisposition('attachment; filename= spaced.zip ', 'fallback.zip'),
      'spaced.zip',
    );
  });

  it('returns the fallback for a null header', () => {
    assert.equal(filenameFromDisposition(null, 'fallback.zip'), 'fallback.zip');
  });

  it('returns the fallback for a blank header', () => {
    assert.equal(filenameFromDisposition('', 'fallback.zip'), 'fallback.zip');
  });

  it('returns the fallback when no filename is present', () => {
    assert.equal(filenameFromDisposition('attachment', 'fallback.zip'), 'fallback.zip');
  });

  it('returns the fallback for an empty quoted filename', () => {
    assert.equal(filenameFromDisposition('attachment; filename=""', 'fallback.zip'), 'fallback.zip');
  });
});
