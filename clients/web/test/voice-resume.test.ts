import { afterEach, describe, expect, it } from 'vitest';
import { clearPosition, loadPosition, loadSpeed, parseResume, savePosition, saveSpeed, withPosition } from '../src/channels/voice/resume';

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  };
}

const broken: Storage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => undefined,
  clear: () => undefined,
  key: () => null,
  length: 0,
};

const store = fakeStorage();
afterEach(() => store.clear());

describe('voice message resume position (P14-17)', () => {
  it('remembers where a clip was stopped and gives it back', () => {
    savePosition('f1', 12_000, 42_000, store, 1);
    expect(loadPosition('f1', store)).toBe(12_000);
    expect(loadPosition('other', store)).toBe(0);
  });

  it('forgets a clip stopped at the very start or the very end', () => {
    savePosition('f1', 12_000, 42_000, store, 1);
    savePosition('f1', 41_500, 42_000, store, 2);
    expect(loadPosition('f1', store)).toBe(0);
    savePosition('f2', 20_000, 42_000, store, 3);
    clearPosition('f2', store);
    expect(loadPosition('f2', store)).toBe(0);
    expect(withPosition({}, 'f3', 300, 42_000, 1)).toEqual({});
  });

  it('keeps only the newest 50 clips', () => {
    let map = {};
    for (let i = 0; i < 60; i += 1) map = withPosition(map, `f${i}`, 5_000, 42_000, i);
    expect(Object.keys(map)).toHaveLength(50);
    expect(map).not.toHaveProperty('f0');
    expect(map).toHaveProperty('f59');
  });

  it('reads damaged storage as empty and drops entries of the wrong shape', () => {
    expect(parseResume('{not json')).toEqual({});
    expect(parseResume('[1,2]')).toEqual({});
    expect(parseResume(JSON.stringify({ a: { ms: 'x', at: 1 }, b: { ms: 3000, at: 2 }, c: null }))).toEqual({ b: { ms: 3000, at: 2 } });
  });

  it('never throws when the storage is blocked', () => {
    expect(() => savePosition('f1', 5_000, 42_000, broken)).not.toThrow();
    expect(loadPosition('f1', broken)).toBe(0);
    expect(() => saveSpeed(2, broken)).not.toThrow();
    expect(loadSpeed(broken)).toBe(1);
    expect(loadPosition('f1', null)).toBe(0);
  });

  it('keeps the speed that was picked and ignores a value that is not a speed', () => {
    saveSpeed(1.5, store);
    expect(loadSpeed(store)).toBe(1.5);
    store.setItem('mt.voice.speed', '7');
    expect(loadSpeed(store)).toBe(1);
  });
});
