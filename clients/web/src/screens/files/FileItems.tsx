import type { HTMLAttributes, ReactNode } from 'react';
import { fileKind, fileSize } from '../../channels/format';
import { friendlyName } from '../../components/friendlyPath';
import { Avatar } from '../../components/ui';
import { FolderIcon } from '../../shell/icons';
import { RowMenu, type MenuEntry, type RowAction } from './actions';
import { DownloadIcon, RenameIcon, SendToTeamIcon } from './icons';
import { MEMORY_COPY, READ_ONLY_COPY, type FileRow } from './model';
import { WhyReadOnly, lockReason } from './ReadOnlyWhy';
import type { TeamFiles } from './store';
import { whenLabel } from './when';

/** The "Where" cell: where an attachment came from, the rule that holds for a row of the repo, or what keeps a memory folder. */
export function whereOf(row: FileRow): string {
  if (row.readOnlyReason === 'change_by_pull_request') return READ_ONLY_COPY;
  if (row.managedBy === 'personal_memory') return 'Your memory';
  if (row.managedBy) return MEMORY_COPY;
  return row.where ?? '—';
}

/** The type tile: a folder, or the file's kind (its extension on a coloured tile). */
export function Icon({ row, large = false }: { row: FileRow; large?: boolean }) {
  if (row.kind === 'folder') return <div className={`fic dir ${large ? 'big' : ''}`} aria-hidden="true"><FolderIcon /></div>;
  const k = fileKind(row.name, row.mime ?? '');
  return <div className={`fic ${k.tone === 'file' ? '' : k.tone} ${large ? 'big' : ''}`} aria-hidden="true">{k.label}</div>;
}

/** Who last changed it: a person or a bot, with their picture. */
export function By({ row }: { row: FileRow }) {
  const by = row.by;
  if (!by) return <>—</>;
  return (
    <span className="by" data-testid="file-by" data-kind={by.kind}>
      <Avatar name={by.name} kind={by.kind === 'bot' ? 'agent' : by.kind === 'system' ? 'automation' : 'person'} avatar={by.avatar} personId={by.personId} />
      <span className="by-name">{by.name}</span>
    </span>
  );
}

/** "Today 14:02", a weekday or a date; then the size when there is one (the line under the name on a phone). */
const subline = (row: FileRow): string => [row.modifiedAt ? whenLabel(row.modifiedAt) : null, row.size === null ? null : fileSize(row.size)].filter(Boolean).join(' · ');

export type ItemProps = {
  row: FileRow;
  files: TeamFiles;
  /** Open in the preview panel now. */
  current: boolean;
  checked: boolean;
  /** The one row in the list that is a tab stop. */
  tabStop: boolean;
  /** A drag from the list is over this folder. */
  over: boolean;
  dragging: boolean;
  draggable: boolean;
  /** `data-row-key`, which the list uses to move focus. */
  rkey: string;
  /** Rename, Download and Share when this row has them: the buttons that show on hover. */
  quick: MenuEntry[];
  onCheck: (shift: boolean) => void;
  onAction: (action: RowAction, row: FileRow) => void;
  /** Click, keys, right-click and drag handlers, built by the list. */
  handlers: HTMLAttributes<HTMLDivElement>;
};

const QUICK: Readonly<Record<string, { icon: ReactNode; label: string }>> = {
  download: { icon: <DownloadIcon />, label: 'Download' },
  rename: { icon: <RenameIcon />, label: 'Rename' },
  share: { icon: <SendToTeamIcon />, label: 'Send to a team' },
};

function Quick({ row, quick }: { row: FileRow; quick: MenuEntry[] }) {
  return (
    <span className="fquick" data-stop>
      {quick.map((m) => {
        const q = QUICK[m.id];
        if (!q) return null;
        return m.href ? (
          <a key={m.id} className="icon-btn" href={m.href} download={m.download} aria-label={`${q.label} ${row.name}`} title={q.label} data-testid={`hover-${m.id}`} onClick={(e) => e.stopPropagation()}>{q.icon}</a>
        ) : (
          <button key={m.id} type="button" className="icon-btn" aria-label={`${q.label} ${row.name}`} title={q.label} data-testid={`hover-${m.id}`} onClick={(e) => { e.stopPropagation(); m.run?.(); }}>{q.icon}</button>
        );
      })}
    </span>
  );
}

