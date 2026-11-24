import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { ClipIcon } from '../shell/icons';
import { useDismiss } from '../shell/useDismiss';
import type { AttachItem } from './composerAttach';

/*
 * The composer's Attach button and its menu (P36-09). The items come from composerAttach.ts. The keys follow the menu pattern: the menu opens with the
 * focus on its first item, the arrows, Home and End move it, Enter or Space chooses, Esc or Tab closes it and the focus goes back to the button. An item
 * that cannot be used now stays in the menu, says why, and does nothing when chosen. `children` is drawn in the same place, for what an item opens
 * there (the Send later times open where the menu was).
 */

export function AttachMenu({ items, onChoose, hidden = false, buttonRef, children }: {
  items: readonly AttachItem[];
  /** An item was chosen; the menu is already closed. */
  onChoose: (item: AttachItem) => void;
  hidden?: boolean;
  buttonRef: RefObject<HTMLButtonElement | null>;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const close = (focus = true): void => {
    setOpen(false);
    if (focus) buttonRef.current?.focus();
  };
  // a press on the button is inside: the button's own click closes the menu, it is not closed and opened again
  useDismiss(open, close, wrap);
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);
  // the box hides the button while a voice message is recorded: the menu goes with it
  useEffect(() => {
    if (hidden) setOpen(false);
  }, [hidden]);

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Tab') {
      // Tab leaves the menu: it closes, and the focus moves on from the button
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const list = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    if (list.length === 0) return;
    e.preventDefault();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
    list[to]?.focus();
  };

  return (
    <span className="cam-wrap" ref={wrap} hidden={hidden}>
      <button
        ref={buttonRef}
        type="button"
        className="icon-btn clip"
        aria-label="Attach"
        title="Attach a file, a screenshot, a poll and more"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        data-testid="composer-attach"
      >
        <ClipIcon />
      </button>
      {open ? (
        <div ref={menu} id={menuId} className="menu menu-up cam-menu" role="menu" aria-label="Attach" onKeyDown={onMenuKey} data-testid="composer-attach-menu">
          {items.map((it) => {
            const Icon = it.entry.Icon;
            return (
              <button
                key={it.entry.id}
                type="button"
                role="menuitem"
                className="menu-item cam-item"
                aria-disabled={it.blocked !== null || undefined}
                aria-haspopup={it.entry.opens}
                data-testid={it.entry.testId}
                onClick={() => {
                  if (it.blocked !== null) return;
                  // an item that opens a dialog or a picker takes the focus itself; the others give it back to the button
                  close(it.entry.opens === undefined);
                  onChoose(it);
                }}
              >
                <span className="cam-ic" aria-hidden="true"><Icon /></span>
                <span className="cam-text">
                  <span className="cam-label">{it.label}</span>
                  <small className="cam-hint">{it.hint}</small>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      {children}
    </span>
  );
}
