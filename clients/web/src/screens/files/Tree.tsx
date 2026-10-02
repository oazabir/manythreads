import { useRef, type KeyboardEvent } from 'react';
import { CaretIcon } from '../../shell/icons';
import { MEMORY_COPY, ROOT, sortRows, treeShows, type FileRow } from './model';
import type { FolderState } from './useFolders';

type Props = {
  teamName: string;
  get: (path: string) => FolderState | undefined;
  expanded: ReadonlySet<string>;
  /** The folder open in the list. */
  folder: string;
  /** The file open in the centre (the folder is then not the selected row). */
  open: string | null;
  onToggle: (path: string) => void;
  onFolder: (path: string) => void;
  onFile: (row: FileRow) => void;
};

/**
 * The tree column: the team's name, then its folders and git files, nested. Folders load when they are opened. A channel's attachments are
 * left out (the list shows them); the rows of git and of channel folders look the same. Arrow keys move between rows.
 */
export function Tree({ teamName, get, expanded, folder, open: opened, onToggle, onFolder, onFile }: Props) {
  const box = useRef<HTMLDivElement>(null);

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const rows = [...(box.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const target = e.target as HTMLElement;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    } else if (e.key === 'ArrowRight' && target.dataset['kind'] === 'folder' && target.getAttribute('aria-expanded') === 'false') {
      e.preventDefault();
      onToggle(target.dataset['path'] ?? '');
    } else if (e.key === 'ArrowLeft' && target.dataset['kind'] === 'folder' && target.getAttribute('aria-expanded') === 'true') {
      e.preventDefault();
      onToggle(target.dataset['path'] ?? '');
    }
  };

  const level = (parent: string, depth: number): React.ReactNode => {
    const st = get(parent);
    const listing = st?.listing;
    if (!listing) {
      return st?.status === 'error' ? (
        <div className={`tnode lvl${depth}`} role="presentation"><span className="car" />{st.code === 'forbidden' ? 'No access' : 'Could not load'}</div>
      ) : (
        <div className={`tnode lvl${depth} loading`} role="presentation" aria-busy="true"><span className="car" />Loading…</div>
      );
    }
    return sortRows(listing.rows.filter(treeShows), 'name').map((row) => {
      const isFolder = row.kind === 'folder';
      const open = isFolder && expanded.has(row.path);
      const on = isFolder ? row.path === folder && opened === null : row.path === opened;
      return (
        <div key={row.path} role="none">
          <div
            role="treeitem"
            tabIndex={on || (opened === null && folder === ROOT && depth === 2 && row === listing.rows[0]) ? 0 : -1}
            aria-level={depth - 1}
            aria-selected={on}
            aria-expanded={isFolder ? open : undefined}
            className={`tnode lvl${depth} ${on ? 'on' : ''}`}
            data-testid="tree-node"
            data-path={row.path}
            data-kind={row.kind}
            title={row.managedBy ? MEMORY_COPY : row.path}
            onClick={() => (isFolder ? onFolder(row.path) : onFile(row))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (isFolder) onFolder(row.path);
                else onFile(row);
              }
            }}
          >
            {isFolder ? (
              <span
                className="car"
                data-testid="tree-caret"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(row.path);
                }}
              >
                <CaretIcon open={open} />
              </span>
            ) : (
              <span className="car" />
            )}
            <span className="tname">{isFolder ? `${row.name}/` : row.name}</span>
          </div>
          {open ? <div role="group">{level(row.path, depth + 1)}</div> : null}
        </div>
      );
    });
  };

  return (
    <div className="ftree" data-landmark="tree" ref={box} onKeyDown={onKey}>
      <div className="tit">{teamName}</div>
      <div role="tree" aria-label={`${teamName} files`}>
        {level(ROOT, 2)}
      </div>
    </div>
  );
}

