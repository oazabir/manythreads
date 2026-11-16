import { describe, expect, it } from 'vitest';
import { APPEARANCE_KEY, applyAppearance, parseAppearance, readCachedAppearance, resolveTheme, syncThemeColour, type AppearanceEnv } from '../src/shell/appearance';

function fakeEnv(prefersDark: boolean, stored?: string, shell: string | null = 'rgb(243, 244, 246)') {
  const attrs: Record<string, string> = {};
  const store = new Map<string, string>(stored === undefined ? [] : [[APPEARANCE_KEY, stored]]);
  let announced = 0;
  const colours: string[] = [];
  const env: AppearanceEnv = {
    root: { setAttribute: (k: string, v: string) => void (attrs[k] = v), removeAttribute: (k: string) => void delete attrs[k] },
    storage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    prefersDark,
    announce: () => void announced++,
    later: (fn) => fn(),
    shellColour: () => shell,
    setThemeColour: (c) => void colours.push(c),
  };
  return { env, attrs, store, colours, announced: () => announced };
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
    expect(parseAppearance('{"theme":"dark","density":"compact","palette":"linen"}')).toEqual({ theme: 'dark', density: 'compact', palette: 'linen' });
    expect(parseAppearance('{"theme":"neon","density":"huge","palette":"neon"}')).toEqual({ theme: 'system', density: 'comfortable', palette: 'classic' });
    expect(parseAppearance('{"theme":"light"}')).toEqual({ theme: 'light', density: 'comfortable', palette: 'classic' });
  });
  it('reads a copy saved before palettes existed as the classic palette', () => {
    expect(parseAppearance('{"theme":"dark","density":"compact"}')).toEqual({ theme: 'dark', density: 'compact', palette: 'classic' });
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
  it('sets the four attributes, caches the choice and announces the change', () => {
    const t = fakeEnv(true);
    applyAppearance({ theme: 'system', density: 'compact', palette: 'harbor' }, t.env);
    expect(t.attrs).toEqual({ 'data-theme-choice': 'system', 'data-theme': 'dark', 'data-palette': 'harbor', 'data-density': 'compact' });
    expect(JSON.parse(t.store.get(APPEARANCE_KEY) ?? 'null')).toEqual({ theme: 'system', density: 'compact', palette: 'harbor' });
    expect(t.announced()).toBe(1);
  });
  it('lets an explicit choice beat the device', () => {
    const t = fakeEnv(true);
    applyAppearance({ theme: 'light', density: 'comfortable', palette: 'classic' }, t.env);
    expect(t.attrs['data-theme']).toBe('light');
  });
  it('still applies when the storage refuses a write', () => {
    const t = fakeEnv(false);
    t.env.storage = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    applyAppearance({ theme: 'dark', density: 'comfortable', palette: 'linen' }, t.env);
    expect(t.attrs['data-theme']).toBe('dark');
    expect(t.attrs['data-palette']).toBe('linen');
  });
  it('holds transitions off for one frame and sets the browser bar to the sidebar colour', () => {
    const t = fakeEnv(false, undefined, 'rgb(27, 24, 21)');
    let release: () => void = () => undefined;
    t.env.later = (fn) => void (release = fn);
    applyAppearance({ theme: 'dark', density: 'comfortable', palette: 'linen' }, t.env);
    expect(t.attrs['data-look-switching']).toBe('');
    expect(t.colours).toEqual(['rgb(27, 24, 21)']);
    release();
    expect(t.attrs['data-look-switching']).toBeUndefined();
  });
  it('leaves the browser bar alone when the colour cannot be read', () => {
    const t = fakeEnv(false, undefined, null);
    syncThemeColour(t.env);
    expect(t.colours).toEqual([]);
  });
});

describe('readCachedAppearance', () => {
  it('reads what applyAppearance wrote', () => {
    const t = fakeEnv(false);
    applyAppearance({ theme: 'dark', density: 'compact', palette: 'graphite' }, t.env);
    expect(readCachedAppearance(t.env)).toEqual({ theme: 'dark', density: 'compact', palette: 'graphite' });
  });
  it('gives null for no storage or a storage that throws', () => {
    expect(readCachedAppearance({ storage: null })).toBeNull();
    expect(readCachedAppearance({ storage: { getItem: () => { throw new Error('blocked'); }, setItem: () => undefined } })).toBeNull();
  });
});
