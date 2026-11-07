/*
 * How the app looks for this person: the theme (System, Light or Dark) and the message density (Comfortable or Compact), P21-21.
 *
 * The server holds the choice (columns on the person, served in the session); this browser keeps a copy in localStorage["mt.appearance"] so
 * public/theme-boot.js can paint the right theme before the first frame. The boot script and `applyAppearance` write the same three attributes
 * on <html>: data-theme-choice (what was picked), data-theme (light or dark, what is drawn) and data-density. Colours come from tokens.css
 * and change with data-theme; no screen reads the theme itself.
 */

export type ThemeChoice = 'system' | 'light' | 'dark';
export type Density = 'comfortable' | 'compact';
export interface Appearance {
  theme: ThemeChoice;
  density: Density;
}

export const APPEARANCE_KEY = 'mt.appearance';
/** Fired on `window` after the drawn theme changed (a new choice, or the device switched while the choice is System). */
export const THEME_EVENT = 'mt-theme';
export const DEFAULT_APPEARANCE: Appearance = { theme: 'system', density: 'comfortable' };

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
    const { theme, density } = v as Record<string, unknown>;
    return {
      theme: theme === 'light' || theme === 'dark' || theme === 'system' ? theme : DEFAULT_APPEARANCE.theme,
      density: density === 'compact' ? 'compact' : 'comfortable',
    };
  } catch {
    return null;
  }
}

/** The things `applyAppearance` touches, so a test can hand in its own. The defaults are the real page. */
export interface AppearanceEnv {
  root: Pick<HTMLElement, 'setAttribute'>;
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  prefersDark: boolean;
  announce: () => void;
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
  };
}

export function readCachedAppearance(env: Pick<AppearanceEnv, 'storage'> = pageEnv()): Appearance | null {
  try {
    return parseAppearance(env.storage?.getItem(APPEARANCE_KEY) ?? null);
  } catch {
    return null;
  }
}

/** Draws the appearance now, keeps a copy for the next first paint and tells the parts that read a token's value (the tab icon). */
export function applyAppearance(a: Appearance, env: AppearanceEnv = pageEnv()): void {
  env.root.setAttribute('data-theme-choice', a.theme);
  env.root.setAttribute('data-theme', resolveTheme(a.theme, env.prefersDark));
  env.root.setAttribute('data-density', a.density);
  try {
    env.storage?.setItem(APPEARANCE_KEY, JSON.stringify({ theme: a.theme, density: a.density }));
  } catch {
    // a full or blocked storage only loses the first-paint copy
  }
  env.announce();
}
