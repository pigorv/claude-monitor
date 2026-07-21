import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig, parsePort, CONFIG, DEFAULT_CONFIG } from '../../src/shared/constants.js';

const defaults = {
  dataDir: join(homedir(), '.claude-monitor'),
  dbPath: join(homedir(), '.claude-monitor', 'data.sqlite'),
  defaultPort: 4173,
  claudeProjectsPath: join(homedir(), '.claude', 'projects'),
};

describe('loadConfig defaults', () => {
  it('empty env equals today values exactly, host undefined (Behavior #1, #2, #6)', () => {
    const cfg = loadConfig({});
    assert.equal(cfg.dataDir, defaults.dataDir);
    assert.equal(cfg.dbPath, defaults.dbPath);
    assert.equal(cfg.defaultPort, defaults.defaultPort);
    assert.equal(cfg.claudeProjectsPath, defaults.claudeProjectsPath);
    assert.equal(cfg.host, undefined);
  });

  it('CONFIG and DEFAULT_CONFIG are the same frozen object', () => {
    assert.equal(DEFAULT_CONFIG, CONFIG);
    assert.ok(Object.isFrozen(CONFIG));
  });
});

describe('loadConfig per-var resolution', () => {
  it('CLAUDE_MONITOR_DATA_DIR sets dataDir and defaults dbPath under it', () => {
    const cfg = loadConfig({ CLAUDE_MONITOR_DATA_DIR: '/tmp/cm-data' });
    assert.equal(cfg.dataDir, '/tmp/cm-data');
    assert.equal(cfg.dbPath, join('/tmp/cm-data', 'data.sqlite'));
  });

  it('CLAUDE_MONITOR_DB_PATH sets dbPath (env over default, Behavior #1)', () => {
    const cfg = loadConfig({ CLAUDE_MONITOR_DB_PATH: '/var/db/x.sqlite' });
    assert.equal(cfg.dbPath, '/var/db/x.sqlite');
    // dataDir still the default
    assert.equal(cfg.dataDir, defaults.dataDir);
  });

  it('CLAUDE_MONITOR_PORT sets defaultPort', () => {
    const cfg = loadConfig({ CLAUDE_MONITOR_PORT: '8080' });
    assert.equal(cfg.defaultPort, 8080);
  });

  it('CLAUDE_MONITOR_HOST sets host', () => {
    const cfg = loadConfig({ CLAUDE_MONITOR_HOST: '127.0.0.1' });
    assert.equal(cfg.host, '127.0.0.1');
  });

  it('CLAUDE_MONITOR_PROJECTS_PATH sets claudeProjectsPath', () => {
    const cfg = loadConfig({ CLAUDE_MONITOR_PROJECTS_PATH: '/data/projects' });
    assert.equal(cfg.claudeProjectsPath, '/data/projects');
  });
});

describe('loadConfig relative path resolution (Behavior #9)', () => {
  it('resolves relative dbPath against cwd', () => {
    const cfg = loadConfig({ CLAUDE_MONITOR_DB_PATH: 'rel/x.sqlite' });
    assert.equal(cfg.dbPath, resolve('rel/x.sqlite'));
    assert.ok(cfg.dbPath.startsWith('/'), 'expected an absolute path');
  });

  it('resolves relative dataDir against cwd and derives dbPath under it', () => {
    const cfg = loadConfig({ CLAUDE_MONITOR_DATA_DIR: 'reldata' });
    assert.equal(cfg.dataDir, resolve('reldata'));
    assert.equal(cfg.dbPath, join(resolve('reldata'), 'data.sqlite'));
  });
});

describe('parsePort validation (Behavior #10)', () => {
  it('unset and empty fall back to 4173', () => {
    assert.equal(parsePort(undefined), 4173);
    assert.equal(parsePort(''), 4173);
  });

  it('valid integers pass through', () => {
    assert.equal(parsePort('1'), 1);
    assert.equal(parsePort('65535'), 65535);
    assert.equal(parsePort('4173'), 4173);
  });

  it('throws on unparseable / out-of-range / non-integer', () => {
    assert.throws(() => parsePort('abc'), /Invalid CLAUDE_MONITOR_PORT "abc"/);
    assert.throws(() => parsePort('0'), /Invalid CLAUDE_MONITOR_PORT "0"/);
    assert.throws(() => parsePort('70000'), /Invalid CLAUDE_MONITOR_PORT "70000"/);
    assert.throws(() => parsePort('12.5'), /expected an integer 1-65535/);
  });

  it('loadConfig propagates the throw for a bad CLAUDE_MONITOR_PORT', () => {
    assert.throws(() => loadConfig({ CLAUDE_MONITOR_PORT: 'abc' }), /Invalid CLAUDE_MONITOR_PORT/);
  });
});
