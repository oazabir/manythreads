import { useId, type KeyboardEvent, type ReactNode } from 'react';
import { CloseIcon, SearchIcon } from '../shell/icons';

/**
 * The Threads view's filter (P29): one text box over the loaded threads and, for what is not loaded, the server. Words match the channel's name and the messages; `@name` keeps the
 * threads that mention that person or bot. The x and Escape clear it. `?q=` in the address holds it. The "Needs you first" button switches the grouping to plain time order.
 */
export function FilterBar({
  value,
  onChange,
  needsFirst,
  onNeedsFirst,
  status,
  extra,
}: {
  value: string;
  onChange: (text: string) => void;
  needsFirst: boolean;
  onNeedsFirst: (on: boolean) => void;
  /** One line under the box: how many threads match, or that a name matches nobody. */
  status: string | null;
  /** More controls on the right of the bar (the list and grid toggle). */
  extra?: ReactNode;
}) {
  const id = useId();
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape' && value !== '') {
      e.preventDefault();
      e.stopPropagation();
      onChange('');
    }
  };
  return (
    <div className="inf" role="search" data-testid="threads-filter">
      <div className="inf-field">
        <SearchIcon size={14} />
        <label htmlFor={id} className="sr-only">Filter threads</label>
        <input
          id={id}
          className="inf-input"
          type="search"
          value={value}
          placeholder="Filter threads, @name for who is mentioned"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          data-testid="threads-filter-input"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKey}
        />
        {value !== '' ? (
          <button type="button" className="inf-clear" aria-label="Clear the filter" title="Clear the filter" data-testid="threads-filter-clear" onClick={() => onChange('')}>
            <CloseIcon size={14} />
          </button>
        ) : null}
      </div>
      <button type="button" className="inf-order" aria-pressed={needsFirst} data-testid="threads-order" title="Put the threads that wait on you first" onClick={() => onNeedsFirst(!needsFirst)}>
        Needs you first
      </button>
      {extra}
      {status !== null ? <p className="inf-status" role="status" data-testid="threads-filter-status">{status}</p> : null}
    </div>
  );
}
