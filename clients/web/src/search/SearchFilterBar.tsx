import { useId, useState } from 'react';
import { formatSearchText, type SearchFilters } from '@manythreads/shared';
import { deleteSavedSearch, fetchSavedSearches, saveSearch } from '../api/endpoints';
import { isApiError } from '../api/client';
import { useQuery } from '../app/useQuery';
import { usePeople } from '../channels/hooks';
import { usePanel } from '../kernel/panel';
import { searchEntry } from './searchEntry';

/** The words of a filter, in plain language (the chip and the screen-reader label). */
export function filterChips(f: SearchFilters): { key: string; label: string; remove: SearchFilters }[] {
  const without = (patch: Partial<SearchFilters>): SearchFilters => ({ ...f, ...patch });
  return [
    ...f.from.map((v) => ({ key: `from:${v}`, label: `From ${v}`, remove: without({ from: f.from.filter((x) => x !== v) }) })),
    ...f.in.map((v) => ({ key: `in:${v}`, label: `In #${v}`, remove: without({ in: f.in.filter((x) => x !== v) }) })),
    ...f.has.map((v) => ({ key: `has:${v}`, label: v === 'file' ? 'Has a file' : 'Has a link', remove: without({ has: f.has.filter((x) => x !== v) }) })),
    ...f.is.map((v) => ({ key: `is:${v}`, label: 'In a thread', remove: without({ is: f.is.filter((x) => x !== v) }) })),
    ...(f.after ? [{ key: 'after', label: `After ${f.after}`, remove: without({ after: null }) }] : []),
    ...(f.before ? [{ key: 'before', label: `Before ${f.before}`, remove: without({ before: null }) }] : []),
  ];
}

/**
 * Filters of the search (PLAN P14-11): the chips of what is applied (each removable), a form to add more, and the person's saved searches.
 * Everything here only rewrites the text of the search box; the server reads the same words, so a typed `from:nadia` and a chip are one thing.
 */
