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

/** Presses Tab up to `max` times and returns the stops in order; stops early when focus comes back to the first stop or leaves the document. */
export async function tabWalk(page: Page, options: { max?: number; from?: string } = {}): Promise<FocusStop[]> {
  const max = options.max ?? 60;
  await page.evaluate((from) => {
    (document.activeElement as HTMLElement | null)?.blur();
    const start = from ? document.querySelector<HTMLElement>(from) : null;
    if (start) start.focus();
    else window.scrollTo(0, 0);
  }, options.from ?? null);
  const stops: FocusStop[] = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate((): (FocusStop & { key: string }) | null => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const id = el.getAttribute('data-testid') ?? el.getAttribute('role') ?? el.tagName.toLowerCase();
      const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
      const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none';
      const path: string[] = [];
      for (let n: HTMLElement | null = el; n && path.length < 4; n = n.parentElement) path.push(n.tagName.toLowerCase() + (n.id ? `#${n.id}` : ''));
      return { id, name, ring, key: path.join('<') + name };
    });
    if (!stop) break;
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
