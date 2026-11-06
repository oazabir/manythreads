import { useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { MoreIcon } from '../../shell/icons';
import { useMenuKeys } from '../../shell/RowMenu';
import { useDismiss } from '../../shell/useDismiss';

export type MoreItem = { to: string; label: ReactNode; testId: string };

/**
 * A small "More" menu of links for a page header (P21-17): one button with `aria-haspopup="menu"`, a panel of menu items, Esc and a press
 * outside close it and give focus back, the arrow keys move between items. Used by the bots roster on a phone, where the secondary links
 * (Recipes, Proposals, Agents) would not fit beside the primary button.
 */
export function MoreMenu({ label, testId, items }: { label: string; testId: string; items: ReadonlyArray<MoreItem> }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = (): void => {
    if (panel.current?.contains(document.activeElement)) button.current?.focus();
    setOpen(false);
  };
  useDismiss(open, close, box);
  const keys = useMenuKeys(open, panel, close);
  return (
    <div className="b-more" ref={box}>
      <button type="button" ref={button} className="btn s b-more-btn" aria-haspopup="menu" aria-expanded={open} data-testid={testId} onClick={() => setOpen((o) => !o)}>
        <MoreIcon /> {label}
      </button>
      {open ? (
        <div className="menu b-more-pop" role="menu" aria-label={label} ref={panel} onKeyDown={keys}>
          {items.map((it) => (
            <Link key={it.testId} to={it.to} role="menuitem" className="menu-item" data-testid={it.testId} onClick={() => setOpen(false)}>{it.label}</Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
