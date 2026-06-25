import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { Pseudonymizer } from '../../src/export/pseudonymizer.js';

const SEED_A = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');
const SEED_B = Buffer.from('1112131415161718191a1b1c1d1e1f20', 'hex');

function countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
}

describe('Pseudonymizer.pseudonymizeToken', () => {
  it('is deterministic within one seed and length-preserving', () => {
    const p = new Pseudonymizer(SEED_A);
    const a = p.pseudonymizeToken('hello');
    const b = p.pseudonymizeToken('hello');
    assert.equal(a, b);
    assert.equal(a.length, 'hello'.length);
    assert.match(a, /^[a-z]+$/);
  });

  it('differs across seeds (Behavior #1)', () => {
    const a = new Pseudonymizer(SEED_A).pseudonymizeToken('hello');
    const b = new Pseudonymizer(SEED_B).pseudonymizeToken('hello');
    assert.notEqual(a, b);
  });

  it('maps empty string to empty string', () => {
    const p = new Pseudonymizer(SEED_A);
    assert.equal(p.pseudonymizeToken(''), '');
  });
});

describe('Pseudonymizer.pseudonymizePath (Behavior #2)', () => {
  it('preserves separators and final extension', () => {
    const p = new Pseudonymizer(SEED_A);
    const out = p.pseudonymizePath('src/auth/login.ts');
    const parts = out.split('/');
    assert.equal(parts.length, 3);
    assert.equal(parts[0].length, 'src'.length);
    assert.equal(parts[1].length, 'auth'.length);
    assert.ok(out.endsWith('.ts'));
    // stem length preserved (login = 5)
    assert.equal(parts[2], parts[2].replace(/\.ts$/, '') + '.ts');
    assert.equal(parts[2].replace(/\.ts$/, '').length, 'login'.length);
    assert.match(out, /^[a-z]+\/[a-z]+\/[a-z]+\.ts$/);
  });

  it('preserves the empty leading segment of absolute paths', () => {
    const p = new Pseudonymizer(SEED_A);
    const out = p.pseudonymizePath('/home/user/file.json');
    assert.ok(out.startsWith('/'));
    assert.equal(out.split('/').length, 4);
    assert.ok(out.endsWith('.json'));
  });

  it('same source path yields the same pseudonym', () => {
    const p = new Pseudonymizer(SEED_A);
    assert.equal(
      p.pseudonymizePath('src/auth/login.ts'),
      p.pseudonymizePath('src/auth/login.ts'),
    );
  });

  it('differs across seeds', () => {
    const a = new Pseudonymizer(SEED_A).pseudonymizePath('src/auth/login.ts');
    const b = new Pseudonymizer(SEED_B).pseudonymizePath('src/auth/login.ts');
    assert.notEqual(a, b);
  });

  it('handles extensionless final segment', () => {
    const p = new Pseudonymizer(SEED_A);
    const out = p.pseudonymizePath('bin/run');
    assert.match(out, /^[a-z]+\/[a-z]+$/);
  });
});

describe('Pseudonymizer.pseudonymizeMcpName (Behavior #3)', () => {
  it('keeps the mcp__<server>__<tool> skeleton and internal underscores', () => {
    const p = new Pseudonymizer(SEED_A);
    const out = p.pseudonymizeMcpName('mcp__github__create_pr');
    const parts = out.split('__');
    assert.equal(parts.length, 3);
    assert.equal(parts[0], 'mcp');
    assert.equal(parts[1].length, 'github'.length);
    // tool keeps the internal underscore and subtoken lengths
    const subs = parts[2].split('_');
    assert.equal(subs.length, 2);
    assert.equal(subs[0].length, 'create'.length);
    assert.equal(subs[1].length, 'pr'.length);
    assert.match(out, /^mcp__[a-z]+__[a-z]+_[a-z]+$/);
  });

  it('returns non-mcp (built-in) names unchanged', () => {
    const p = new Pseudonymizer(SEED_A);
    assert.equal(p.pseudonymizeMcpName('Bash'), 'Bash');
    assert.equal(p.pseudonymizeMcpName('Read'), 'Read');
    assert.equal(p.pseudonymizeMcpName('TodoWrite'), 'TodoWrite');
  });

  it('is deterministic within a seed and differs across seeds', () => {
    const a = new Pseudonymizer(SEED_A).pseudonymizeMcpName('mcp__github__create_pr');
    const a2 = new Pseudonymizer(SEED_A).pseudonymizeMcpName('mcp__github__create_pr');
    const b = new Pseudonymizer(SEED_B).pseudonymizeMcpName('mcp__github__create_pr');
    assert.equal(a, a2);
    assert.notEqual(a, b);
  });
});

describe('Pseudonymizer.scrambleText (Behavior #4)', () => {
  const source = [
    'The quick brown fox jumps over the lazy dog.',
    'Authentication failed for user administrator.',
    'Connecting to database postgresql://localhost:5432',
  ].join('\n');

  it('preserves total char count and newline count', () => {
    const p = new Pseudonymizer(SEED_A);
    const out = p.scrambleText(source);
    assert.equal(out.length, source.length);
    assert.equal(countChar(out, '\n'), countChar(source, '\n'));
  });

  it('uses only [a-z0-9 ] plus newlines', () => {
    const p = new Pseudonymizer(SEED_A);
    const out = p.scrambleText(source);
    assert.match(out, /^[a-z0-9 \n]*$/);
  });

  it('shares no whole word with the source', () => {
    const p = new Pseudonymizer(SEED_A);
    const out = p.scrambleText(source);
    const outWords = new Set(out.split(/\s+/).filter((w) => w.length > 0));
    const sourceWords = source
      .split(/\s+/)
      .filter((w) => w.length >= 3); // long enough that collision is effectively impossible
    for (const w of sourceWords) {
      assert.ok(!outWords.has(w), `output unexpectedly contains source word "${w}"`);
    }
  });

  it('is non-deterministic across two calls', () => {
    const p = new Pseudonymizer(SEED_A);
    assert.notEqual(p.scrambleText(source), p.scrambleText(source));
  });

  it('handles empty string', () => {
    const p = new Pseudonymizer(SEED_A);
    assert.equal(p.scrambleText(''), '');
  });
});

describe('Pseudonymizer.garbageLine', () => {
  it('produces len chars with no `{` or whitespace', () => {
    const p = new Pseudonymizer(SEED_A);
    const out = p.garbageLine(40);
    assert.equal(out.length, 40);
    assert.ok(!out.includes('{'));
    assert.match(out, /^\S+$/);
  });

  it('returns empty for non-positive lengths', () => {
    const p = new Pseudonymizer(SEED_A);
    assert.equal(p.garbageLine(0), '');
  });
});

describe('Pseudonymizer seed (Behavior #13)', () => {
  it('two no-arg instances produce different pseudonyms for the same input', () => {
    const a = new Pseudonymizer().pseudonymizeToken('some-input-value');
    const b = new Pseudonymizer().pseudonymizeToken('some-input-value');
    assert.notEqual(a, b);
  });

  it('does not expose the seed via any public property', () => {
    const p = new Pseudonymizer(SEED_A);
    const values = Object.values(p as unknown as Record<string, unknown>);
    for (const v of values) {
      assert.ok(
        !(Buffer.isBuffer(v) && v.equals(SEED_A)),
        'seed leaked through a public property',
      );
    }
  });
});
