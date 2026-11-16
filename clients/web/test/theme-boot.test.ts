import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error a plain .mjs data file with no types
import { TEXT_FACE_FILE, THEMES } from '../../../tools/design/themes.mjs';

// public/theme-boot.js is a plain script that runs before anything else: here it runs against a small stand-in for the page.
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'public', 'theme-boot.js'), 'utf8');

interface Page {
  attrs: Record<string, string>;
  preloads: string[];
  events: string[];
  setDevice: (dark: boolean) => void;
}

function boot(opts: { stored?: string | null; dark?: boolean; storageThrows?: boolean; noMatchMedia?: boolean }): Page {
  const attrs: Record<string, string> = {};
  const preloads: string[] = [];
  const events: string[] = [];
  let dark = opts.dark ?? false;
  const listeners: Array<() => void> = [];
  const win = {
    localStorage: {
      getItem: (k: string) => {
        if (opts.storageThrows) throw new Error('blocked');
        return k === 'mt.appearance' ? (opts.stored ?? null) : null;
      },
    },
    matchMedia: opts.noMatchMedia
      ? undefined
      : () => ({ get matches() { return dark; }, addEventListener: (_: string, fn: () => void) => void listeners.push(fn) }),
    dispatchEvent: (e: { type: string }) => void events.push(e.type),
  };
  const doc = {
    documentElement: { setAttribute: (k: string, v: string) => void (attrs[k] = v), getAttribute: (k: string) => attrs[k] ?? null },
    createElement: () => ({}) as Record<string, string>,
    head: { appendChild: (el: Record<string, string>) => void preloads.push(`${el['rel']}:${el['as']}:${el['href']}`) },
  };
  new Function('window', 'document', 'Event', source)(win, doc, class { type: string; constructor(t: string) { this.type = t; } });
  return { attrs, preloads, events, setDevice: (d) => { dark = d; listeners.forEach((fn) => fn()); } };
}

const saved = (o: Record<string, string>) => JSON.stringify(o);

describe('theme-boot.js', () => {
  it('draws the classic palette in the device mode when nothing is saved', () => {
    expect(boot({ dark: true }).attrs).toEqual({ 'data-theme-choice': 'system', 'data-theme': 'dark', 'data-palette': 'classic', 'data-density': 'comfortable' });
    expect(boot({ dark: false }).attrs['data-theme']).toBe('light');
  });

  it('reads the palette, mode and density of the saved copy', () => {
    const p = boot({ stored: saved({ theme: 'dark', density: 'compact', palette: 'harbor' }), dark: false });
    expect(p.attrs).toEqual({ 'data-theme-choice': 'dark', 'data-theme': 'dark', 'data-palette': 'harbor', 'data-density': 'compact' });
  });

  it('resolves System with the device and follows it, telling the app', () => {
    const p = boot({ stored: saved({ theme: 'system', palette: 'linen' }), dark: false });
    expect(p.attrs['data-theme']).toBe('light');
    p.setDevice(true);
    expect(p.attrs['data-theme']).toBe('dark');
    expect(p.events).toEqual(['mt-theme']);
  });

  it('does not follow the device once Light or Dark was chosen', () => {
    const p = boot({ stored: saved({ theme: 'light', palette: 'graphite' }), dark: false });
    p.setDevice(true);
    expect(p.attrs['data-theme']).toBe('light');
    expect(p.events).toEqual([]);
  });

  it('ignores a palette it does not know and a copy it cannot read', () => {
    expect(boot({ stored: saved({ palette: 'neon' }) }).attrs['data-palette']).toBe('classic');
    expect(boot({ stored: saved({ palette: '__proto__' }) }).attrs['data-palette']).toBe('classic');
    expect(boot({ stored: '{not json', dark: true }).attrs).toMatchObject({ 'data-palette': 'classic', 'data-theme': 'dark' });
    expect(boot({ storageThrows: true }).attrs['data-palette']).toBe('classic');
    expect(boot({ noMatchMedia: true }).attrs['data-theme']).toBe('light');
  });

  it('preloads the text face of the chosen palette and no other', () => {
    expect(boot({ stored: saved({ palette: 'linen' }) }).preloads).toEqual(['preload:font:/fonts/ibm-plex-sans-latin-400-normal.woff2']);
    expect(boot({ stored: saved({ palette: 'harbor' }) }).preloads).toEqual(['preload:font:/fonts/geist-latin-wght-normal.woff2']);
    expect(boot({ stored: saved({ palette: 'graphite' }) }).preloads).toEqual(['preload:font:/fonts/inter-latin.woff2']);
    expect(boot({}).preloads).toEqual(['preload:font:/fonts/inter-latin.woff2']);
  });

  it('keeps its font map equal to the palette data, and every file exists', () => {
    for (const id of Object.keys(TEXT_FACE_FILE)) expect(boot({ stored: saved({ palette: id }) }).preloads[0]).toBe(`preload:font:${TEXT_FACE_FILE[id as keyof typeof TEXT_FACE_FILE]}`);
    expect(THEMES.map((t: { id: string }) => t.id).sort()).toEqual(['graphite', 'harbor', 'linen']);
    for (const file of Object.values(TEXT_FACE_FILE) as string[]) expect(() => readFileSync(join(here, '..', 'public', file))).not.toThrow();
  });
});
