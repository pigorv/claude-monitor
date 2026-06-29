import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

// This test lives IN test/fixtures/, so the fixtures root is its own directory.
const FIXTURES = fileURLToPath(new URL('./', import.meta.url));

// The seven taxonomy directories that must each contain at least one fixture.
const TAXONOMY_DIRS = [
  'happy',
  'legacy-format',
  'corrupt',
  'large',
  'subagent',
  'compaction',
  'plan-impl-pair',
];

// Synthetic home segments the corpus is allowed to use (e.g. /home/user/...).
const HOME_SEG_ALLOWLIST = new Set(['user', 'dev', 'tmp', 'test', 'runner', 'example']);

// Generic / CI usernames that would produce false positives if matched
// against the corpus. When this machine's username is one of these we skip
// the username check entirely.
const GENERIC_USERNAMES = new Set([
  'root',
  'user',
  'runner',
  'admin',
  'ubuntu',
  'test',
  'dev',
  'build',
]);

interface Fixture {
  /** Path relative to the fixtures root, for readable failure messages. */
  rel: string;
  /** Absolute path on disk. */
  abs: string;
  /**
   * File contents read as latin1 (NOT utf-8): corrupt/non-utf8.jsonl contains
   * raw non-UTF8 bytes, and latin1 reads them losslessly without throwing
   * while still matching ASCII PII patterns.
   */
  text: string;
}

/** Recursively enumerate every *.jsonl fixture under the fixtures root. */
function loadFixtures(): Fixture[] {
  const entries = readdirSync(FIXTURES, { recursive: true, encoding: 'utf-8' });
  return entries
    .filter((rel) => rel.endsWith('.jsonl'))
    .map((rel) => {
      const abs = fileURLToPath(new URL(rel, import.meta.url));
      return { rel, abs, text: readFileSync(abs, 'latin1') };
    });
}

const FIXTURES_LIST = loadFixtures();

// The only emails the corpus may contain are the IETF reserved domains/TLDs
// (RFC 2606 / RFC 6761). A plain `startsWith('example.')` would also wave
// through real registrable domains like `example.evil.com`, so match the
// reserved set exactly (allowing subdomains such as `mail.example.com`).
const RESERVED_EMAIL_DOMAINS = new Set(['example.com', 'example.org', 'example.net']);
const RESERVED_EMAIL_TLDS = ['.example', '.test', '.invalid'];

function isAllowedEmailDomain(domain: string): boolean {
  const d = domain.toLowerCase().replace(/\.$/, '');
  if (RESERVED_EMAIL_DOMAINS.has(d)) return true;
  for (const base of RESERVED_EMAIL_DOMAINS) {
    if (d.endsWith(`.${base}`)) return true; // e.g. mail.example.com
  }
  return RESERVED_EMAIL_TLDS.some((tld) => d.endsWith(tld));
}

interface Violation {
  file: string;
  match: string;
  rule: string;
}

function formatViolations(violations: Violation[]): string {
  return violations
    .map((v) => `  [${v.rule}] ${v.file}: ${JSON.stringify(v.match)}`)
    .join('\n');
}

describe('fixture corpus PII gate', () => {
  it('contains no real /Users/ home paths', () => {
    const violations: Violation[] = [];
    for (const { rel, text } of FIXTURES_LIST) {
      const re = /\/Users\/[^\s"']*/g;
      for (const m of text.matchAll(re)) {
        violations.push({ file: rel, match: m[0], rule: '/Users/' });
      }
    }
    assert.deepEqual(
      violations,
      [],
      `Fixture(s) contain a real /Users/ path:\n${formatViolations(violations)}`,
    );
  });

  it('contains no non-synthetic /home/<seg>/ paths', () => {
    const violations: Violation[] = [];
    for (const { rel, text } of FIXTURES_LIST) {
      const re = /\/home\/([^/\s"']+)\//g;
      for (const m of text.matchAll(re)) {
        const seg = m[1].toLowerCase();
        if (!HOME_SEG_ALLOWLIST.has(seg)) {
          violations.push({ file: rel, match: m[0], rule: '/home/<seg>/' });
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `Fixture(s) contain a non-synthetic /home/<seg>/ path:\n${formatViolations(violations)}`,
    );
  });

  it('contains no emails outside the @example.* domain', () => {
    const violations: Violation[] = [];
    for (const { rel, text } of FIXTURES_LIST) {
      const re = /([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+)/g;
      for (const m of text.matchAll(re)) {
        const domain = m[1].split('@')[1];
        if (!isAllowedEmailDomain(domain)) {
          violations.push({ file: rel, match: m[0], rule: 'email' });
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `Fixture(s) contain a non-@example.* email:\n${formatViolations(violations)}`,
    );
  });

  it("contains no leak of this machine's home path or username", () => {
    const violations: Violation[] = [];

    const home = os.homedir();

    // Resolve the username defensively: os.userInfo() can throw (e.g. a
    // numeric uid with no /etc/passwd entry). If it throws, skip the username
    // check rather than fail the gate.
    let user: string | null = null;
    try {
      user = os.userInfo().username;
    } catch {
      user = null;
    }

    // Only check "specific" usernames: length >= 4 AND not a generic/CI name.
    // This avoids false positives in CI where the username is generic.
    const checkUser =
      user !== null && user.length >= 4 && !GENERIC_USERNAMES.has(user.toLowerCase());

    // Forms of the username to look for: as-is, plus the _<->- normalized
    // variants (sanitizers may swap one for the other).
    const userForms = checkUser && user !== null
      ? [...new Set([user, user.replace(/_/g, '-'), user.replace(/-/g, '_')])]
      : [];

    for (const { rel, text } of FIXTURES_LIST) {
      if (text.includes(home)) {
        violations.push({ file: rel, match: home, rule: 'os.homedir()' });
      }
      const lowerText = text.toLowerCase();
      for (const form of userForms) {
        if (lowerText.includes(form.toLowerCase())) {
          violations.push({ file: rel, match: form, rule: 'os.userInfo().username' });
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Fixture(s) leak this machine's home path or username:\n${formatViolations(violations)}`,
    );
  });

  it('email allowlist accepts reserved domains and rejects look-alikes', () => {
    for (const ok of [
      'example.com',
      'example.org',
      'mail.example.com',
      'alice.example',
      'svc.test',
      'x.invalid',
    ]) {
      assert.equal(isAllowedEmailDomain(ok), true, `${ok} should be allowed`);
    }
    for (const bad of [
      'example.evil.com',
      'gmail.com',
      'examplexcom',
      'notexample.com',
      'example.com.evil.io',
    ]) {
      assert.equal(isAllowedEmailDomain(bad), false, `${bad} should be rejected`);
    }
  });

  it('every taxonomy dir has >=1 .jsonl', () => {
    const missing: string[] = [];
    for (const dir of TAXONOMY_DIRS) {
      const prefix = `${dir}/`;
      const has = FIXTURES_LIST.some(
        (f) => f.rel === `${dir}.jsonl` || f.rel.startsWith(prefix),
      );
      if (!has) {
        missing.push(dir);
      }
    }
    assert.deepEqual(
      missing,
      [],
      `Taxonomy dir(s) with no .jsonl fixture: ${missing.join(', ')}`,
    );
  });
});
