import { Fragment, useEffect, useMemo, useRef, useState, type DragEvent, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { friendlyName } from '../../components/friendlyPath';
import { usePanel } from '../../kernel/panel';
import { FolderIcon } from '../../shell/icons';
import { ContextMenu, historyId, rowEntries, type MenuEntry, type RowAction } from './actions';
import { DRAG_TYPE } from './dnd';
import { GridCard, ListRow, whereOf } from './FileItems';
import { GridViewIcon, ListViewIcon, SortDownIcon, SortUpIcon } from './icons';
import {
  MEMORY_COPY,
  READ_ONLY_COPY,
  SORT_LABELS,
  firstDir,
  isAppFolder,
  ROOT,
  matchesSource,
  matchesType,
  rowKey,
  segments,
  sortRowsBy,
  type FileRow,
  type FolderInfo,
  type Sort,
  type SortKey,
  type SourceFilter,
  type TypeFilter,
} from './model';
import { NONE, all as selectAll, only, prune, range, toggle, type Selection } from './selection';
import { personalPanelId } from './spaces';
import type { TeamFiles } from './store';
import type { FolderState } from './useFolders';

export { whenLabel } from './when';

export type Filters = { type: TypeFilter; source: SourceFilter };
export type View = 'list' | 'grid';

const TYPES: ReadonlyArray<{ id: TypeFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'images', label: 'Images' },
  { id: 'documents', label: 'Documents' },
  { id: 'code', label: 'Code' },
];
const SOURCES: ReadonlyArray<{ id: Exclude<SourceFilter, 'any'>; label: string }> = [
  { id: 'bots', label: 'From bots' },
  { id: 'people', label: 'From people' },
];
const COLUMNS: ReadonlyArray<SortKey> = ['name', 'where', 'by', 'modified', 'size'];

/** The id of a row in the right panel's `file:` entries: a Personal file by `~me/<path>`, a repo file by its path, an attachment by its file id. */
export const rowId = (row: FileRow): string => (row.store === 'personal' ? personalPanelId(row.path) : (row.fileId ?? row.path));

/** The choices of the sort drop-down (shown on a phone and in the grid, where there are no column headers). */
const SORT_CHOICES: ReadonlyArray<{ key: SortKey; dir: Sort['dir']; label: string }> = [
  { key: 'modified', dir: 'desc', label: 'Newest first' },
  { key: 'modified', dir: 'asc', label: 'Oldest first' },
  { key: 'name', dir: 'asc', label: 'Name, A to Z' },
  { key: 'name', dir: 'desc', label: 'Name, Z to A' },
  { key: 'size', dir: 'desc', label: 'Largest first' },
  { key: 'size', dir: 'asc', label: 'Smallest first' },
  { key: 'by', dir: 'asc', label: 'By, A to Z' },
  { key: 'where', dir: 'asc', label: 'Where, A to Z' },
];

/** What the list needs to move files by dragging. The screen owns the state; the list and the breadcrumb only report what happens. */
export type DragApi = {
  start: (row: FileRow) => void;
  end: () => void;
  /** Whether the drag in progress may land in this folder of the open space. */
  can: (path: string) => boolean;
  over: (path: string) => boolean;
  enter: (path: string) => void;
  leave: (path: string) => void;
  drop: (path: string) => void;
  /** Keys of the rows being dragged. */
  active: ReadonlySet<string>;
};

type Props = {
  files: TeamFiles;
  folder: string;
  info: FolderInfo | undefined;
  state: FolderState | undefined;
  /** The panel entry open in the right panel (see `rowId`). */
  current: string | null;
  filters: Filters;
  onFilters: (next: Filters) => void;
  sort: Sort;
  onSort: (next: Sort) => void;
  view: View;
  onView: (next: View) => void;
  sel: Selection;
  onSel: (next: Selection) => void;
  onFolder: (path: string) => void;
  onSelect: (row: FileRow) => void;
  onOpen: (row: FileRow) => void;
  onAction: (action: RowAction, row: FileRow) => void;
  onActionMany: (action: 'move' | 'delete', rows: FileRow[]) => void;
  /** Phone: the breadcrumb opens the folder sheet. */
  onBrowse?: (() => void) | undefined;
  /** The folder is an embedded app: its row of the list opens it in the centre. */
  onOpenApp: () => void;
  actions?: ReactNode;
  notice?: ReactNode;
  /** The bar at the foot of the list (the allowance of Personal). */
  footer?: ReactNode;
  drag: DragApi;
  /** What the right-click menu of the empty part of the list offers (New page, New folder, Upload). */
  emptyEntries: MenuEntry[];
  /** What to say in an empty folder. */
  emptyHint: string;
};

