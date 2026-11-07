import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { PERSONAL_SEED_FOLDERS } from '@manythreads/shared';
import { usePanel } from '../../kernel/panel';
import { MoreIcon } from '../../shell/icons';
import { useDismiss } from '../../shell/useDismiss';
import { DeleteDialog, MoveDialog, ProposeChangeDialog, RenameDialog, ShareDialog } from './dialogs';
import type { FileRow } from './model';
import { personalPanelId } from './spaces';
import type { TeamFiles } from './store';

export type RowAction = 'rename' | 'move' | 'delete' | 'pull-request' | 'share';

export type ActionResult =
  | { action: 'rename'; from: string; to: string }
  | { action: 'move'; from: string; to: string }
  | { action: 'delete'; from: string }
  /** Several rows moved or deleted at once (the selection bar, a drop on a folder). */
  | { action: 'move-many'; count: number; paths: string[] }
  | { action: 'delete-many'; count: number; paths: string[] };

type Dialog = { action: RowAction; rows: FileRow[] };

/** The dialogs behind a row's actions. The caller draws `dialog` anywhere and reacts to what was done in `onDone`. */
export function useRowActions(
  files: TeamFiles | null,
  opts: { folders?: () => string[]; onDone?: (result: ActionResult) => void } = {},
): { start: (action: RowAction, row: FileRow) => void; startMany: (action: 'move' | 'delete', rows: FileRow[]) => void; dialog: ReactNode } {
  const [state, setState] = useState<Dialog | null>(null);
  const close = (): void => setState(null);
  let dialog: ReactNode = null;
  if (state && files) {
    const { action, rows } = state;
    const row = rows[0] as FileRow;
    const many = rows.length > 1;
    if (action === 'rename') dialog = <RenameDialog files={files} row={row} onClose={close} onDone={(to) => { close(); opts.onDone?.({ action: 'rename', from: row.path, to }); }} />;
    else if (action === 'move') {
      dialog = (
        <MoveDialog
          files={files}
          rows={rows}
          folders={opts.folders?.() ?? []}
          onClose={close}
          onDone={(to) => { close(); opts.onDone?.(many ? { action: 'move-many', count: rows.length, paths: rows.map((r) => r.path) } : { action: 'move', from: row.path, to: to[0] ?? row.path }); }}
        />
      );
    } else if (action === 'delete') {
      dialog = <DeleteDialog files={files} rows={rows} onClose={close} onDone={() => { close(); opts.onDone?.(many ? { action: 'delete-many', count: rows.length, paths: rows.map((r) => r.path) } : { action: 'delete', from: row.path }); }} />;
    } else if (action === 'share') dialog = <ShareDialog files={files} row={row} onClose={close} />;
    else dialog = <ProposeChangeDialog path={row.path} onClose={close} />;
  }
  return { start: (action, row) => setState({ action, rows: [row] }), startMany: (action, rows) => rows.length > 0 && setState({ action, rows }), dialog };
}

const withDownload = (url: string): string => `${url}${url.includes('?') ? '&' : '?'}download=1`;

/** One line of a row's menu: a button, or a link for Download. */
export type MenuEntry = { id: string; label: string; run?: () => void; href?: string; download?: string; danger?: boolean; separatorBefore?: boolean };

const isSeed = (row: FileRow): boolean => row.kind === 'folder' && (PERSONAL_SEED_FOLDERS as readonly string[]).includes(row.path);

/** Whether the store lets the person change this row (a rename, a move, a delete). */
export function canChange(row: FileRow): boolean {
  if (row.store === 'attachments') return true;
  return !row.readOnly;
}

