import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { AddIcon, ClipIcon } from '../shell/icons';
import { useMenuKeys } from '../shell/RowMenu';
import { useDismiss } from '../shell/useDismiss';
import { attachButtonWords, type AttachItem } from './composerAttach';

/*
 * The composer's Attach button and its menu (P36-09). The items come from composerAttach.ts, and so do the button's name and tooltip: "Attach" with a
 * paperclip when something can be attached here, "More" with a plus when the menu holds only emoji, Send later and formatting. The keys follow the menu
 * pattern (useMenuKeys): the menu opens with the focus on its first item, the arrows, Home and End move it, Enter or Space chooses, Esc closes it and the
 * focus goes back to the button, Tab closes it and the focus moves on to the next control. An item that cannot be used now stays in the menu, says why,
 * and does nothing when chosen. Choosing an item gives the focus back to the button first, so a file picker or a screen picker that is cancelled leaves
 * it there; what the item opens (a dialog, the emoji picker, the Send later times) takes it from there. `children` is drawn in the same place, for what an
 * item opens there; `sub` names that menu while it is open, so the button says it is expanded and which menu it controls.
 */

export function AttachMenu({ items, onChoose, hidden = false, buttonRef, sub, children }: {
  items: readonly AttachItem[];
  /** An item was chosen; the menu is already closed and the focus is on the button. */
  onChoose: (item: AttachItem) => void;
  hidden?: boolean;
  buttonRef: RefObject<HTMLButtonElement | null>;
  /** The id of a menu an item opened in the same place, while it is open. */
  sub?: string | null;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const close = (): void => {
    buttonRef.current?.focus();
    setOpen(false);
  };
  // a press on the button is inside: the button's own click closes the menu, it is not closed and opened again
  useDismiss(open, close, wrap);
  const keys = useMenuKeys(open, menu, close);
  // the box hides the button while a voice message is recorded: the menu goes with it
  useEffect(() => {
    if (hidden) setOpen(false);
  }, [hidden]);
  const words = attachButtonWords(items);
  const Glyph = words.label === 'Attach' ? ClipIcon : AddIcon;
  const expandedTo = open ? menuId : (sub ?? null);

  return (
    <span className="cam-wrap" ref={wrap} hidden={hidden}>
      <button
        ref={buttonRef}
        type="button"
        className="icon-btn clip"
        aria-label={words.label}
        title={words.title}
        aria-haspopup="menu"
        aria-expanded={expandedTo !== null}
        aria-controls={expandedTo ?? undefined}
        onClick={() => setOpen((o) => !o)}
        data-testid="composer-attach"
        data-kind={words.label === 'Attach' ? 'attach' : 'more'}
      >
        <Glyph />
      </button>
      {open ? (
        <div ref={menu} id={menuId} className="menu menu-up cam-menu" role="menu" aria-label={words.label} onKeyDown={keys} data-testid="composer-attach-menu">
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
                {...(it.expanded !== undefined ? { 'aria-expanded': it.expanded } : {})}
                aria-controls={it.controls}
                data-testid={it.entry.testId}
                onClick={() => {
                  if (it.blocked !== null) return;
                  close();
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
