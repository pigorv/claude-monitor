import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { toolTagClass } from '../../frontend/src/lib/tool-tags.js';

describe('toolTagClass', () => {
  it('maps write-family tools to green', () => {
    assert.equal(toolTagClass('Write'), 'tool-write');
  });
  it('maps edit/modify/agentic tools to purple', () => {
    for (const n of ['Edit', 'MultiEdit', 'NotebookEdit', 'Task', 'Agent', 'TodoWrite', 'AskUserQuestion']) {
      assert.equal(toolTagClass(n), 'tool-edit', `${n} should be tool-edit`);
    }
  });
  it('maps bash to amber', () => {
    assert.equal(toolTagClass('Bash'), 'tool-bash');
  });
  it('maps read/search-family tools to blue', () => {
    for (const n of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'ToolSearch']) {
      assert.equal(toolTagClass(n), 'tool-read', `${n} should be tool-read`);
    }
  });
  it('falls back to gray for unknown tools', () => {
    assert.equal(toolTagClass('SomeFutureTool'), 'tool-default');
    assert.equal(toolTagClass(''), 'tool-default');
  });
  it('is case-insensitive', () => {
    assert.equal(toolTagClass('bash'), 'tool-bash');
  });
});
