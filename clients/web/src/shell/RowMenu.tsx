import { useRef, useState, useEffect, useSyncExternalStore, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useNavigate } from 'react-router';
import { leaveChannel } from '../api/endpoints';
import { markConversationRead } from '../app/readAll';
import { levelsStore } from '../notifications/levelsStore';
import { levelOf } from '../notifications/settingsModel';
import { sayToast } from '../kernel/toast';
import { MoreIcon } from './icons';
import { useDismiss } from './useDismiss';

/**
 * Arrow keys, Home and End move between the items of a menu; the first item gets focus when the menu opens; Tab closes the menu and carries on
 * from the button that opened it (a menu is one stop in the tab order, not a trap).
 */
export function useMenuKeys(open: boolean, menu: RefObject<HTMLElement | null>, close: () => void): (e: KeyboardEvent) => void {
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus();
  }, [open, menu]);
  return (e) => {
    if (e.key === 'Tab') {
      close();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };
}

/**
 * Closes an open menu when the sidebar around it is put away (the phone's drawer closing makes the sidebar inert): a menu left open there would
 * come back open, and report itself as expanded while nobody can reach it.
 */
export function useCloseWhenSidebarLeaves(open: boolean, box: RefObject<HTMLElement | null>, close: () => void): void {
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    const rail = open ? box.current?.closest('aside') : null;
    if (!rail) return;
    const watch = new MutationObserver(() => {
      if (rail.hasAttribute('inert')) closeRef.current();
    });
    watch.observe(rail, { attributes: true, attributeFilter: ['inert'] });
    return () => watch.disconnect();
  }, [open, box]);
}

export type RowConversation = { id: string; name: string | null; kind: 'channel' | 'dm'; label: string };

/**
 * The menu on a sidebar row (P21-08): Mute (or Unmute), Mark read, and Leave for a channel; the caller can add its own items first (the channel's
 * Star). The row itself is the child. Leave is left out for a direct message: the server has no way to leave one.
 */
export function RowMenu({ conv, slug, children, extra, testId, className = '', onOpenChange }: { conv: RowConversation; slug: string; children: ReactNode; extra?: (close: () => void) => ReactNode; testId?: string; className?: string; onOpenChange?: (open: boolean) => void }) {
  const [open, setOpenState] = useState(false);
  const setOpen = (v: boolean | ((o: boolean) => boolean)): void => {
    setOpenState((o) => {
      const next = typeof v === 'function' ? v(o) : v;
      onOpenChange?.(next);
      return next;
    });
  };
  const navigate = useNavigate();
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const levels = useSyncExternalStore(levelsStore.subscribe, levelsStore.snapshot).levels;
  const muted = levelOf(levels, conv.id, conv.kind).effective === 'nothing';
  const close = (): void => {
    if (panel.current?.contains(document.activeElement)) button.current?.focus();
    setOpen(false);
  };
  useDismiss(open, close, box);
  useCloseWhenSidebarLeaves(open, box, close);
  const keys = useMenuKeys(open, panel, close);
  const target = { channelId: conv.id, channelName: conv.kind === 'dm' ? null : conv.name, channelKind: conv.kind };
  const say = (text: string): void => {
    sayToast(text, { testId: 'row-menu-note' });
  };
  const mute = (): void => {
    close();
    levelsStore.setChannel(target, muted ? null : 'nothing').then(
      () => say(muted ? `${conv.label} is no longer muted.` : `${conv.label} is muted.`),
      (e: unknown) => say(e instanceof Error ? e.message : 'Could not save the setting. Try again.'),
    );
  };
  const markRead = (): void => {
    close();
    markConversationRead(conv.id).then(
      () => say(`${conv.label} marked as read.`),
      () => say('Could not mark it as read.'),
    );
  };
  const leave = (): void => {
    close();
    leaveChannel(conv.id).then(
      () => {
        say(`You left ${conv.label}.`);
        if (window.location.pathname.endsWith(`/c/${encodeURIComponent((conv.name ?? '').replace(/^#/, ''))}`)) void navigate(`/t/${encodeURIComponent(slug)}`);
      },
      () => say('Could not leave. Try again.'),
    );
  };
  return (
    <div className={`sb-row ${open ? 'sb-open' : ''} ${className}`} ref={box} data-sb-row={conv.id}>
      {children}
      <button
        type="button"
        ref={button}
        className="sb-more"
        aria-label={`Options for ${conv.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testId ?? 'row-menu'}
        onClick={() => setOpen((o) => !o)}
      >
        <MoreIcon />
      </button>
      {open ? (
        <div className="sb-menu" role="menu" aria-label={`Options for ${conv.label}`} ref={panel} onKeyDown={keys}>
          {extra?.(close)}
          <button type="button" role="menuitem" className="sb-item" data-testid="row-menu-mute" onClick={mute}>{muted ? 'Unmute' : 'Mute'}</button>
          <button type="button" role="menuitem" className="sb-item" data-testid="row-menu-read" onClick={markRead}>Mark read</button>
          {conv.kind === 'channel' ? <button type="button" role="menuitem" className="sb-item" data-testid="row-menu-leave" onClick={leave}>Leave channel</button> : null}
        </div>
      ) : null}
    </div>
  );
}