export function SearchFilterBar({ filters, channelId }: { filters: SearchFilters; channelId: string | null }) {
  const panel = usePanel();
  const people = usePeople();
  const ids = useId();
  const [open, setOpen] = useState<'filters' | 'saved' | null>(null);
  const chips = filterChips(filters);

  const run = (next: SearchFilters): void => panel.replace(searchEntry(formatSearchText(next), channelId));
  const toggle = (which: 'filters' | 'saved'): void => setOpen((o) => (o === which ? null : which));

  return (
    <div className="sf-bar" data-testid="search-filters">
      {chips.length > 0 ? (
        <ul className="sf-chips" aria-label="Filters applied">
          {chips.map((c) => (
            <li key={c.key} className="sf-chip" data-testid="search-chip">
              <span>{c.label}</span>
              <button type="button" className="sf-x" aria-label={`Remove filter: ${c.label}`} onClick={() => run(c.remove)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="sf-actions">
        <button type="button" className="btn s sf-toggle" aria-expanded={open === 'filters'} aria-controls={`${ids}-filters`} onClick={() => toggle('filters')}>
          Filters
        </button>
        <button type="button" className="btn s sf-toggle" aria-expanded={open === 'saved'} aria-controls={`${ids}-saved`} onClick={() => toggle('saved')}>
          Saved searches
        </button>
      </div>
      {open === 'filters' ? (
        <FilterForm id={`${ids}-filters`} filters={filters} names={people.list.map((p) => p.name)} onApply={(f) => { run(f); setOpen(null); }} />
      ) : null}
      {open === 'saved' ? <Saved id={`${ids}-saved`} filters={filters} channelId={channelId} /> : null}
    </div>
  );
}

function FilterForm({ id, filters, names, onApply }: { id: string; filters: SearchFilters; names: string[]; onApply: (f: SearchFilters) => void }) {
  const [from, setFrom] = useState(filters.from[0] ?? '');
  const [inChannel, setInChannel] = useState(filters.in[0] ?? '');
  const [file, setFile] = useState(filters.has.includes('file'));
  const [link, setLink] = useState(filters.has.includes('link'));
  const [thread, setThread] = useState(filters.is.includes('thread'));
  const [after, setAfter] = useState(filters.after ?? '');
  const [before, setBefore] = useState(filters.before ?? '');
  const list = `${id}-people`;
  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    const name = from.trim().replace(/^@/, '');
    const channel = inChannel.trim().replace(/^#/, '');
    onApply({
      ...filters,
      from: name ? [name, ...filters.from.slice(1)] : [],
      in: channel ? [channel, ...filters.in.slice(1)] : [],
      has: [...(file ? (['file'] as const) : []), ...(link ? (['link'] as const) : [])],
      is: thread ? ['thread'] : [],
      after: after || null,
      before: before || null,
    });
  };
  return (
    <form id={id} className="sf-form" onSubmit={submit} aria-label="Search filters">
      <label className="sf-field">
        <span>From</span>
        <input type="text" value={from} onChange={(e) => setFrom(e.target.value)} list={list} placeholder="A person, or me" maxLength={60} autoComplete="off" />
        <datalist id={list}>
          {names.slice(0, 50).map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
      </label>
      <label className="sf-field">
        <span>In channel</span>
        <input type="text" value={inChannel} onChange={(e) => setInChannel(e.target.value)} placeholder="dev" maxLength={60} autoComplete="off" />
      </label>
      <label className="sf-field">
        <span>After</span>
        <input type="date" value={after} onChange={(e) => setAfter(e.target.value)} />
      </label>
      <label className="sf-field">
        <span>Before</span>
        <input type="date" value={before} onChange={(e) => setBefore(e.target.value)} />
      </label>
      <fieldset className="sf-checks">
        <legend>Only messages that</legend>
        <label><input type="checkbox" checked={file} onChange={(e) => setFile(e.target.checked)} /> have a file</label>
        <label><input type="checkbox" checked={link} onChange={(e) => setLink(e.target.checked)} /> have a link</label>
        <label><input type="checkbox" checked={thread} onChange={(e) => setThread(e.target.checked)} /> are in a thread</label>
      </fieldset>
      <div className="sf-submit">
        <button type="submit" className="btn s primary">Apply filters</button>
      </div>
    </form>
  );
}

function Saved({ id, filters, channelId }: { id: string; filters: SearchFilters; channelId: string | null }) {
  const panel = usePanel();
  const list = useQuery('saved-searches', () => fetchSavedSearches());
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const text = formatSearchText(filters);
  const guard = async (job: () => Promise<unknown>, fallback: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await job();
      list.reload();
    } catch (err) {
      setError(isApiError(err) ? err.message : fallback);
    } finally {
      setBusy(false);
    }
  };
  const save = (e: React.FormEvent): void => {
    e.preventDefault();
    if (name.trim() === '' || text.length < 2) return;
    void guard(async () => {
      await saveSearch({ name: name.trim(), query: text });
      setName('');
    }, 'Could not save this search. Try again.');
  };
  return (
    <div id={id} className="sf-saved" aria-label="Saved searches" role="group">
      <form className="sf-save" onSubmit={save}>
        <label className="sf-field">
          <span>Name for this search</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Release notes from Nadia" disabled={text.length < 2} />
        </label>
        <button type="submit" className="btn s" disabled={busy || name.trim() === '' || text.length < 2}>Save this search</button>
      </form>
      {error ? <p className="sf-error" role="alert">{error}</p> : null}
      {list.status === 'loading' ? <p className="search-note" aria-busy="true">Loading…</p> : null}
      {list.status === 'error' ? <p className="search-note" role="alert">Saved searches are not available right now.</p> : null}
      {list.status === 'ok' && list.data.items.length === 0 ? <p className="search-note" data-testid="saved-empty">You have not saved a search yet.</p> : null}
      {list.status === 'ok' && list.data.items.length > 0 ? (
        <ul className="sf-list" data-testid="saved-list">
          {list.data.items.map((s) => (
            <li key={s.id}>
              <button type="button" className="sf-run" onClick={() => panel.replace(searchEntry(s.query, channelId))}>
                <b>{s.name}</b>
                <span>{s.query}</span>
              </button>
              <button type="button" className="sf-x" aria-label={`Delete saved search ${s.name}`} disabled={busy} onClick={() => void guard(() => deleteSavedSearch(s.id), 'Could not remove it. Try again.')}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
