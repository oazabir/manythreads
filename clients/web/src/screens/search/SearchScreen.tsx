import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { PageHeader } from '../../components/PageHeader';
import { SearchPanel } from '../../search/SearchPanel';
import { parseSearchEntry, searchEntry } from '../../search/searchEntry';
import type { PanelEntry } from '../../kernel/panel';

/** The whole-page search at /t/:team/search?q=: the panel's results, wider, with the same filters. The address holds the query. */
export function SearchScreen() {
  const [params, setParams] = useSearchParams();
  const q = (params.get('q') ?? '').slice(0, 200);
  const entry = useMemo(() => searchEntry(q), [q]);
  const run = (next: PanelEntry): void => setParams({ q: parseSearchEntry(next.id).q });
  return (
    <div className="search-screen">
      <PageHeader title="Search" description={q ? undefined : 'Type in the search box to look through messages, threads and files.'} />
      <SearchPanel entry={entry} onSearch={run} full />
    </div>
  );
}
