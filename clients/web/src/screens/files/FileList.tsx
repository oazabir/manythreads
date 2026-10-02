import { Fragment } from 'react';
import { ago, clock, fileKind, fileSize } from '../../channels/format';
import { FolderIcon, LockIcon } from '../../shell/icons';
import { RowMenu, type RowAction } from './actions';
import {
  MEMORY_COPY,
  READ_ONLY_COPY,
  isAppFolder,
  ROOT,
  matchesSource,
  matchesType,
  segments,
  sortRows,
  type FileRow,
  type FolderInfo,
  type SourceFilter,
  type TypeFilter,
} from './model';
import type { FolderState } from './useFolders';

export type Filters = { type: TypeFilter; source: SourceFilter; order: 'recent' | 'name' };

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

/** Today as a clock time, this week as a weekday, older as a date (the list's When column). */
export function whenLabel(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? clock(iso) : ago(iso, now);
}

export const rowId = (row: FileRow): string => row.fileId ?? row.path;

function Icon({ row }: { row: FileRow }) {
  if (row.kind === 'folder') return <div className="fic dir" aria-hidden="true"><FolderIcon /></div>;
  const k = fileKind(row.name, row.mime ?? '');
  return <div className={`fic ${k.tone === 'file' ? '' : k.tone}`} aria-hidden="true">{k.label}</div>;
}

/** The "Where" cell: where an attachment came from, or the rule that holds for a row of the repo. */
function whereOf(row: FileRow): string {
  if (row.readOnlyReason === 'change_by_pull_request') return READ_ONLY_COPY;
  if (row.managedBy) return MEMORY_COPY;
  return row.where ?? '—';
}

type Props = {
  teamName: string;
  folder: string;
  info: FolderInfo | undefined;
  state: FolderState | undefined;
  selected: string | null;
  filters: Filters;
  onFilters: (next: Filters) => void;
  onFolder: (path: string) => void;
  onSelect: (row: FileRow) => void;
  onOpen: (row: FileRow) => void;
  onAction: (action: RowAction, row: FileRow) => void;
  /** Phone: the breadcrumb opens the folder sheet. */
  onBrowse?: (() => void) | undefined;
  /** The folder is an embedded app: its row of the list opens it in the centre. */
  onOpenApp: () => void;
  actions?: React.ReactNode;
  notice?: React.ReactNode;
  dropping: boolean;
};

