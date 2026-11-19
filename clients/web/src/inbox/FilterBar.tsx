import { useId, type KeyboardEvent } from 'react';
import { CloseIcon, GridIcon, ListIcon, SearchIcon } from '../shell/icons';
import type { ThreadsLayout } from './viewMode';

/**
 * The Threads view's filter (P29): one text box over the loaded threads and, for what is not loaded, the server. Words match the channel's name and the messages; `@name` keeps the
 * threads that mention that person or bot. The x and Escape clear it. `?q=` in the address holds it. The "Needs you first" button switches the grouping to plain time order; "People only" keeps
 * the threads with no bot in them.
 */
export function FilterBar({
  value,
  onChange,
  needsFirst,
  onNeedsFirst,
  peopleOnly,
  onPeopleOnly,
  status,
  layout,
  onLayout,
}: {
  value: string;
  onChange: (text: string) => void;
  needsFirst: boolean;
  onNeedsFirst: (on: boolean) => void;
  /** "People only": the threads with no bot in them (owner, 2026-11-19). */
  peopleOnly: boolean;
  onPeopleOnly: (on: boolean) => void;
  /** One line under the box: how many threads match, or that a name matches nobody. */
  status: string | null;
  layout: ThreadsLayout;
  onLayout: (layout: ThreadsLayout) => void;
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
          placeholder="Filter, or @name"
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
      <button type="button" className="inf-order" data-kind="people" aria-pressed={peopleOnly} data-testid="threads-people-only" title="Only the threads where people talk, with no bot in them" onClick={() => onPeopleOnly(!peopleOnly)}>
        People only
      </button>
      <div className="inf-layout" role="group" aria-label="Layout">
        <button type="button" className="inf-lay" aria-pressed={layout === 'list'} data-testid="threads-layout-list" title="List" aria-label="List" onClick={() => onLayout('list')}>
          <ListIcon size={14} />
        </button>
        <button type="button" className="inf-lay" aria-pressed={layout === 'grid'} data-testid="threads-layout-grid" title="Grid" aria-label="Grid" onClick={() => onLayout('grid')}>
          <GridIcon size={14} />
        </button>
      </div>
      {status !== null ? <p className="inf-status" role="status" data-testid="threads-filter-status">{status}</p> : null}
    </div>
  );
}
