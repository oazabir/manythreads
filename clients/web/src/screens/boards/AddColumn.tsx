import { useState } from 'react';
import { MAX_BOARD_COLUMNS, TASK_STATES, type TaskState } from '@manythreads/shared';
import { AddIcon } from '../../shell/icons';
import { STATE_LABEL } from './board';

/*
 * The end of the column strip for a board's managers (PLAN P6-14): a name and the task state the new column counts as. The state rules still decide
 * every move into the column; two columns may count as the same state.
 */

type Props = { onAdd: (name: string, state: TaskState) => Promise<void>; full?: boolean };

export function AddColumn({ onAdd, full = false }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [state, setState] = useState<TaskState>('in_progress');
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <div className="bd-addcol">
        <button type="button" className="btn s" data-testid="add-column" disabled={full} title={full ? `A board holds at most ${MAX_BOARD_COLUMNS} columns` : undefined} onClick={() => setOpen(true)}>
          <AddIcon /> Add column
        </button>
      </div>
    );
  }

  const submit = async (): Promise<void> => {
    if (name.trim() === '') return;
    setBusy(true);
    try {
      await onAdd(name.trim(), state);
      setName('');
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bd-addcol open" data-testid="add-column-form" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <label className="bd-field">
        <span>Column name</span>
        <input value={name} maxLength={60} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} data-testid="add-column-name" />
      </label>
      <label className="bd-field">
        <span>Counts as</span>
        <select value={state} onChange={(e) => setState(e.target.value as TaskState)} data-testid="add-column-state">
          {TASK_STATES.map((s) => (
            <option key={s} value={s}>
              {STATE_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      <div className="bd-toolbar-act">
        <button type="button" className="btn s" onClick={() => setOpen(false)}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy || name.trim() === ''} onClick={() => void submit()} data-testid="add-column-save">
          Add
        </button>
      </div>
    </div>
  );
}
