import { THEME_EVENT } from './appearance';
import type { FaviconState } from './tabState';

/*
 * Draws the tab icon: the static /favicon.svg mark, with a dot in the alert colour when something waits. The colour is read from the
 * design token on the page, so there is no colour value in code. Where canvas is unavailable the plain icon stays.
 */

const SIZE = 64;
let base: HTMLImageElement | null = null;
let baseHref: string | null = null;
let lastState: FaviconState | null = null;

function link(): HTMLLinkElement | null {
  if (typeof document === 'undefined') return null;
  return document.getElementById('favicon') as HTMLLinkElement | null;
}

function loadBase(href: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (base && baseHref === href) return resolve(base);
    const img = new Image();
    img.onload = () => {
      base = img;
      baseHref = href;
      resolve(img);
    };
    img.onerror = () => reject(new Error('favicon failed to load'));
    img.src = href;
  });
}

export async function drawFavicon(state: FaviconState): Promise<void> {
  lastState = state;
  const el = link();
  if (!el) return;
  const plain = el.dataset['plain'] ?? el.getAttribute('href') ?? '/favicon.svg';
  el.dataset['plain'] = plain;
  if (!state.dot) {
    el.setAttribute('href', plain);
    return;
  }
  try {
    const img = await loadBase(plain);
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, SIZE, SIZE);
    const colour = getComputedStyle(document.documentElement).getPropertyValue('--alert').trim();
    ctx.beginPath();
    ctx.arc(SIZE - 16, 16, 15, 0, Math.PI * 2);
    ctx.fillStyle = colour || 'currentcolor';
    ctx.fill();
    el.setAttribute('href', canvas.toDataURL('image/png'));
  } catch {
    el.setAttribute('href', plain);
  }
}

// the dot's colour is the alert token of the theme that is drawn, so it is read again when the theme changes
if (typeof window !== 'undefined') {
  window.addEventListener(THEME_EVENT, () => {
    if (lastState?.dot) void drawFavicon(lastState);
  });
}