/** Breadcrumb, filters and the file list of one folder. Folders and files of both stores look the same. */
export function FileList({ teamName, folder, info, state, selected, filters, onFilters, onFolder, onSelect, onOpen, onAction, onBrowse, onOpenApp, actions, notice, dropping }: Props) {
  const parts = segments(folder);
  const rows = state?.listing ? sortRows(state.listing.rows.filter((r) => matchesType(r, filters.type) && matchesSource(r, filters.source)), filters.order) : [];
  const all = state?.listing?.rows ?? [];
  const loading = state === undefined || (state.status === 'loading' && !state.listing);

  return (
    <div className={`flist ${dropping ? 'dropping' : ''}`} data-landmark="list">
      <nav className="crumb" aria-label="Breadcrumb" data-testid="breadcrumb">
        {onBrowse ? (
          <button type="button" className="btn s browse" onClick={onBrowse} aria-label="Browse folders" data-testid="browse-folders">
            <FolderIcon />
          </button>
        ) : null}
        <span className="crumb-trail">
          {parts.length === 0 ? (
            <b aria-current="page">{teamName}</b>
          ) : (
            <button type="button" className="crumb-link crumb-team" onClick={() => onFolder(ROOT)}>{teamName}</button>
          )}
          {parts.map((p, i) => {
            const path = parts.slice(0, i + 1).join('/');
            const last = i === parts.length - 1;
            return (
              <Fragment key={path}>
                <span className={`crumb-sep ${i === 0 ? 'first' : ''}`} aria-hidden="true"> / </span>
                {last ? <b aria-current="page">{p}</b> : <button type="button" className="crumb-link" onClick={() => onFolder(path)}>{p}</button>}
              </Fragment>
            );
          })}
        </span>
      </nav>
      {actions ? <div className="crumb-actions">{actions}</div> : null}
      {info?.managedBy ? (
        <p className="fnote memory" data-testid="memory-note" role="note">
          <b>{MEMORY_COPY}.</b> This is the team's memory as files. Edit a fact and the team remembers the change; delete it and the team forgets it.
        </p>
      ) : null}
      {info?.readOnlyReason === 'change_by_pull_request' ? (
        <p className="fnote" data-testid="read-only-note" role="note">
          <b>{READ_ONLY_COPY}.</b> Files here are changed by a pull request to the team repo, not from this screen.
        </p>
      ) : null}
      {isAppFolder(all.map((r) => r.name)) ? (
        <p className="fnote" data-testid="app-note" role="note">
          <span><b>This folder is an app.</b> It runs in a sandbox and cannot read your session or other files.</span>
          <button type="button" className="btn s" data-testid="open-app" onClick={onOpenApp}>Open app</button>
        </p>
      ) : null}
      {notice}
      <div className="filt" role="toolbar" aria-label="Filter files">
        {TYPES.map((t) => (
          <button key={t.id} type="button" className={`chip ${filters.type === t.id ? 'on' : ''}`} aria-pressed={filters.type === t.id} onClick={() => onFilters({ ...filters, type: t.id })}>{t.label}</button>
        ))}
        <span className="filt-gap" />
        {SOURCES.map((s) => (
          <button key={s.id} type="button" className={`chip ${filters.source === s.id ? 'on' : ''}`} aria-pressed={filters.source === s.id} onClick={() => onFilters({ ...filters, source: filters.source === s.id ? 'any' : s.id })}>{s.label}</button>
        ))}
        <button type="button" className="sortby" onClick={() => onFilters({ ...filters, order: filters.order === 'recent' ? 'name' : 'recent' })} aria-label={`Sort by ${filters.order === 'recent' ? 'name' : 'most recent'}`}>
          Sort: {filters.order}
        </button>
      </div>
      <div className="ftable" role="table" aria-label="Files" data-testid="file-list">
        <div className="frow hd" role="row">
          <div role="columnheader" aria-label="Type" />
          <div role="columnheader">Name</div>
          <div role="columnheader">Where</div>
          <div role="columnheader">By</div>
          <div role="columnheader">When</div>
          <div role="columnheader">Size</div>
          <div role="columnheader" aria-label="Actions" />
        </div>
        <div className="frows" data-vt-scroll>
          {loading ? (
            <p className="loading" aria-busy="true">Loading…</p>
          ) : state?.status === 'error' && !state.listing ? (
            <div className="fempty" role="alert" data-testid="files-error">
              <p className="view-empty-title">{state.code === 'forbidden' ? 'You do not have access to this folder.' : state.code === 'missing' ? 'This folder does not exist.' : 'The folder could not be loaded.'}</p>
              <p className="view-empty-body">{state.code === 'forbidden' ? 'Ask a team lead if you need it.' : state.message}</p>
            </div>
          ) : all.length === 0 ? (
            <div className="fempty" data-testid="files-empty">
              <p className="view-empty-title">Nothing here yet.</p>
              <p className="view-empty-body">
                {info?.store === 'attachments' && folder !== 'channels'
                  ? 'Files posted in this channel show up here. Upload one to add it.'
                  : folder === 'channels'
                    ? 'A folder appears here for each channel you can read.'
                    : 'Create a page or a folder, or upload a text file.'}
              </p>
            </div>
          ) : rows.length === 0 ? (
            <div className="fempty" data-testid="files-no-match">
              <p className="view-empty-title">No files match.</p>
              <button type="button" className="btn s" onClick={() => onFilters({ ...filters, type: 'all', source: 'any' })}>Show all</button>
            </div>
          ) : (
            rows.map((row) => {
              const id = rowId(row);
              const on = row.kind === 'file' && selected === id;
              return (
                <div
                  key={row.path}
                  role="row"
                  tabIndex={0}
                  aria-selected={on}
                  className={`frow ${on ? 'on' : ''}`}
                  data-testid="file-row"
                  data-path={row.path}
                  data-kind={row.kind}
                  data-store={row.store}
                  onClick={() => (row.kind === 'folder' ? onFolder(row.path) : onSelect(row))}
                  onDoubleClick={() => row.kind === 'file' && onOpen(row)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      if (row.kind === 'folder') onFolder(row.path);
                      else onSelect(row);
                    }
                  }}
                >
                  <div role="cell"><Icon row={row} /></div>
                  <div role="cell" className="fname">
                    <span className="fname-text">{row.kind === 'folder' ? `${row.name}/` : row.name}</span>
                    {row.readOnlyReason === 'change_by_pull_request' ? <span className="flock" title={READ_ONLY_COPY}><LockIcon /></span> : null}
                  </div>
                  <div role="cell" className="src">{whereOf(row)}</div>
                  <div role="cell" className="src" data-vt-mask>
                    {row.by ? <span className="by">{row.by.name}</span> : '—'}
                  </div>
                  <div role="cell" className="src" data-vt-mask>{whenLabel(row.modifiedAt)}</div>
                  <div role="cell" className="sz">{row.size === null ? '—' : fileSize(row.size)}</div>
                  <div role="cell" className="fact"><RowMenu row={row} start={onAction} /></div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

