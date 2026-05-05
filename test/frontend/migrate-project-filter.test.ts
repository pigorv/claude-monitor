import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { migrateProjectFilterKey } from '../../frontend/src/lib/migrate-project-filter.js';

const OLD_KEY = 'cm:projectFilter';
const NEW_KEY = 'cm.sessionList.project';

function makeStorage() {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
  } as unknown as Storage;
  return { data, storage };
}

let originalLocalStorage: any;

beforeEach(() => {
  originalLocalStorage = (globalThis as any).localStorage;
});

afterEach(() => {
  (globalThis as any).localStorage = originalLocalStorage;
});

describe('migrateProjectFilterKey', () => {
  it('does nothing when no old key is set', () => {
    const fake = makeStorage();
    (globalThis as any).localStorage = fake.storage;

    migrateProjectFilterKey();

    assert.equal(fake.data.size, 0, 'storage should remain empty');
    assert.equal(fake.data.has(NEW_KEY), false);
  });

  it('migrates old → new (JSON-encoded) when new key is absent', () => {
    const fake = makeStorage();
    fake.data.set(OLD_KEY, 'myproj');
    (globalThis as any).localStorage = fake.storage;

    migrateProjectFilterKey();

    assert.equal(fake.data.get(NEW_KEY), '"myproj"', 'new key holds JSON-stringified value');
    assert.equal(fake.data.has(OLD_KEY), false, 'old key removed');
  });

  it('preserves existing new-key value but still removes old key', () => {
    const fake = makeStorage();
    fake.data.set(OLD_KEY, 'myproj');
    fake.data.set(NEW_KEY, '"already-set"');
    (globalThis as any).localStorage = fake.storage;

    migrateProjectFilterKey();

    assert.equal(fake.data.get(NEW_KEY), '"already-set"', 'new key untouched');
    assert.equal(fake.data.has(OLD_KEY), false, 'old key still removed');
  });
});
