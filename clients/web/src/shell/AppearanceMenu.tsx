import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router';
import type { Palette, ThemeChoice } from '@manythreads/shared';
import { useSession } from '../app/session';
import { MODE_OPTIONS, PALETTE_OPTIONS } from '../components/ThemePicker';
import { resolveTheme } from './appearance';
import { BackIcon, CheckIcon, NextIcon } from './icons';
import { MENU_SCOPE, itemsOf } from './menuNav';
import { useAppearanceChoice } from './useAppearanceChoice';
import { useDismiss } from './useDismiss';

/*
 * The Appearance entry of the account menu (P30-01): a row that opens a submenu with the four palettes and System / Light / Dark. A click draws the look at
 * once and saves it (the same `useAppearanceChoice` as Settings → Appearance); the menu stays open so several can be tried. On a wide screen the submenu is a
 * flyout beside the menu; on a phone it takes the menu's place, under a Back row. Looking at a choice (pointer over it, or focus on it) shows it on the
 * whole page and leaving puts the saved look back.
 */

const prefersDark = (): boolean => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;

/** A small round swatch of a palette in the mode that is drawn: its page colour with its accent as a dot. It carries data-palette and data-theme, so it reads that palette's own tokens. */
function Swatch({ palette, mode }: { palette: Palette; mode: 'light' | 'dark' }) {
  return <span className="am-sw" data-palette={palette} data-theme={mode} data-testid={`am-swatch-${palette}`} aria-hidden="true"><span className="am-sw-dot" /></span>;
}

function Option({ checked, label, onPick, onLook, onUnlook, testId, lead }: {
  checked: boolean;
  label: string;
  onPick: () => void;
  onLook: () => void;
  onUnlook: () => void;
  testId: string;
  lead?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      className="menu-item am-opt"
      data-testid={testId}
      onClick={onPick}
      onMouseEnter={onLook}
      onFocus={onLook}
      onMouseLeave={onUnlook}
    >
      {lead}
      <span className="am-label">{label}</span>
      {checked ? <span className="am-check" aria-hidden="true"><CheckIcon /></span> : null}
    </button>
  );
}

/**
 * The submenu's rows. `asMenu` is true for the flyout (a menu of its own, labelled Appearance); the phone's version is part of the account menu, so it has no
 * menu role of its own and starts with a Back row.
 */
export function AppearanceSub({ id, asMenu, onBack, done, scopeRef }: { id: string; asMenu: boolean; onBack: () => void; done: () => void; scopeRef: RefObject<HTMLDivElement | null> }) {
  const { current, error, pick, preview, endPreview } = useAppearanceChoice();
  const mode = resolveTheme(current.theme, prefersDark());
  const keys = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key !== 'ArrowLeft') return;
    e.preventDefault();
    e.stopPropagation();
    onBack();
  };
  return (
    <div
      id={id}
      ref={scopeRef}
      {...{ [MENU_SCOPE]: '' }}
      className={asMenu ? 'menu am-fly' : 'am-drill'}
      role={asMenu ? 'menu' : undefined}
      aria-label={asMenu ? 'Appearance' : undefined}
      onKeyDown={keys}
      data-testid="appearance-menu"
    >
      {asMenu ? null : (
        <>
          <button type="button" role="menuitem" className="menu-item am-back" data-testid="appearance-back" onClick={onBack}>
            <BackIcon />
            <span className="am-label">Appearance</span>
          </button>
          <div className="menu-sep" role="separator" />
        </>
      )}
      <div role="group" aria-label="Theme" onMouseLeave={endPreview}>
        <span className="menu-note am-head" aria-hidden="true">Theme</span>
        {PALETTE_OPTIONS.map((o) => (
          <Option
            key={o.value}
            checked={current.palette === o.value}
            label={o.label}
            testId={`appearance-palette-${o.value}`}
            lead={<Swatch palette={o.value} mode={mode} />}
            onPick={() => void pick({ palette: o.value })}
            onLook={() => o.value !== current.palette && preview({ palette: o.value })}
            onUnlook={endPreview}
          />
        ))}
      </div>
      <div className="menu-sep" role="separator" />
      <div role="group" aria-label="Light or dark" onMouseLeave={endPreview}>
        <span className="menu-note am-head" aria-hidden="true">Light or dark</span>
        {MODE_OPTIONS.map((o) => (
          <Option
            key={o.value}
            checked={current.theme === o.value}
            label={o.label}
            testId={`appearance-mode-${o.value}`}
            onPick={() => void pick({ theme: o.value as ThemeChoice })}
            onLook={() => o.value !== current.theme && preview({ theme: o.value })}
            onUnlook={endPreview}
          />
        ))}
      </div>
      {error ? <p className="menu-note am-error" role="alert" data-testid="appearance-menu-error">{error}</p> : null}
      <div className="menu-sep" role="separator" />
      <Link role="menuitem" className="menu-item" to="/account/appearance" data-testid="appearance-more" onClick={done} onFocus={endPreview}>More appearance settings…</Link>
    </div>
  );
}

/**
 * The Appearance row and its submenu. `open` lives in the account menu, which hides its own rows while a phone's drill-down is open; this part draws the
 * row (or, in the drill-down, the submenu in its place), places the flyout, takes focus in on open and gives it back to the row on close.
 */
export function AppearanceEntry({ open, setOpen, narrow, done, wrap }: { open: boolean; setOpen: (v: boolean) => void; narrow: boolean; done: () => void; wrap: RefObject<HTMLElement | null> }) {
  const current = useSession().person.appearance;
  const id = useId();
  const row = useRef<HTMLButtonElement>(null);
  const sub = useRef<HTMLDivElement>(null);
  const was = useRef(false);
  const back = (): void => setOpen(false);
  // Esc closes the submenu first, the menu on the next press; a press elsewhere in the menu closes the submenu too (the row and the flyout count as inside)
  useDismiss(open, back, wrap);

  // the flyout sits beside the menu, its bottom edge on the row's, pushed down when it would leave the top of the window
  useLayoutEffect(() => {
    const fly = sub.current;
    const anchor = row.current;
    if (!open || narrow || !fly || !anchor) return;
    const menu = anchor.closest<HTMLElement>('.menu')?.getBoundingClientRect();
    const at = anchor.getBoundingClientRect();
    const top = Math.max(8, Math.min(at.bottom - fly.offsetHeight, window.innerHeight - fly.offsetHeight - 8));
    fly.style.top = `${top}px`;
    fly.style.left = `${(menu?.right ?? at.right) + 6}px`;
  }, [open, narrow]);

  useEffect(() => {
    if (open && !was.current) {
      const items = sub.current ? itemsOf(sub.current) : [];
      (items.find((i) => i.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
    }
    if (!open && was.current) {
      const inside = document.activeElement;
      if (!inside || inside === document.body || wrap.current?.contains(inside)) row.current?.focus();
    }
    was.current = open;
  }, [open, wrap]);

  const panel = open ? <AppearanceSub id={id} asMenu={!narrow} onBack={back} done={done} scopeRef={sub} /> : null;
  if (narrow && open) return panel;
  const name = PALETTE_OPTIONS.find((o) => o.value === current.palette)?.label ?? '';
  return (
    <>
      <button
        ref={row}
        type="button"
        role="menuitem"
        className="menu-item am-row"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        data-testid="menu-appearance"
        onClick={() => setOpen(!open)}
      >
        <span className="am-label">Appearance</span>
        <span className="am-value">{name}</span>
        <span className="am-next" aria-hidden="true"><NextIcon /></span>
      </button>
      {panel}
    </>
  );
}