type Ctx = { at: { x: number; y: number }; rows: FileRow[] | null };

/** Breadcrumb, filters and the files of one folder, as a list or a grid. Files of every store look and behave the same. */
export function FileList(p: Props) {
  const { files, folder, info, state, sel, onSel, filters, onFilters, sort, onSort, view, onView, drag } = p;
  const panel = usePanel();
  const box = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [selecting, setSelecting] = useState(false);

  const parts = segments(folder);
  const listed = state?.listing?.rows;
  const everything = useMemo(() => listed ?? [], [listed]);
  const rows = useMemo(
    () => sortRowsBy(everything.filter((r) => matchesType(r, filters.type) && matchesSource(r, filters.source)), sort, whereOf),
    [everything, filters.type, filters.source, sort],
  );
  const keys = useMemo(() => rows.map(rowKey), [rows]);
  const loading = state === undefined || (state.status === 'loading' && !state.listing);
  const tabKey = cursor !== null && keys.includes(cursor) ? cursor : (keys[0] ?? null);
  const picked = rows.filter((r) => sel.keys.has(rowKey(r)));

  // a file that left the folder (moved, deleted, filtered out) is no longer selected
  const present = keys.join('\0');
  useEffect(() => {
    const next = prune(sel, keys);
    if (next !== sel) onSel(next);
    // `keys` follows `present`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [present]);

  const entriesOf = (row: FileRow): MenuEntry[] => rowEntries(row, files, { start: p.onAction, history: () => panel.push({ type: 'history', id: historyId(row) }) });
  const hasEntry = (row: FileRow, id: string): boolean => entriesOf(row).some((e) => e.id === id);
  const canMove = (list: FileRow[]): boolean => list.length > 0 && list.every((r) => hasEntry(r, 'move'));
  const canDelete = (list: FileRow[]): boolean => list.length > 0 && list.every((r) => hasEntry(r, 'delete'));

  // ---- focus ----
  const focusKey = (k: string): void => {
    setCursor(k);
    [...(box.current?.querySelectorAll<HTMLElement>('[data-row-key]') ?? [])].find((el) => el.dataset['rowKey'] === k)?.focus();
  };
  /** Cards in one line of the grid, from where they sit. */
  const columns = (): number => {
    const cards = [...(box.current?.querySelectorAll<HTMLElement>('.fcard') ?? [])];
    const top = cards[0]?.offsetTop;
    return Math.max(1, cards.filter((c) => c.offsetTop === top).length);
  };

  const activate = (row: FileRow): void => {
    if (row.kind === 'folder') p.onFolder(row.path);
    else p.onSelect(row);
  };

  // ---- the menu ----
  const openContext = (at: { x: number; y: number }, row: FileRow | null): void => {
    if (row === null) {
      onSel(NONE);
      setCtx({ at, rows: null });
      return;
    }
    const key = rowKey(row);
    const inSel = sel.keys.has(key);
    if (!inSel) onSel(only(key));
    setCtx({ at, rows: inSel ? picked : [row] });
  };
  const ctxEntries = (c: Ctx): MenuEntry[] => {
    if (c.rows === null) return p.emptyEntries;
    const list = c.rows;
    if (list.length === 1) {
      const row = list[0] as FileRow;
      const open: MenuEntry = { id: 'open', label: row.kind === 'folder' ? 'Open folder' : 'Preview', run: () => activate(row) };
      return [open, ...entriesOf(row)];
    }
    const out: MenuEntry[] = [];
    if (canMove(list)) out.push({ id: 'move', label: `Move ${list.length} items…`, run: () => p.onActionMany('move', list) });
    if (canDelete(list)) out.push({ id: 'delete', label: `Delete ${list.length} items`, danger: true, separatorBefore: out.length > 0, run: () => p.onActionMany('delete', list) });
    return out;
  };

  // ---- rows ----
  const dropProps = (path: string): HTMLAttributes<HTMLElement> => ({
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE) || !drag.can(path)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      drag.enter(path);
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      drag.leave(path);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE) || !drag.can(path)) return;
      e.preventDefault();
      e.stopPropagation();
      drag.drop(path);
    },
  });

  const handlersFor = (row: FileRow): HTMLAttributes<HTMLDivElement> => {
    const key = rowKey(row);
    const idx = keys.indexOf(key);
    const move = (e: KeyboardEvent, to: number, extend: boolean): void => {
      e.preventDefault();
      const next = keys[Math.max(0, Math.min(keys.length - 1, to))];
      if (next === undefined) return;
      focusKey(next);
      if (extend) onSel(range(sel.anchor === null ? { ...sel, anchor: key } : sel, keys, next));
    };
    return {
      onFocus: (e) => {
        if (e.target === e.currentTarget) setCursor(key);
      },
      onClick: (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest('[data-stop]')) return;
        setCursor(key);
        if (e.shiftKey) onSel(range(sel.anchor === null ? { ...sel, anchor: key } : sel, keys, key));
        else if (e.ctrlKey || e.metaKey) onSel(toggle(sel, key));
        else {
          if (sel.keys.size > 0) onSel(NONE);
          activate(row);
        }
      },
      onDoubleClick: (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest('[data-stop]')) return;
        if (row.kind === 'file') p.onOpen(row);
      },
      onContextMenu: (e: MouseEvent) => {
        e.preventDefault();
        openContext({ x: e.clientX, y: e.clientY }, row);
      },
      onKeyDown: (e: KeyboardEvent) => {
        if (e.target !== e.currentTarget) return;
        const grid = view === 'grid';
        const step = grid ? columns() : 1;
        if (e.key === 'ArrowDown') move(e, idx + step, e.shiftKey);
        else if (e.key === 'ArrowUp') move(e, idx - step, e.shiftKey);
        else if (grid && e.key === 'ArrowRight') move(e, idx + 1, e.shiftKey);
        else if (grid && e.key === 'ArrowLeft') move(e, idx - 1, e.shiftKey);
        else if (e.key === 'Home') move(e, 0, e.shiftKey);
        else if (e.key === 'End') move(e, keys.length - 1, e.shiftKey);
        else if (e.key === 'Enter') {
          e.preventDefault();
          if (e.ctrlKey || e.metaKey) p.onOpen(row);
          else activate(row);
        } else if (e.key === ' ') {
          e.preventDefault();
          onSel(toggle(sel, key));
        } else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          onSel(selectAll(keys));
        } else if (e.key === 'Escape' && sel.keys.size > 0) {
          e.preventDefault();
          onSel(NONE);
        } else if (e.key === 'Delete') {
          const list = sel.keys.has(key) ? picked : [row];
          if (canDelete(list)) {
            e.preventDefault();
            if (list.length > 1) p.onActionMany('delete', list);
            else p.onAction('delete', row);
          }
        } else if (e.key === 'F2' && hasEntry(row, 'rename')) {
          e.preventDefault();
          p.onAction('rename', row);
        } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          openContext({ x: r.left + 24, y: r.bottom - 4 }, row);
        }
      },
      onDragStart: (e: DragEvent) => {
        e.dataTransfer.setData(DRAG_TYPE, key);
        e.dataTransfer.effectAllowed = 'move';
        drag.start(row);
      },
      onDragEnd: () => drag.end(),
      ...(row.kind === 'folder' ? dropProps(row.path) : {}),
    };
  };

  const itemOf = (row: FileRow) => {
    const key = rowKey(row);
    const entries = entriesOf(row);
    return {
      row,
      files,
      current: row.kind === 'file' && p.current === rowId(row),
      checked: sel.keys.has(key),
      tabStop: key === tabKey,
      over: row.kind === 'folder' && drag.over(row.path),
      dragging: drag.active.has(key),
      draggable: row.kind === 'file' && entries.some((e) => e.id === 'move'),
      rkey: key,
      quick: entries.filter((e) => e.id === 'download' || e.id === 'rename' || e.id === 'share'),
      onCheck: (shift: boolean) => {
        setCursor(key);
        onSel(shift ? range(sel.anchor === null ? { ...sel, anchor: key } : sel, keys, key, true) : toggle(sel, key));
      },
      onAction: p.onAction,
      handlers: handlersFor(row),
    };
  };

  // ---- sorting ----
  const sortBy = (key: SortKey): void => onSort(sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: firstDir(key) });
  const allTicked = keys.length > 0 && keys.every((k) => sel.keys.has(k));
  const someTicked = sel.keys.size > 0 && !allTicked;

  const emptyContext = (e: MouseEvent): void => {
    if ((e.target as HTMLElement).closest('[data-row-key]')) return;
    e.preventDefault();
    openContext({ x: e.clientX, y: e.clientY }, null);
  };

  const showHead = view === 'list';
  const sorted = (key: SortKey): 'ascending' | 'descending' | 'none' => (sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');

  return (
    <div className={`flist ${view} ${selecting || sel.keys.size > 0 ? 'selecting' : ''}`} data-landmark="list" data-view={view}>
      <nav className="crumb" aria-label="Breadcrumb" data-testid="breadcrumb">
        {p.onBrowse ? (
          <button type="button" className="btn s browse" onClick={p.onBrowse} aria-label="Browse folders" data-testid="browse-folders">
            <FolderIcon />
          </button>
        ) : null}
        <span className="crumb-trail">
          {parts.length === 0 ? (
            <b aria-current="page">{files.teamName}</b>
          ) : (
            <button type="button" className={`crumb-link crumb-team ${drag.over(ROOT) ? 'drop' : ''}`} onClick={() => p.onFolder(ROOT)} {...dropProps(ROOT)}>{files.teamName}</button>
          )}
          {parts.map((part, i) => {
            const path = parts.slice(0, i + 1).join('/');
            const last = i === parts.length - 1;
            return (
              <Fragment key={path}>
                <span className={`crumb-sep ${i === 0 ? 'first' : ''}`} aria-hidden="true"> / </span>
                {last ? (
                  <b aria-current="page">{friendlyName(path, part)}</b>
                ) : (
                  <button type="button" className={`crumb-link ${drag.over(path) ? 'drop' : ''}`} onClick={() => p.onFolder(path)} {...dropProps(path)}>{friendlyName(path, part)}</button>
                )}
              </Fragment>
            );
          })}
        </span>
      </nav>
      {p.actions ? <div className="crumb-actions">{p.actions}</div> : null}
      {info?.managedBy === 'team_memory' ? (
        <p className="fnote memory" data-testid="memory-note" role="note">
          <b>{MEMORY_COPY}.</b> This is the team's memory as files. Edit a fact and the team remembers the change; delete it and the team forgets it.
        </p>
      ) : null}
      {info?.managedBy === 'personal_memory' ? (
        <p className="fnote memory" data-testid="memory-note" role="note">
          <b>Your memory.</b> This is what your assistant remembers about you, as files. Edit a fact and it remembers the change; delete it and it forgets it.
        </p>
      ) : null}
      {info?.readOnlyReason === 'change_by_pull_request' ? (
        <p className="fnote" data-testid="read-only-note" role="note">
          <b>{READ_ONLY_COPY}.</b> Files here are changed by a proposal: open a file and choose “Propose a change”. A team lead or workspace admin applies it.
        </p>
      ) : null}
      {isAppFolder(everything.map((r) => r.name)) ? (
        <p className="fnote" data-testid="app-note" role="note">
          <span><b>This folder is an app.</b> It runs in a sandbox and cannot read your session or other files.</span>
          <button type="button" className="btn s" data-testid="open-app" onClick={p.onOpenApp}>Open app</button>
        </p>
      ) : null}
      {p.notice}
      <div className="filt">
        <div className="filt-chips" role="toolbar" aria-label="Filter files">
          {TYPES.map((t) => (
            <button key={t.id} type="button" className={`chip ${filters.type === t.id ? 'on' : ''}`} aria-pressed={filters.type === t.id} onClick={() => onFilters({ ...filters, type: t.id })}>{t.label}</button>
          ))}
          <span className="filt-gap" />
          {SOURCES.map((s) => (
            <button key={s.id} type="button" className={`chip ${filters.source === s.id ? 'on' : ''}`} aria-pressed={filters.source === s.id} onClick={() => onFilters({ ...filters, source: filters.source === s.id ? 'any' : s.id })}>{s.label}</button>
          ))}
        </div>
        <div className="ftools">
          <select
            className="fsortsel"
            aria-label="Sort by"
            data-testid="sort-select"
            value={`${sort.key}:${sort.dir}`}
            onChange={(e) => {
              const [key, dir] = e.target.value.split(':') as [SortKey, Sort['dir']];
              onSort({ key, dir });
            }}
          >
            {SORT_CHOICES.map((c) => (
              <option key={`${c.key}:${c.dir}`} value={`${c.key}:${c.dir}`}>{c.label}</option>
            ))}
            {SORT_CHOICES.some((c) => c.key === sort.key && c.dir === sort.dir) ? null : <option value={`${sort.key}:${sort.dir}`}>{SORT_LABELS[sort.key]}</option>}
          </select>
          <button type="button" className="btn s fselect-toggle" aria-pressed={selecting} data-testid="select-mode" onClick={() => { setSelecting((s) => !s); if (selecting) onSel(NONE); }}>
            {selecting ? 'Done' : 'Select'}
          </button>
          <div className="fview-toggle" role="group" aria-label="View">
            <button type="button" className={`icon-btn ${view === 'list' ? 'on' : ''}`} aria-pressed={view === 'list'} aria-label="List view" title="List view" data-testid="view-list" onClick={() => onView('list')}><ListViewIcon /></button>
            <button type="button" className={`icon-btn ${view === 'grid' ? 'on' : ''}`} aria-pressed={view === 'grid'} aria-label="Grid view" title="Grid view" data-testid="view-grid" onClick={() => onView('grid')}><GridViewIcon /></button>
          </div>
        </div>
      </div>
      {picked.length > 0 ? (
        <div className="fsel" role="region" aria-label="Selected files" data-testid="selection-bar">
          <span className="fsel-count" aria-live="polite">{picked.length} selected</span>
          {canMove(picked) ? <button type="button" className="btn s" data-testid="selection-move" onClick={() => p.onActionMany('move', picked)}>Move…</button> : null}
          {canDelete(picked) ? <button type="button" className="btn s" data-testid="selection-delete" onClick={() => p.onActionMany('delete', picked)}>Delete</button> : null}
          <button type="button" className="btn s" data-testid="selection-clear" onClick={() => onSel(NONE)}>Clear</button>
        </div>
      ) : null}
      <div className="ftable" role={view === 'list' ? 'table' : undefined} aria-label="Files" data-testid="file-list" ref={box}>
        {showHead ? (
          <div className="frow hd" role="row">
            <div role="columnheader" className="fchk">
              <input
                type="checkbox"
                className="fcheck"
                aria-label="Select all"
                data-testid="select-all"
                checked={allTicked}
                ref={(el) => {
                  if (el) el.indeterminate = someTicked;
                }}
                disabled={keys.length === 0}
                onChange={() => onSel(allTicked ? NONE : selectAll(keys))}
              />
            </div>
            <div role="columnheader" aria-label="Type" />
            {COLUMNS.map((key) => (
              <div key={key} role="columnheader" aria-sort={sorted(key)} className={`hcol ${key}`}>
                <button type="button" className={`fsort ${sort.key === key ? 'on' : ''}`} data-testid={`sort-${key}`} onClick={() => sortBy(key)}>
                  {SORT_LABELS[key]}
                  {sort.key === key ? (sort.dir === 'asc' ? <SortUpIcon /> : <SortDownIcon />) : null}
                </button>
              </div>
            ))}
            <div role="columnheader" aria-label="Actions" />
          </div>
        ) : null}
        <div className="frows" role={view === 'list' ? 'rowgroup' : undefined} onContextMenu={emptyContext} onClick={(e) => { if (e.target === e.currentTarget && sel.keys.size > 0) onSel(NONE); }}>
          {loading ? (
            <p className="loading" aria-busy="true">Loading…</p>
          ) : state?.status === 'error' && !state.listing ? (
            <div className="fempty" role="alert" data-testid="files-error">
              <p className="view-empty-title">{state.code === 'forbidden' ? 'You do not have access to this folder.' : state.code === 'missing' ? 'This folder does not exist.' : 'The folder could not be loaded.'}</p>
              <p className="view-empty-body">{state.code === 'forbidden' ? 'Ask a team lead if you need it.' : state.message}</p>
            </div>
          ) : everything.length === 0 ? (
            <div className="fempty" data-testid="files-empty">
              <p className="view-empty-title">Nothing here yet.</p>
              <p className="view-empty-body">{p.emptyHint}</p>
            </div>
          ) : rows.length === 0 ? (
            <div className="fempty" data-testid="files-no-match">
              <p className="view-empty-title">No files match.</p>
              <button type="button" className="btn s" onClick={() => onFilters({ type: 'all', source: 'any' })}>Show all</button>
            </div>
          ) : view === 'list' ? (
            rows.map((row) => <ListRow key={row.path} {...itemOf(row)} />)
          ) : (
            <div className="fgrid" role="list" aria-label="Files">
              {rows.map((row) => <GridCard key={row.path} {...itemOf(row)} />)}
            </div>
          )}
        </div>
      </div>
      {p.footer}
      {ctx ? <ContextMenu at={ctx.at} entries={ctxEntries(ctx)} label={ctx.rows === null ? 'Folder actions' : 'File actions'} onClose={() => setCtx(null)} /> : null}
    </div>
  );
}