function Check({ row, checked, onCheck }: { row: FileRow; checked: boolean; onCheck: (shift: boolean) => void }) {
  return (
    <input
      type="checkbox"
      className="fcheck"
      checked={checked}
      aria-label={`Select ${row.name}`}
      data-testid="row-check"
      data-stop
      tabIndex={-1}
      onChange={() => undefined}
      onClick={(e) => {
        e.stopPropagation();
        onCheck(e.shiftKey);
      }}
    />
  );
}

function Name({ row }: { row: FileRow }) {
  const lock = lockReason(row);
  return (
    <>
      <span className="fname-col">
        <span className="fname-text" title={row.path}>{friendlyName(row.path, row.name)}</span>
        <span className="fdate" data-vt-mask>{subline(row)}</span>
      </span>
      {lock ? <WhyReadOnly reason={lock} /> : null}
    </>
  );
}

const cls = (p: ItemProps, base: string): string => [base, p.current ? 'on' : '', p.checked ? 'chk' : '', p.over ? 'drop' : '', p.dragging ? 'drag' : ''].filter(Boolean).join(' ');

/** One row of the list view: 40 px tall, with Download, Rename and Send to a team on hover next to the ⋯ menu. */
export function ListRow(p: ItemProps) {
  const { row } = p;
  return (
    <div
      role="row"
      tabIndex={p.tabStop ? 0 : -1}
      aria-selected={p.checked}
      aria-current={p.current ? 'true' : undefined}
      className={cls(p, 'frow')}
      data-testid="file-row"
      data-row-key={p.rkey}
      data-path={row.path}
      data-kind={row.kind}
      data-store={row.store}
      data-selected={p.checked}
      draggable={p.draggable}
      {...p.handlers}
    >
      <div role="cell" className="fchk"><Check row={row} checked={p.checked} onCheck={p.onCheck} /></div>
      <div role="cell"><Icon row={row} /></div>
      <div role="cell" className="fname"><Name row={row} /></div>
      <div role="cell" className="src">{whereOf(row)}</div>
      <div role="cell" className="src" data-vt-mask><By row={row} /></div>
      <div role="cell" className="src when" data-vt-mask>{whenLabel(row.modifiedAt)}</div>
      <div role="cell" className="sz">{row.size === null ? '—' : fileSize(row.size)}</div>
      <div role="cell" className="fact">
        <Quick row={row} quick={p.quick} />
        <RowMenu row={row} files={p.files} start={p.onAction} />
      </div>
    </div>
  );
}

const isImage = (row: FileRow): boolean => row.kind === 'file' && Boolean(row.contentUrl) && (row.mime ?? '').startsWith('image/') && row.mime !== 'image/svg+xml';

/** One tile of the grid view: a picture for an image, the type tile for anything else. */
export function GridCard(p: ItemProps) {
  const { row } = p;
  return (
    <div
      role="listitem"
      tabIndex={p.tabStop ? 0 : -1}
      aria-current={p.current ? 'true' : undefined}
      className={cls(p, 'fcard')}
      data-testid="file-row"
      data-row-key={p.rkey}
      data-path={row.path}
      data-kind={row.kind}
      data-store={row.store}
      data-selected={p.checked}
      draggable={p.draggable}
      {...p.handlers}
    >
      <span className="fcard-check"><Check row={row} checked={p.checked} onCheck={p.onCheck} /></span>
      <div className="fthumb" aria-hidden="true">
        {isImage(row) ? <img src={row.contentUrl ?? ''} alt="" loading="lazy" decoding="async" draggable={false} /> : <Icon row={row} large />}
      </div>
      <div className="fcard-name"><Name row={row} /></div>
      <span className="fcard-menu"><RowMenu row={row} files={p.files} start={p.onAction} /></span>
    </div>
  );
}
