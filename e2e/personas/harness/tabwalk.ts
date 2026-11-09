// Keyboard walk (PLAN P12-06 block B, used by the persona journeys' `tabwalk/` files): press Tab from the top of the page and record what takes focus.
import type { Page } from '@playwright/test';

export interface FocusStop {
  /** `data-testid` if the element has one, else its role or tag. */
  id: string;
  /** What a screen reader says: aria-label, else visible text, trimmed. */
  name: string;
  /** The element has a visible focus ring: an outline or a box-shadow that is not none. */
  ring: boolean;
}

/** What one Tab press left in focus, as read in the page. */
export interface FocusRead extends FocusStop {
  /** The focus is on the page itself (nothing took it): not a stop. */
  isBody: boolean;
}

/**
 * Presses Tab up to `max` times and returns the stops in order; stops early when focus comes back to the first stop or leaves the document twice in a row.
 * A stop's name is what a screen reader says: `aria-label`, else `aria-labelledby`, else the text of its `<label>` (`el.labels`: a date box wrapped in a label, an input with
 * `<label for>`; the control's own text is left out of a wrapping label), else its visible text. The page code uses nothing outside itself and no nested named function
 * (a bundler would wrap one in a helper the page does not have).
 */
export async function tabWalk(page: Page, options: { max?: number; from?: string } = {}): Promise<FocusStop[]> {
  const max = options.max ?? 60;
  await page.evaluate((from) => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
    const start = from ? document.querySelector<HTMLElement>(from) : null;
    if (start) start.focus();
    else {
      // Chromium starts the next Tab where the focus last was, even after blur() (the Chat screen focuses its message box at once, and the walk then reached one stop).
      // Put the starting point at the top of the page: focus a throw-away element there and remove it; the starting point stays where the element was.
      const probe = document.createElement('span');
      probe.tabIndex = -1;
      document.body.insertBefore(probe, document.body.firstChild);
      probe.focus();
      probe.remove();
    }
  }, options.from ?? null);
  const stops: FocusStop[] = [];
  let bodyInARow = 0;
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate((): FocusRead => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body || el === document.documentElement) return { id: '', name: '', ring: false, isBody: true };
      const cs = getComputedStyle(el);
      const id = el.getAttribute('data-testid') ?? el.getAttribute('role') ?? el.tagName.toLowerCase();
      let name = (el.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim();
      if (name === '') {
        name = (el.getAttribute('aria-labelledby') ?? '')
          .split(/\s+/)
          .map((ref) => document.getElementById(ref)?.textContent ?? '')
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
      }
      if (name === '') {
        const labels = (el as HTMLInputElement).labels;
        name = Array.from(labels ?? [])
          .map((label) => {
            const copy = label.cloneNode(true) as HTMLElement;
            copy.querySelectorAll('input, select, textarea, button').forEach((control) => control.remove());
            return copy.textContent ?? '';
          })
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
      }
      if (name === '') name = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none';
      return { id, name: name.slice(0, 60), ring, isBody: false };
    });
    if (stop.isBody) {
      // Tab left the page (the browser's own controls) or the page took the focus back: that is not a stop. Once is the wrap-around; twice in a row means nothing more is reachable.
      bodyInARow += 1;
      if (bodyInARow >= 2) break;
      continue;
    }
    bodyInARow = 0;
    if (stops.length > 0 && stops[0] && `${stop.id}|${stop.name}` === `${stops[0].id}|${stops[0].name}` && i > 1) break;
    stops.push({ id: stop.id, name: stop.name, ring: stop.ring });
  }
  return stops;
}

/** The problems of a walk: a stop with no name, a stop with no ring. Empty: fine. */
export function tabWalkProblems(stops: readonly FocusStop[]): string[] {
  const out: string[] = [];
  stops.forEach((s, i) => {
    if (s.name === '') out.push(`stop ${i + 1} (${s.id}) has no name for a screen reader`);
    if (!s.ring) out.push(`stop ${i + 1} (${s.id} "${s.name}") shows no focus ring`);
  });
  return out;
}
