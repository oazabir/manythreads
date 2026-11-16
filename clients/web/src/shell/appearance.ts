/*
 * How the app looks for this person: the palette (Classic, Graphite, Linen or Harbor, P28), the mode (System, Light or Dark) and the message
 * density (Comfortable or Compact), P21-21.
 *
 * The server holds the choice (columns on the person, served in the session); this browser keeps a copy in localStorage["mt.appearance"] so
 * public/theme-boot.js can paint the right look before the first frame. The boot script and `applyAppearance` write the same four attributes
 * on <html>: data-theme-choice (what was picked), data-theme (light or dark, what is drawn), data-palette and data-density. Colours come from
 * tokens.css and styles/themes/*.css and change with those attributes; no screen reads the theme itself.
 */

import { DEFAULT_APPEARANCE, Palette, type Appearance, type ThemeChoice } from '@manythreads/shared';

// The type and its default live in @manythreads/shared (entities/appearance.ts): the server stores and serves the same shape.
export { DEFAULT_APPEARANCE };
export type { Appearance, Density, ThemeChoice } from '@manythreads/shared';
export type { Palette } from '@manythreads/shared';

export const APPEARANCE_KEY = 'mt.appearance';
/** Fired on `window` after the drawn theme changed (a new choice, or the device switched while the choice is System). */
export const THEME_EVENT = 'mt-theme';

/** What is drawn for a choice: Light and Dark are themselves, System follows the device. */
export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): 'light' | 'dark' {
  if (choice === 'light' || choice === 'dark') return choice;
  return prefersDark ? 'dark' : 'light';
}

/** The cached text read back as an appearance; anything that is not one gives null (a missing or damaged cache is not an error). */
export function parseAppearance(raw: string | null): Appearance | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return null;
    const { theme, density, palette } = v as Record<string, unknown>;
    const knownPalette = Palette.safeParse(palette);
    return {
      theme: theme === 'light' || theme === 'dark' || theme === 'system' ? theme : DEFAULT_APPEARANCE.theme,
      density: density === 'compact' ? 'compact' : 'comfortable',
      palette: knownPalette.success ? knownPalette.data : DEFAULT_APPEARANCE.palette,
    };
  } catch {
    return null;
  }
}

/** The things `applyAppearance` touches, so a test can hand in its own. The defaults are the real page. */
export interface AppearanceEnv {
  root: Pick<HTMLElement, 'setAttribute' | 'removeAttribute'>;
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  prefersDark: boolean;
  announce: () => void;
  /** Runs `fn` on the next frame; the page's own implementation is requestAnimationFrame, a test runs it at once. */
  later: (fn: () => void) => void;
  /** The colour of the sidebar as drawn now (`--shell`), or null when it cannot be read; it becomes the phone browser bar's colour. */
  shellColour: () => string | null;
  /** Writes `<meta name="theme-color">`. */
  setThemeColour: (colour: string) => void;
}

function pageEnv(): AppearanceEnv {
  let storage: Storage | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null; // blocked storage: the choice still applies to this page view
  }
  return {
    root: document.documentElement,
    storage,
    prefersDark: typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches,
    announce: () => window.dispatchEvent(new Event(THEME_EVENT)),
    later: (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => fn()) : setTimeout(fn, 16)),
    shellColour: () => getComputedStyle(document.documentElement).getPropertyValue('--shell').trim() || null,
    setThemeColour: (colour) => {
      let meta = document.querySelector('meta[name="theme-color"]');
      if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute('name', 'theme-color');
        document.head.appendChild(meta);
      }
      meta.setAttribute('content', colour);
    },
  };
}

export function readCachedAppearance(env: Pick<AppearanceEnv, 'storage'> = pageEnv()): Appearance | null {
  try {
    return parseAppearance(env.storage?.getItem(APPEARANCE_KEY) ?? null);
  } catch {
    return null;
  }
}

/** Makes the browser bar (and the Capacitor status bar) the colour of the sidebar in the look that is drawn now. */
export function syncThemeColour(env: Pick<AppearanceEnv, 'shellColour' | 'setThemeColour'> = pageEnv()): void {
  const colour = env.shellColour();
  if (colour) env.setThemeColour(colour);
}

/**
 * Draws the appearance now, keeps a copy for the next first paint and tells the parts that read a token's value (the tab icon).
 * For one frame the page carries `data-look-switching`, which switches every transition off (motion.css), so a switch is one change and not a fade of
 * every colour at once.
 */
export function applyAppearance(a: Appearance, env: AppearanceEnv = pageEnv()): void {
  env.root.setAttribute('data-look-switching', '');
  env.root.setAttribute('data-theme-choice', a.theme);
  env.root.setAttribute('data-theme', resolveTheme(a.theme, env.prefersDark));
  env.root.setAttribute('data-palette', a.palette);
  env.root.setAttribute('data-density', a.density);
  try {
    env.storage?.setItem(APPEARANCE_KEY, JSON.stringify({ theme: a.theme, density: a.density, palette: a.palette }));
  } catch {
    // a full or blocked storage only loses the first-paint copy
  }
  syncThemeColour(env);
  env.announce();
  env.later(() => env.root.removeAttribute('data-look-switching'));
}

/**
 * Draws an appearance to look at, and keeps nothing: the same attributes as `applyAppearance`, but the first-paint copy in localStorage is left as it is, so a
 * page that closes in the middle of a preview comes back as the saved look. Drawing the saved appearance again with this undoes a preview.
 */
export function previewAppearance(a: Appearance, env: AppearanceEnv = pageEnv()): void {
  applyAppearance(a, { ...env, storage: null });
}
