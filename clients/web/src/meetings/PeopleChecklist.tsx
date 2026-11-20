import { useId, useState } from 'react';
import { FIND_AFTER, capLine, filterPeople, matchLine, selectAllLabel, selectShown, togglePerson, type ChecklistPerson } from './people';

/**
 * A list of people to tick (the start dialog, Invite more, the schedule dialog): a find box once the list is long, a status line that says how many match
 * ("4 of 12 match", heard by a screen reader), Select all for the people shown, and a locked row (ticked, not changeable) for the caller where they are always in.
 *
 * Without `server` the list is filtered here. With it, the server has already narrowed `people` to what was typed (the parent asks it, with a pause between
 * keys), `matching` is how many match there in all and `total` how many there are; when it sent fewer than match, the list says so ("Showing 200 of 1,240").
 * While the server has not answered for what is typed now (`searching`), or could not (`searchFailed`), the list says so and shows nobody: never the people of
 * an earlier search. `max` is the most that may be ticked: Select all stops there, and `maxLine` says why.
 */
export function PeopleChecklist({
  label,
  people,
  picked,
  onChange,
  find,
  onFind,
  server,
  emptyText,
  loading,
  testId,
  findTestId,
  searching,
  searchFailed,
  max,
  maxLine,
}: {
  label: string;
  people: readonly ChecklistPerson[];
  picked: readonly string[];
  onChange: (next: string[]) => void;
  find: string;
  onFind: (value: string) => void;
  server?: { matching: number; total: number } | undefined;
  /** Said in the list when there is nobody to tick at all. */
  emptyText: string;
  loading?: boolean;
  testId?: string;
  findTestId?: string;
  searching?: boolean;
  /** Said in place of the list when the server could not answer the search. */
  searchFailed?: string | null;
  max?: number;
  maxLine?: string;
}) {
  const [capped, setCapped] = useState(false);
  const labelId = useId();
  const statusId = useId();
  const waiting = searching === true || (searchFailed ?? null) !== null;
  const shown = waiting ? [] : server ? [...people] : filterPeople(people, find);
  const over = max !== undefined && picked.length > max;
  const status = searching ? 'Searching…' : searchFailed ? searchFailed : server ? matchLine(find, server.matching, server.total) : matchLine(find, shown.length, people.length);
  const cap = server ? capLine(people.length, server.matching) : null;
  const all = waiting ? 'Select all' : selectAllLabel(picked, shown);
  const showFind = find !== '' || (server ? server.total : people.length) > FIND_AFTER;
  const nobody = !loading && !waiting && shown.length === 0;

  return (
    <div className="sch-people-box">
      <span className="dlg-label" id={labelId}>{label}</span>
      {showFind || all !== null ? (
        <div className="sch-people-tools">
          {showFind ? (
            <input
              type="search"
              className="dlg-input sch-people-find"
              value={find}
              onChange={(e) => {
                setCapped(false);
                onFind(e.target.value);
              }}
              placeholder="Find a person"
              aria-label="Find a person"
              aria-describedby={statusId}
              data-testid={findTestId}
            />
          ) : null}
          {all !== null ? (
            <button
              type="button"
              className="btn s sch-people-all"
              data-testid={testId ? `${testId}-all` : undefined}
              disabled={waiting || loading}
              onClick={() => {
                const r = selectShown(picked, shown, max);
                setCapped(r.capped);
                onChange(r.next);
              }}
            >
              {all}
            </button>
          ) : null}
        </div>
      ) : null}
      <p className="dlg-hint sch-people-count" id={statusId} role="status" data-testid={testId ? `${testId}-count` : undefined}>{status ?? ''}</p>
      <ul className="sch-people" aria-labelledby={labelId} aria-busy={loading || undefined} data-testid={testId}>
        {shown.map((p) => (
          <li key={p.personId}>
            <label className={`sch-person${p.locked ? ' sch-person-locked' : ''}`}>
              <input
                type="checkbox"
                checked={p.locked === true || picked.includes(p.personId)}
                disabled={p.locked}
                onChange={() => {
                  setCapped(false);
                  onChange(togglePerson(picked, p));
                }}
              />
              <span>{p.displayName}</span>
            </label>
          </li>
        ))}
        {nobody ? <li className="dlg-hint">{find.trim() === '' ? emptyText : 'Nobody matches.'}</li> : null}
      </ul>
      {cap && !waiting ? <p className="dlg-hint" data-testid={testId ? `${testId}-cap` : undefined}>{cap}</p> : null}
      {(capped || over) && maxLine ? <p className="dlg-error" role="alert" data-testid={testId ? `${testId}-max` : undefined}>{maxLine}</p> : null}
    </div>
  );
}
