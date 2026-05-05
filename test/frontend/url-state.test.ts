import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { parseHash, buildHash, updateParams } from '../../frontend/src/lib/url-state.js';

describe('parseHash', () => {
  it('parses bare root', () => {
    const r = parseHash('#/');
    assert.equal(r.path, '/');
    assert.equal(r.params.toString(), '');
  });

  it('parses path with no params', () => {
    const r = parseHash('#/session/abc');
    assert.equal(r.path, '/session/abc');
    assert.equal(r.params.toString(), '');
  });

  it('splits path and query on first ?', () => {
    const r = parseHash('#/?model=opus&q=migration');
    assert.equal(r.path, '/');
    assert.equal(r.params.get('model'), 'opus');
    assert.equal(r.params.get('q'), 'migration');
  });

  it('handles missing leading #', () => {
    const r = parseHash('/session/x?tab=context');
    assert.equal(r.path, '/session/x');
    assert.equal(r.params.get('tab'), 'context');
  });

  it('handles empty input', () => {
    const r = parseHash('');
    assert.equal(r.path, '/');
    assert.equal(r.params.toString(), '');
  });

  it('handles trailing ? with no params', () => {
    const r = parseHash('#/?');
    assert.equal(r.path, '/');
    assert.equal(r.params.toString(), '');
  });

  it('preserves session id with multiple ? defensively', () => {
    // Only the first ? is treated as the param delimiter; any subsequent ?s
    // belong to the value.
    const r = parseHash('#/session/abc?tab=context?weird=1');
    assert.equal(r.path, '/session/abc');
    assert.equal(r.params.get('tab'), 'context?weird=1');
  });
});

describe('buildHash', () => {
  it('omits ? when params are empty', () => {
    assert.equal(buildHash('/', new URLSearchParams()), '#/');
  });

  it('round-trips through parseHash', () => {
    const original = '#/session/x?tab=context&filter=tool_call_start';
    const { path, params } = parseHash(original);
    const rebuilt = buildHash(path, params);
    // Order of keys in URLSearchParams is insertion-stable.
    assert.equal(rebuilt, original);
  });
});

describe('updateParams', () => {
  let originalLocation: Location;
  let originalHistory: History;
  let originalWindow: typeof window;
  let originalHashChangeEvent: typeof HashChangeEvent;
  let dispatchedEvents: string[];
  let currentHash: string;
  let pushStateCalls: number;
  let replaceStateCalls: number;

  beforeEach(() => {
    dispatchedEvents = [];
    currentHash = '#/';
    pushStateCalls = 0;
    replaceStateCalls = 0;
    originalLocation = (globalThis as any).location;
    originalHistory = (globalThis as any).history;
    originalWindow = (globalThis as any).window;
    originalHashChangeEvent = (globalThis as any).HashChangeEvent;

    (globalThis as any).location = {
      get hash() { return currentHash; },
      set hash(v: string) { currentHash = v; },
      pathname: '/',
      search: '',
    };
    (globalThis as any).history = {
      pushState: (_s: unknown, _t: string, url: string) => {
        pushStateCalls++;
        const i = url.indexOf('#');
        currentHash = i >= 0 ? url.slice(i) : '';
      },
      replaceState: (_s: unknown, _t: string, url: string) => {
        replaceStateCalls++;
        const i = url.indexOf('#');
        currentHash = i >= 0 ? url.slice(i) : '';
      },
    };
    (globalThis as any).window = {
      dispatchEvent: (e: Event) => { dispatchedEvents.push(e.type); return true; },
    };
    (globalThis as any).HashChangeEvent = class extends Event {};
  });

  afterEach(() => {
    (globalThis as any).location = originalLocation;
    (globalThis as any).history = originalHistory;
    (globalThis as any).window = originalWindow;
    (globalThis as any).HashChangeEvent = originalHashChangeEvent;
  });

  it('sets a new param', () => {
    updateParams({ model: 'opus' });
    assert.equal(currentHash, '#/?model=opus');
    assert.deepEqual(dispatchedEvents, ['hashchange']);
  });

  it('null deletes a param', () => {
    currentHash = '#/?model=opus&q=migration';
    updateParams({ model: null });
    assert.equal(currentHash, '#/?q=migration');
  });

  it('empty string deletes a param', () => {
    currentHash = '#/?q=migration';
    updateParams({ q: '' });
    assert.equal(currentHash, '#/');
  });

  it('skips dispatch when value is unchanged', () => {
    currentHash = '#/?model=opus';
    updateParams({ model: 'opus' });
    assert.deepEqual(dispatchedEvents, [], 'no hashchange fired when result is identical');
    assert.equal(pushStateCalls, 0, 'pushState not called');
    assert.equal(replaceStateCalls, 0, 'replaceState not called');
  });

  it('preserves the path', () => {
    currentHash = '#/session/abc?tab=timeline';
    updateParams({ tab: 'context' }, 'push');
    assert.equal(currentHash, '#/session/abc?tab=context');
  });

  it('falls back to location.hash assignment when history.*State throws', () => {
    // Simulate environments where history mutation is blocked (e.g. file://
    // pages). The fallback path writes location.hash directly and skips the
    // synthetic hashchange — the browser fires its own.
    (globalThis as any).history.pushState = () => { throw new Error('blocked'); };
    updateParams({ model: 'opus' }, 'push');
    assert.equal(currentHash, '#/?model=opus');
    assert.deepEqual(dispatchedEvents, [], 'no synthetic hashchange when falling back to location.hash');
  });
});
