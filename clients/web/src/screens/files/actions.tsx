import { useRef, useState, type ReactNode } from 'react';
import { usePanel } from '../../kernel/panel';
import { MoreIcon } from '../../shell/icons';
import { useDismiss } from '../../shell/useDismiss';
import { DeleteDialog, MoveDialog, PullRequestDialog, RenameDialog } from './dialogs';
import { READ_ONLY_COPY, type FileRow } from './model';
import type { TeamFiles } from './store';

export type RowAction = 'rename' | 'move' | 'delete' | 'pull-request';

export type ActionResult = { action: 'rename' | 'move'; from: string; to: string } | { action: 'delete'; from: string };

/** The dialogs behind a row's actions. The caller draws `dialog` anywhere and reacts to what was done in `onDone`. */
export function useRowActions(files: TeamFiles | null, opts: { folders?: () => string[]; onDone?: (result: ActionResult) => void } = {}): { start: (action: RowAction, row: FileRow) => void; dialog: ReactNode } {
  const [state, setState] = useState<{ action: RowAction; row: FileRow } | null>(null);
  const close = (): void => setState(null);
  let dialog: ReactNode = null;
  if (state && files) {
    const { action, row } = state;
    if (action === 'rename') dialog = <RenameDialog files={files} row={row} onClose={close} onDone={(to) => { close(); opts.onDone?.({ action: 'rename', from: row.path, to }); }} />;
    else if (action === 'move') dialog = <MoveDialog files={files} row={row} folders={opts.folders?.() ?? []} onClose={close} onDone={(to) => { close(); opts.onDone?.({ action: 'move', from: row.path, to }); }} />;
    else if (action === 'delete') dialog = <DeleteDialog files={files} row={row} onClose={close} onDone={() => { close(); opts.onDone?.({ action: 'delete', from: row.path }); }} />;
    else dialog = <PullRequestDialog path={row.path} onClose={close} />;
  }
  return { start: (action, row) => setState({ action, row }), dialog };
}

const withDownload = (url: string): string => `${url}${url.includes('?') ? '&' : '?'}download=1`;

/** What a person may do with a file, as menu items. `history` opens the History panel. */
export function RowMenu({ row, start, label }: { row: FileRow; start: (action: RowAction, row: FileRow) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const panel = usePanel();
  useDismiss(open, () => setOpen(false), box);
  if (row.kind !== 'file') return null;
  const git = row.store === 'git';
  const pr = row.readOnlyReason === 'change_by_pull_request';
  const item = (text: string, run: () => void, id: string) => (
    <button key={id} type="button" role="menuitem" className="menu-item" data-testid={`row-action-${id}`} onClick={() => { setOpen(false); run(); }}>{text}</button>
  );
  return (
    <div className="fmenu" ref={box} onClick={(e) => e.stopPropagation()}>
      <button type="button" className="icon-btn" aria-label={label ?? `Actions for ${row.name}`} aria-haspopup="menu" aria-expanded={open} data-testid="row-menu" onClick={() => setOpen((o) => !o)}>
        <MoreIcon />
      </button>
      {open ? (
        <div className="menu fpop" role="menu" aria-label={`${row.name} actions`}>
          {git ? item('History', () => panel.push({ type: 'history', id: row.path }), 'history') : null}
          {row.contentUrl ? (
            <a role="menuitem" className="menu-item" data-testid="row-action-download" href={withDownload(row.contentUrl)} download={row.name} onClick={() => setOpen(false)}>Download</a>
          ) : null}
          {git && !row.readOnly ? item('Rename', () => start('rename', row), 'rename') : null}
          {git && !row.readOnly ? item('Move', () => start('move', row), 'move') : null}
          {pr ? item(READ_ONLY_COPY, () => start('pull-request', row), 'pull-request') : null}
          {(git && !row.readOnly) || !git ? <div className="menu-sep" role="separator" /> : null}
          {(git && !row.readOnly) || !git ? item('Delete', () => start('delete', row), 'delete') : null}
        </div>
      ) : null}
    </div>
  );
}

