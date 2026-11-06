import { useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { MoreIcon } from '../../shell/icons';
import { useMenuKeys } from '../../shell/RowMenu';
import { useDismiss } from '../../shell/useDismiss';

/** A link item (`to`) or an action item (`onSelect`, e.g. Test); the label says what an action will do now (a switched-on action reads "Hide the test"). */
export type MoreItem = { label: ReactNode; testId: string } & ({ to: string; onSelect?: undefined } | { to?: undefined; onSelect: () => void });

/**
 * A small "More" menu of links for a page header (P21-17): one button with `aria-haspopup="menu"`, a panel of menu items, Esc and a press
 * outside close it and give focus back, the arrow keys move between items. Used by the bots roster on a phone, where the secondary links
 * (Recipes, Proposals, Agents) would not fit beside the primary button, and by the bot page, whose "…" (`compact`: the icon alone, named by `label`)
 * holds Test, Change picture and the links to the other bot screens. An item is a link or an action; choosing an action gives focus back to the button.
 */
export function MoreMenu({ label, testId, items, compact = false }: { label: string; testId: string; items: ReadonlyArray<MoreItem>; compact?: boolean }) {
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
      <button type="button" ref={button} className="btn s b-more-btn" aria-haspopup="menu" aria-expanded={open} aria-label={compact ? label : undefined} title={compact ? label : undefined} data-testid={testId} onClick={() => setOpen((o) => !o)}>
        <MoreIcon />{compact ? null : <> {label}</>}
      </button>
      {open ? (
        <div className="menu b-more-pop" role="menu" aria-label={label} ref={panel} onKeyDown={keys}>
          {items.map((it) =>
            it.to !== undefined ? (
              <Link key={it.testId} to={it.to} role="menuitem" className="menu-item" data-testid={it.testId} onClick={() => setOpen(false)}>{it.label}</Link>
            ) : (
              <button
                key={it.testId}
                type="button"
                role="menuitem"
                className="menu-item"
                data-testid={it.testId}
                onClick={() => {
                  close();
                  it.onSelect();
                }}
              >
                {it.label}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
