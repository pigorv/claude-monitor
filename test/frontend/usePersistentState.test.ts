import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import render from 'preact-render-to-string';
import { html } from 'htm/preact';
import { usePersistentState } from '../../frontend/src/hooks/usePersistentState.js';

interface FakeStorage {
  data: Map<string, string>;
  storage: Storage;
}

function makeStorage(opts: { setItemThrows?: boolean } = {}): FakeStorage {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => {
      if (opts.setItemThrows) throw new Error('quota');
      data.set(k, v);
    },
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

describe('usePersistentState', () => {
  it('returns defaultValue when key absent', () => {
    const fake = makeStorage();
    (globalThis as any).localStorage = fake.storage;

    let captured: unknown;
    function Cap() {
      const [v] = usePersistentState<string>('k', 'fallback');
      captured = v;
      return html`<div>${v}</div>`;
    }
    render(html`<${Cap} />`);

    assert.equal(captured, 'fallback');
    assert.equal(fake.data.has('k'), false, 'should not write on read-miss');
  });

  it('parse error → defaultValue and key cleared', () => {
    const fake = makeStorage();
    fake.data.set('k', '{not json');
    (globalThis as any).localStorage = fake.storage;

    let captured: unknown;
    function Cap() {
      const [v] = usePersistentState<string>('k', 'fallback');
      captured = v;
      return html`<div>${v}</div>`;
    }
    render(html`<${Cap} />`);

    assert.equal(captured, 'fallback');
    assert.equal(fake.data.has('k'), false, 'corrupt key should be cleared');
  });

  it('setValue persists JSON-stringified; setValue(null) calls removeItem', () => {
    const fake = makeStorage();
    (globalThis as any).localStorage = fake.storage;

    let setter!: (v: any) => void;
    function Cap() {
      const [v, s] = usePersistentState<{ a: number } | null>('k', null);
      setter = s as (v: any) => void;
      return html`<div>${JSON.stringify(v)}</div>`;
    }
    render(html`<${Cap} />`);

    setter({ a: 1 });
    assert.equal(fake.data.get('k'), '{"a":1}', 'value persisted JSON-stringified');

    setter(null);
    assert.equal(fake.data.has('k'), false, 'null deletes the key');
  });

  it('storage exceptions (e.g. quota) are swallowed without throwing', () => {
    const fake = makeStorage({ setItemThrows: true });
    (globalThis as any).localStorage = fake.storage;

    let setter!: (v: any) => void;
    function Cap() {
      const [, s] = usePersistentState<string>('k', 'def');
      setter = s as (v: any) => void;
      return html`<div></div>`;
    }
    render(html`<${Cap} />`);

    assert.doesNotThrow(() => setter('x'));
  });
});
