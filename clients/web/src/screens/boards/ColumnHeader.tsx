import { useState } from 'react';
import type { BoardColumn } from '@manythreads/shared';
import { CloseIcon, ColumnDeleteIcon, ColumnGripIcon, ColumnLeftIcon, ColumnRightIcon, MoreIcon, PencilIcon } from '../../shell/icons';

/*
 * The heading of one board column (PLAN P6-14). People who manage the board (a team lead, a workspace admin) get a grip to drag the column
 * (or Alt+Arrow on it), and a menu with Rename, Move left, Move right and Delete. The menu buttons are the way on a phone, where dragging
 * an element does not work. Everyone else sees the name and the count only. The order is changed by the parent, which calls the server.
 */

type Props = {
  column: BoardColumn;
  index: number;
  last: boolean;
  total: string;
  canManage: boolean;
  onRename: (name: string) => Promise<void>;
  onMove: (delta: -1 | 1) => void;
  onDelete: () => Promise<void>;
  onGripDragStart: (e: React.DragEvent) => void;
  onGripDragEnd: () => void;
};

export function ColumnHeader({ column, index, last, total, canManage, onRename, onMove, onDelete, onGripDragStart, onGripDragEnd }: Props) {
  const [menu, setMenu] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  const saveName = async (): Promise<void> => {
    const next = (name ?? '').trim();
    setName(null);
    if (next !== '' && next !== column.name) await onRename(next);
  };

  return (
    <header className="bd-col-head">
      {canManage ? (
        <button
          type="button"
          className="bd-col-grip"
          draggable
          aria-label={`Move column ${column.name}`}
          title="Drag to reorder, or press Alt with an arrow key"
          data-testid="column-grip"
          onDragStart={onGripDragStart}
          onDragEnd={onGripDragEnd}
          onKeyDown={(e) => {
            if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
            e.preventDefault();
            onMove(e.key === 'ArrowLeft' ? -1 : 1);
          }}
        >
          <ColumnGripIcon />
        </button>
      ) : null}
      {name !== null ? (
        <input
          className="bd-col-rename"
          value={name}
          maxLength={60}
          autoFocus
          aria-label={`New name for ${column.name}`}
          data-testid="column-rename-input"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void saveName()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void saveName();
            if (e.key === 'Escape') setName(null);
          }}
        />
      ) : (
        <h3 data-testid="column-name">{column.name}</h3>
      )}
      <span className="bd-col-count" data-testid="column-total" data-vt-mask>
        {total}
      </span>
      {canManage ? (
        <span className="bd-col-menu-wrap">
          <button type="button" className="bd-col-more" aria-label={`Options for column ${column.name}`} aria-expanded={menu} data-testid="column-menu" onClick={() => { setMenu((v) => !v); setConfirm(false); }}>
            <MoreIcon />
          </button>
          {menu ? (
            <div className="bd-col-menu" role="group" aria-label={`Column ${column.name}`}>
              {confirm ? (
                <>
                  <p className="bd-muted">Delete {column.name}?</p>
                  <button type="button" className="btn s" data-testid="column-delete-confirm" onClick={() => { setMenu(false); setConfirm(false); void onDelete(); }}>
                    <ColumnDeleteIcon /> Delete column
                  </button>
                  <button type="button" className="btn s" onClick={() => setConfirm(false)}>
                    <CloseIcon /> Keep it
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="btn s" data-testid="column-rename" onClick={() => { setMenu(false); setName(column.name); }}>
                    <PencilIcon /> Rename
                  </button>
                  <button type="button" className="btn s" disabled={index === 0} data-testid="column-left" onClick={() => onMove(-1)}>
                    <ColumnLeftIcon /> Move left
                  </button>
                  <button type="button" className="btn s" disabled={last} data-testid="column-right" onClick={() => onMove(1)}>
                    <ColumnRightIcon /> Move right
                  </button>
                  <button type="button" className="btn s" data-testid="column-delete" onClick={() => setConfirm(true)}>
                    <ColumnDeleteIcon /> Delete
                  </button>
                </>
              )}
            </div>
          ) : null}
        </span>
      ) : null}
    </header>
  );
}
