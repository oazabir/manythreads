import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { isAdmin, useSession } from '../app/session';
import { NewMeetingDialog } from '../meetings/NewMeetingDialog';
import { useShell } from './context';
import { AddIcon, CaretIcon, NEW_ICONS } from './icons';
import { MENU_SCOPE, onMenuKeys } from './menuNav';
import { NewChannelDialog } from './NewChannel';
import { newMenuFor, startsTier, type NewItem } from './newMenu';
import { useDismiss } from './useDismiss';

/**
 * The "New" button under the search box and the menu it pulls down (P38-07, owner request): every new thing the person can make, the likeliest first
 * (`newMenu.ts` holds the order and the permission rules). A row either leads to the screen that makes the thing, with a one-shot request in the address that
 * the screen answers by opening its own dialog or box (`useNewRequest`), or opens a dialog that needs no screen (a new channel, a new meeting) right here.
 * Arrow keys, Home and End move between the rows, Enter picks, Esc closes and puts focus back on the button.
 */
export function NewMenu() {
  const session = useSession();
  const { team, teamsLoading, guest } = useShell();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<'channel' | 'meeting' | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const admin = isAdmin(session);
  const items = useMemo(
    () => newMenuFor({ guest, admin, team: team ? { slug: team.slug, name: team.name, lead: team.myRole === 'lead', archived: Boolean(team.archivedAt) } : null }),
    [guest, admin, team],
  );
  // closing from inside the menu puts focus back on the button, so the keyboard carries on from where it was
  const close = (): void => {
    if (box.current?.contains(document.activeElement)) button.current?.focus();
    setOpen(false);
  };
  useDismiss(open, close, box);
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
  }, [open]);
  const closeDialog = (): void => {
    setDialog(null);
    window.setTimeout(() => button.current?.focus(), 0); // the row that opened it is gone: focus returns to the button
  };

  if (guest || teamsLoading || items.length === 0) return null;
  return (
    <div className="region new-menu" data-landmark="new-menu" ref={box}>
      <button
        ref={button}
        type="button"
        className="btn primary nm-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="new-menu-button"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <AddIcon />
        <span className="nm-btn-label">New</span>
        <span className="car nm-caret"><CaretIcon open /></span>
      </button>
      {open ? (
        <div className="menu nm-menu" role="menu" aria-label="New" data-testid="new-menu" ref={menu} {...{ [MENU_SCOPE]: '' }} onKeyDown={(e) => onMenuKeys(e, close)}>
          {items.map((item, i) => (
            <Fragment key={item.id}>
              {startsTier(items, i) ? <div className="menu-sep" role="separator" /> : null}
              <Row
                item={item}
                done={() => setOpen(false)}
                onDialog={(d) => {
                  setOpen(false);
                  setDialog(d);
                }}
              />
            </Fragment>
          ))}
        </div>
      ) : null}
      {dialog === 'channel' && team ? <NewChannelDialog slug={team.slug} onClose={closeDialog} /> : null}
      {dialog === 'meeting' ? <NewMeetingDialog onClose={closeDialog} /> : null}
    </div>
  );
}

function Row({ item, done, onDialog }: { item: NewItem; done: () => void; onDialog: (d: 'channel' | 'meeting') => void }) {
  const Icon = NEW_ICONS[item.icon];
  const body = (
    <>
      <span className="nm-ic"><Icon /></span>
      <span className="nm-text">
        <span className="nm-label">{item.label}</span>
        <span className="nm-hint">{item.hint}</span>
      </span>
    </>
  );
  const action = item.action;
  return action.kind === 'go' ? (
    <Link role="menuitem" className="menu-item nm-item" to={action.to} data-new={item.id} onClick={done}>
      {body}
    </Link>
  ) : (
    <button type="button" role="menuitem" className="menu-item nm-item" data-new={item.id} onClick={() => onDialog(action.dialog)}>
      {body}
    </button>
  );
}
