import { useEffect, useState } from 'react';
import { usePanel } from '../kernel/panel';
import { SearchIcon } from '../shell/icons';
import { parseSearchEntry, searchEntry, SEARCH_PANEL } from './searchEntry';

const isMac = (): boolean => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * A search box that opens the results in the right panel (`search:<query>`). Pressing Enter searches; searching again replaces the
 * results on top instead of stacking them. `channelId` limits the results to one conversation.
 */
export function SearchBox({ placeholder, channelId = null, label = 'Search', className = '', autoFocus = false }: { placeholder: string; channelId?: string | null; label?: string; className?: string; autoFocus?: boolean }) {
  const panel = usePanel();
  const top = panel.entries.at(-1);
  const current = top?.type === SEARCH_PANEL ? parseSearchEntry(top.id) : null;
  const [value, setValue] = useState(current && current.channelId === channelId ? current.q : '');
  // A search opened by a link (or Back) shows its query in the box.
  const shown = current && current.channelId === channelId ? current.q : null;
  useEffect(() => {
    if (shown !== null) setValue(shown);
  }, [shown]);

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    const q = value.trim();
    if (q === '') return;
    const next = searchEntry(q, channelId);
    if (top?.type === SEARCH_PANEL) panel.replace(next);
    else panel.push(next);
  };
  return (
    <form role="search" className={`search-box ${className}`} onSubmit={submit} aria-label={label}>
      <SearchIcon />
      <span className="sr-only">{label}</span>
      <input
        type="search"
        enterKeyHint="search"
        placeholder={placeholder}
        aria-label={label}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value !== '') {
            e.preventDefault();
            setValue('');
          } else if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
        }}
        maxLength={200}
      />
      {value === '' && !channelId ? <kbd className="search-kbd" aria-hidden="true">{isMac() ? '⌘K' : 'Ctrl K'}</kbd> : null}
    </form>
  );
}
