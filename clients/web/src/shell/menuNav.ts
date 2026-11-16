import type { KeyboardEvent } from 'react';

/** The marker of a menu level: the account menu itself, and the Appearance submenu inside it, are each one scope; arrow keys stay inside the scope they start in. */
export const MENU_SCOPE = 'data-menu-scope';

const ITEM = '[role^="menuitem"]:not(:disabled)';

/** The items of one menu level, in order: those inside a submenu opened from it are not its own. */
export function itemsOf(scope: Element): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>(ITEM)].filter((el) => el.closest(`[${MENU_SCOPE}]`) === scope);
}

/**
 * The keys of the account menu and its submenu (P30-01). Up, Down, Home and End move between the items of the level that has focus; Right on an item that opens a
 * submenu opens it (or steps into it when it is open); Tab closes the menu and carries on from the button that opened it. Left, Esc and Enter belong to the submenu
 * itself and to the dismiss rules, not to this function.
 */
export function onMenuKeys(e: KeyboardEvent<HTMLElement>, close: () => void): void {
  if (e.key === 'Tab') {
    close();
    return;
  }
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (e.key === 'ArrowRight') {
    if (active?.getAttribute('aria-haspopup') !== 'menu') return;
    e.preventDefault();
    if (active.getAttribute('aria-expanded') !== 'true') {
      active.click();
      return;
    }
    const inner = document.getElementById(active.getAttribute('aria-controls') ?? '');
    (inner ? itemsOf(inner)[0] : undefined)?.focus();
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const scope = active?.closest<HTMLElement>(`[${MENU_SCOPE}]`) ?? e.currentTarget.querySelector<HTMLElement>(`[${MENU_SCOPE}]`);
  if (!scope) return;
  const items = itemsOf(scope);
  if (items.length === 0) return;
  e.preventDefault();
  const at = active ? items.indexOf(active) : -1;
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
  items[next]?.focus();
}
