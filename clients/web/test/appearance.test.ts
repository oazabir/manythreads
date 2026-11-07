import { describe, expect, it } from 'vitest';
import { APPEARANCE_KEY, applyAppearance, parseAppearance, readCachedAppearance, resolveTheme, type AppearanceEnv } from '../src/shell/appearance';

function fakeEnv(prefersDark: boolean, stored?: string) {
  const attrs: Record<string, string> = {};
  const store = new Map<string, string>(stored === undefined ? [] : [[APPEARANCE_KEY, stored]]);
  let announced = 0;
  const env: AppearanceEnv = {
    root: { setAttribute: (k: string, v: string) => void (attrs[k] = v) },
    storage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    prefersDark,
    announce: () => void announced++,
  };
  return { env, attrs, store, announced: () => announced };
}

describe('resolveTheme', () => {
  it('uses the choice for Light and Dark and the device for System', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('parseAppearance', () => {
  it('reads a saved choice and falls back per field', () => {
    expect(parseAppearance('{"theme":"dark","density":"compact"}')).toEqual({ theme: 'dark', density: 'compact' });
    expect(parseAppearance('{"theme":"neon","density":"huge"}')).toEqual({ theme: 'system', density: 'comfortable' });
    expect(parseAppearance('{"theme":"light"}')).toEqual({ theme: 'light', density: 'comfortable' });
  });
  it('treats missing or damaged text as no cache', () => {
    expect(parseAppearance(null)).toBeNull();
    expect(parseAppearance('')).toBeNull();
    expect(parseAppearance('{not json')).toBeNull();
    expect(parseAppearance('7')).toBeNull();
    expect(parseAppearance('null')).toBeNull();
  });
});

describe('applyAppearance', () => {
  it('sets the three attributes, caches the choice and announces the change', () => {
    const t = fakeEnv(true);
    applyAppearance({ theme: 'system', density: 'compact' }, t.env);
    expect(t.attrs).toEqual({ 'data-theme-choice': 'system', 'data-theme': 'dark', 'data-density': 'compact' });
    expect(JSON.parse(t.store.get(APPEARANCE_KEY) ?? 'null')).toEqual({ theme: 'system', density: 'compact' });
    expect(t.announced()).toBe(1);
  });
  it('lets an explicit choice beat the device', () => {
    const t = fakeEnv(true);
    applyAppearance({ theme: 'light', density: 'comfortable' }, t.env);
    expect(t.attrs['data-theme']).toBe('light');
  });
  it('still applies when the storage refuses a write', () => {
    const t = fakeEnv(false);
    t.env.storage = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    applyAppearance({ theme: 'dark', density: 'comfortable' }, t.env);
    expect(t.attrs['data-theme']).toBe('dark');
  });
});

describe('readCachedAppearance', () => {
  it('reads what applyAppearance wrote', () => {
    const t = fakeEnv(false);
    applyAppearance({ theme: 'dark', density: 'compact' }, t.env);
    expect(readCachedAppearance(t.env)).toEqual({ theme: 'dark', density: 'compact' });
  });
  it('gives null for no storage or a storage that throws', () => {
    expect(readCachedAppearance({ storage: null })).toBeNull();
    expect(readCachedAppearance({ storage: { getItem: () => { throw new Error('blocked'); }, setItem: () => undefined } })).toBeNull();
  });
});