/** What a person may do with a row, as menu entries; the dropdown, the right-click menu and the hover buttons draw the same list. */
export function rowEntries(row: FileRow, files: TeamFiles, act: { start: (action: RowAction, row: FileRow) => void; history: () => void }): MenuEntry[] {
  const out: MenuEntry[] = [];
  const personal = row.store === 'personal';
  const git = row.store === 'git';
  if (row.kind === 'folder') {
    if (personal && !row.readOnly && !isSeed(row) && row.managedBy === null) out.push({ id: 'delete', label: 'Delete folder', run: () => act.start('delete', row), danger: true });
    return out;
  }
  const pr = row.readOnlyReason === 'change_by_pull_request';
  // an admin's look into someone's space has no history of its own: the panel would open the admin's own file of the same path
  if ((git || personal) && row.readOnlyReason !== 'admin_view') out.push({ id: 'history', label: personal ? 'Version history' : 'History', run: act.history });
  if (row.contentUrl) out.push({ id: 'download', label: 'Download', href: withDownload(row.contentUrl), download: row.name });
  if ((git || personal) && !row.readOnly) {
    out.push({ id: 'rename', label: 'Rename', run: () => act.start('rename', row) });
    out.push({ id: 'move', label: 'Move', run: () => act.start('move', row) });
  }
  if (personal && !row.readOnly && files.personal) out.push({ id: 'share', label: 'Send to a team…', run: () => act.start('share', row) });
  if (pr) out.push({ id: 'pull-request', label: 'Propose a change', run: () => act.start('pull-request', row) });
  if (canChange(row) && (git || personal || row.store === 'attachments')) out.push({ id: 'delete', label: 'Delete', run: () => act.start('delete', row), danger: true, separatorBefore: true });
  return out;
}

/** The panel entry that opens a row's history: a repo file by path, a Personal file as `~me/<path>`. */
export const historyId = (row: FileRow): string => (row.store === 'personal' ? personalPanelId(row.path) : row.path);

/** Menu entries as buttons; Up and Down move between them, Home and End jump, a letter does nothing. Focus starts on the first. */
function MenuItems({ entries, onPick, onLeave, label }: { entries: MenuEntry[]; onPick: () => void; onLeave?: () => void; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, []);
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const items = [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number): void => {
      e.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    // Tab leaves the menu: it closes and focus goes back to where it came from, and Tab then moves on from there
    else if (e.key === 'Tab') onLeave?.();
  };
  return (
    <div className="menu fpop" role="menu" aria-label={label} ref={box} onKeyDown={onKey}>
      {entries.map((m) => (
        <div key={m.id} role="none">
          {m.separatorBefore ? <div className="menu-sep" role="separator" /> : null}
          {m.href ? (
            <a role="menuitem" className="menu-item" data-testid={`row-action-${m.id}`} href={m.href} download={m.download} onClick={onPick}>{m.label}</a>
          ) : (
            <button type="button" role="menuitem" className={`menu-item ${m.danger ? 'danger' : ''}`} data-testid={`row-action-${m.id}`} onClick={() => { onPick(); m.run?.(); }}>{m.label}</button>
          )}
        </div>
      ))}
    </div>
  );
}

/** What a person may do with a file, as a drop-down from the ⋯ button. */
export function RowMenu({ row, files, start, label }: { row: FileRow; files: TeamFiles; start: (action: RowAction, row: FileRow) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = usePanel();
  useDismiss(open, () => setOpen(false), box);
  const entries = rowEntries(row, files, { start, history: () => panel.push({ type: 'history', id: historyId(row) }) });
  if (entries.length === 0) return null;
  const closeAndReturn = (): void => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div className="fmenu" ref={box} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape' && open) closeAndReturn(); }}>
      <button ref={trigger} type="button" className="icon-btn" aria-label={label ?? `Actions for ${row.name}`} aria-haspopup="menu" aria-expanded={open} data-testid="row-menu" onClick={() => setOpen((o) => !o)}>
        <MoreIcon />
      </button>
      {open ? <MenuItems entries={entries} onPick={() => setOpen(false)} onLeave={closeAndReturn} label={`${row.name} actions`} /> : null}
    </div>
  );
}

/** The right-click (and Menu key) menu of a row or of the empty part of the list, drawn at the pointer. */
export function ContextMenu({ at, entries, label, onClose }: { at: { x: number; y: number }; entries: MenuEntry[]; label: string; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useDismiss(true, onClose, box);
  // keep the menu inside the window
  const [shift, setShift] = useState({ x: 0, y: 0 });
  useEffect(() => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setShift({ x: Math.min(0, window.innerWidth - 8 - (at.x + r.width)), y: Math.min(0, window.innerHeight - 8 - (at.y + r.height)) });
  }, [at.x, at.y, entries.length]);
  if (entries.length === 0) return null;
  return (
    <div ref={box} className="fctx" style={{ left: at.x + shift.x, top: at.y + shift.y }} data-testid="context-menu" onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      <MenuItems entries={entries} onPick={onClose} onLeave={onClose} label={label} />
    </div>
  );
}
