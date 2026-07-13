import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadDiscountRules, initDiscounts } from '../../src/shared/discount-config.js';
import { setDiscountRules, getDiscountRules, MODEL_IDS } from '../../src/shared/cost.js';

const ENV_KEY = 'CLAUDE_MONITOR_DISCOUNTS_FILE';
const KNOWN_MODEL = MODEL_IDS[0];

let tmpDir: string | undefined;

function writeConfig(contents: string): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'discount-config-test-'));
  const path = join(tmpDir, 'discounts.json');
  writeFileSync(path, contents, 'utf8');
  process.env[ENV_KEY] = path;
  return path;
}

afterEach(() => {
  delete process.env[ENV_KEY];
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
  // Don't leak rules into other test files.
  setDiscountRules([]);
});

describe('loadDiscountRules', () => {
  it('parses a valid config into rules (file order preserved)', () => {
    writeConfig(
      JSON.stringify([
        { model: KNOWN_MODEL, percentOff: 50, start: '2026-06-01', end: '2026-08-31' },
      ]),
    );
    const rules = loadDiscountRules();
    assert.deepEqual(rules, [
      { model: KNOWN_MODEL, percentOff: 50, start: '2026-06-01', end: '2026-08-31' },
    ]);
  });

  it('accepts a rule with no date bounds', () => {
    writeConfig(JSON.stringify([{ model: KNOWN_MODEL, percentOff: 10 }]));
    const rules = loadDiscountRules();
    assert.equal(rules.length, 1);
    assert.equal(rules[0].model, KNOWN_MODEL);
    assert.equal(rules[0].percentOff, 10);
  });

  it('returns [] when the file is missing (no throw)', () => {
    process.env[ENV_KEY] = join(tmpdir(), 'does-not-exist-discount-config-xyz.json');
    assert.deepEqual(loadDiscountRules(), []);
    delete process.env[ENV_KEY];
  });

  it('returns [] on malformed JSON (no throw)', () => {
    writeConfig('{ not valid json');
    assert.deepEqual(loadDiscountRules(), []);
  });

  it('returns [] when the top level is not an array (no throw)', () => {
    writeConfig(JSON.stringify({ model: KNOWN_MODEL, percentOff: 50 }));
    assert.deepEqual(loadDiscountRules(), []);
  });

  it('drops an unknown model id but keeps valid siblings', () => {
    writeConfig(
      JSON.stringify([
        { model: 'not-a-real-model', percentOff: 20 },
        { model: KNOWN_MODEL, percentOff: 30 },
      ]),
    );
    const rules = loadDiscountRules();
    assert.equal(rules.length, 1);
    assert.equal(rules[0].model, KNOWN_MODEL);
    assert.equal(rules[0].percentOff, 30);
  });

  it('drops an out-of-range percentOff but keeps valid siblings', () => {
    writeConfig(
      JSON.stringify([
        { model: KNOWN_MODEL, percentOff: 150 },
        { model: KNOWN_MODEL, percentOff: -5 },
        { model: KNOWN_MODEL, percentOff: 25 },
      ]),
    );
    const rules = loadDiscountRules();
    assert.equal(rules.length, 1);
    assert.equal(rules[0].percentOff, 25);
  });

  it('drops a rule where start is after end but keeps valid siblings', () => {
    writeConfig(
      JSON.stringify([
        { model: KNOWN_MODEL, percentOff: 40, start: '2026-09-01', end: '2026-06-01' },
        { model: KNOWN_MODEL, percentOff: 40, start: '2026-06-01', end: '2026-09-01' },
      ]),
    );
    const rules = loadDiscountRules();
    assert.equal(rules.length, 1);
    assert.equal(rules[0].start, '2026-06-01');
    assert.equal(rules[0].end, '2026-09-01');
  });

  it('drops a rule with a malformed date string', () => {
    writeConfig(
      JSON.stringify([
        { model: KNOWN_MODEL, percentOff: 40, start: '06/01/2026' },
        { model: KNOWN_MODEL, percentOff: 40, start: '2026-06-01' },
      ]),
    );
    const rules = loadDiscountRules();
    assert.equal(rules.length, 1);
    assert.equal(rules[0].start, '2026-06-01');
  });
});

describe('initDiscounts', () => {
  it('installs loaded rules into the pricing choke point', () => {
    writeConfig(JSON.stringify([{ model: KNOWN_MODEL, percentOff: 50 }]));
    initDiscounts();
    const active = getDiscountRules();
    assert.equal(active.length, 1);
    assert.equal(active[0].model, KNOWN_MODEL);
    assert.equal(active[0].percentOff, 50);
  });

  it('installs [] when the file is missing', () => {
    process.env[ENV_KEY] = join(tmpdir(), 'missing-discount-config-abc.json');
    initDiscounts();
    assert.deepEqual(getDiscountRules(), []);
    delete process.env[ENV_KEY];
  });
});
