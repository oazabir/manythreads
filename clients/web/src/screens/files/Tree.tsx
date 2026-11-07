import { useRef, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { friendlyName } from '../../components/friendlyPath';
import { CaretIcon } from '../../shell/icons';
import { PersonIcon, TeamIcon } from './icons';
import { MEMORY_COPY, ROOT, sortRows, treeShows, type FileRow } from './model';
import { DRAG_TYPE } from './dnd';
import type { TeamFiles } from './store';
import type { Folders } from './useFolders';

type Props = {
  /** Personal first (absent for a guest), then the teams. */
  personal: TeamFiles | null;
  teams: readonly TeamFiles[];
  folders: Folders;
  /** Where the list is: the space, its folder, and the file open in the centre. */
  space: string;
  folder: string;
  open: string | null;
  /** Open folders, as `<space>\0<path>`; the root of a space is `<space>\0` and is open when listed. */
  expanded: ReadonlySet<string>;
  onToggle: (space: string, path: string) => void;
  onFolder: (space: string, path: string) => void;
  onFile: (space: string, row: FileRow) => void;
  /** A drag from the list is over this folder (`space`, `path`); null when it leaves. */
  dropTarget: string | null;
  canDrop: (space: string, path: string) => boolean;
  onDragTarget: (key: string | null) => void;
  onDropOn: (space: string, path: string) => void;
};

export const treeKey = (space: string, path: string): string => `${space}\0${path}`;

/**
 * The tree column: two top levels. Personal is the person's own files; Teams lists a branch for each team they can read. Folders load when they are
 * opened. A channel's attachments are left out (the list shows them). Arrow keys walk the visible rows (Up and Down move, Right opens or steps in,
 * Left closes or steps out, Home and End jump); only one row is a tab stop, so Tab passes through the tree in one press.
 */
export function Tree({ personal, teams, folders, space, folder, open: opened, expanded, onToggle, onFolder, onFile, dropTarget, canDrop, onDragTarget, onDropOn }: Props) {
  const box = useRef<HTMLDivElement>(null);

  const items = (): HTMLElement[] => [...(box.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])];
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const rows = items();
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const target = e.target as HTMLElement;
    if (!target.matches('[role="treeitem"]')) return;
    const focus = (i: number): void => {
      e.preventDefault();
      rows[Math.max(0, Math.min(rows.length - 1, i))]?.focus();
    };
    const sp = target.dataset['space'] ?? '';
    const path = target.dataset['path'] ?? '';
    const isFolder = target.dataset['kind'] === 'folder' || target.dataset['kind'] === 'root';
    const isOpen = target.getAttribute('aria-expanded') === 'true';
    if (e.key === 'ArrowDown') focus(at + 1);
    else if (e.key === 'ArrowUp') focus(at - 1);
    else if (e.key === 'Home') focus(0);
    else if (e.key === 'End') focus(rows.length - 1);
    else if (e.key === 'ArrowRight' && isFolder) {
      e.preventDefault();
      if (!isOpen) onToggle(sp, path);
      else focus(at + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (isFolder && isOpen) onToggle(sp, path);
      else {
        // step out to the parent row: the nearest row above with a smaller level
        const level = Number(target.getAttribute('aria-level'));
        for (let i = at - 1; i >= 0; i--) {
          if (Number(rows[i]?.getAttribute('aria-level')) < level) {
            rows[i]?.focus();
            break;
          }
        }
      }
    }
  };

  const dragProps = (sp: string, path: string) => ({
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      if (!canDrop(sp, path)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      if (dropTarget !== treeKey(sp, path)) onDragTarget(treeKey(sp, path));
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      if (dropTarget === treeKey(sp, path)) onDragTarget(null);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE) || !canDrop(sp, path)) return;
      e.preventDefault();
      e.stopPropagation();
      onDragTarget(null);
      onDropOn(sp, path);
    },
  });

  // exactly one row is a tab stop: the selected one when it is drawn, else the root of the space the list is on
  const rootOn = (sp: string): boolean => space === sp && folder === ROOT && opened === null;
  const spaces = [personal, ...teams].filter((s): s is TeamFiles => s !== null);
  const stopSpace = spaces.some((s) => s.slug === space) ? space : spaces[0]?.slug;
  let selectedDrawn = false;

  const level = (sp: string, parent: string, depth: number): ReactNode => {
    const st = folders.get(sp, parent);
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
      const isOpen = isFolder && expanded.has(treeKey(sp, row.path));
      const on = space === sp && (isFolder ? row.path === folder && opened === null : row.path === opened);
      const over = dropTarget === treeKey(sp, row.path);
      if (on) selectedDrawn = true;
      return (
        <div key={row.path} role="none">
          <div
            role="treeitem"
            tabIndex={on ? 0 : -1}
            aria-level={depth}
            aria-selected={on}
            aria-expanded={isFolder ? isOpen : undefined}
            className={`tnode lvl${depth} ${on ? 'on' : ''} ${over ? 'drop' : ''}`}
            data-testid="tree-node"
            data-space={sp}
            data-path={row.path}
            data-kind={row.kind}
            title={row.managedBy ? MEMORY_COPY : row.path}
            onClick={() => (isFolder ? onFolder(sp, row.path) : onFile(sp, row))}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (isFolder) onFolder(sp, row.path);
                else onFile(sp, row);
              }
            }}
            {...(isFolder ? dragProps(sp, row.path) : {})}
          >
            {isFolder ? (
              <span
                className="car"
                data-testid="tree-caret"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(sp, row.path);
                }}
              >
                <CaretIcon open={isOpen} />
              </span>
            ) : (
              <span className="car" />
            )}
            <span className="tname">{friendlyName(row.path, row.name)}</span>
          </div>
          {isOpen ? <div role="group">{level(sp, row.path, depth + 1)}</div> : null}
        </div>
      );
    });
  };

  const root = (files: TeamFiles, kind: 'personal' | 'team', kids: ReactNode): ReactNode => {
    const sp = files.slug;
    const isOpen = expanded.has(treeKey(sp, ROOT));
    const on = rootOn(sp);
    const over = dropTarget === treeKey(sp, ROOT);
    return (
      <div key={sp} role="none">
        <div
          role="treeitem"
          tabIndex={on || (!selectedDrawn && sp === stopSpace) ? 0 : -1}
          aria-level={1}
          aria-selected={on}
          aria-expanded={isOpen}
          className={`tnode lvl1 troot ${on ? 'on' : ''} ${over ? 'drop' : ''}`}
          data-testid="tree-root"
          data-space={sp}
          data-path={ROOT}
          data-kind="root"
          data-root={kind}
          onClick={() => onFolder(sp, ROOT)}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onFolder(sp, ROOT);
            }
          }}
          {...dragProps(sp, ROOT)}
        >
          <span
            className="car"
            data-testid="tree-root-caret"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(sp, ROOT);
            }}
          >
            <CaretIcon open={isOpen} />
          </span>
          <span className="tico">{kind === 'personal' ? <PersonIcon /> : <TeamIcon />}</span>
          <span className="tname">{files.teamName}</span>
        </div>
        {isOpen ? <div role="group">{kids}</div> : null}
      </div>
    );
  };

  // the branches are built first, so the tab stop knows whether the selected row is among them
  const branches = spaces.map((s) => ({ files: s, kids: expanded.has(treeKey(s.slug, ROOT)) ? level(s.slug, ROOT, 2) : null }));
  const branch = (b: (typeof branches)[number]): ReactNode => root(b.files, b.files.space === 'personal' ? 'personal' : 'team', b.kids);
  const mine = branches.filter((b) => b.files.space === 'personal');
  const theirs = branches.filter((b) => b.files.space !== 'personal');

  return (
    <div className="ftree" data-landmark="tree" ref={box} onKeyDown={onKey}>
      <div role="tree" aria-label="Files">
        {mine.map(branch)}
        {theirs.length > 0 ? <div className="tit" data-testid="tree-teams" role="presentation">Teams</div> : null}
        {theirs.map(branch)}
      </div>
    </div>
  );
}
