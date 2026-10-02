import { Suspense, lazy } from 'react';
import { fetchRoster } from '../../api/endpoints';
import { useQuery } from '../../app/useQuery';
import { QueryView } from '../../components/states';
import { Avatar } from '../../components/ui';
import { useShell } from '../../shell/context';
import { ThreadPanel } from '../../channels/ThreadPanel';
import { SearchPanel } from '../../search/SearchPanel';
import { registerPanelType } from './registry';
import type { PanelEntry } from './stack';

/*
 * The panel types of the app. `thread` is the channels thread view; `file` shows a repo file or an attachment in its viewer and `history` its commits (screens/files); a plugin can still replace any type with `registerPanelType`.
 */

function Placeholder({ title, detail, children }: { title: string; detail?: string; children: string }) {
  return (
    <div className="panel-empty">
      <p className="panel-empty-title">{title}</p>
      <p className="panel-empty-body">{children}</p>
      {detail ? <p className="panel-empty-id">{detail}</p> : null}
    </div>
  );
}

/** A person on the current team, from the roster. */
function MemberPanel({ entry }: { entry: PanelEntry }) {
  const { team } = useShell();
  const slug = team?.slug ?? '';
  const q = useQuery(`panel-member:${slug}`, () => (slug ? fetchRoster(slug) : Promise.resolve({ members: [] })));
  return (
    <QueryView q={q}>
      {(data) => {
        const m = data.members.find((x) => x.personId === entry.id);
        if (!m) return <Placeholder title="Member">This person is not on the team.</Placeholder>;
        return (
          <div className="panel-member">
            <Avatar name={m.displayName} />
            <div>
              <p className="panel-member-name">{m.displayName}</p>
              <p className="panel-member-line">{m.email}</p>
              <p className="panel-member-line">{m.role === 'lead' ? 'Team lead' : 'Member'}</p>
              {m.tags.length > 0 ? (
                <p className="panel-member-tags">{m.tags.map((t) => <span key={t} className="chip">{t}</span>)}</p>
              ) : null}
            </div>
          </div>
        );
      }}
    </QueryView>
  );
}

registerPanelType({ type: 'thread', label: 'Thread', Component: ThreadPanel });
registerPanelType({ type: 'search', label: 'Search', Component: SearchPanel });
// the file and history panels pull in the viewers' host and the diff: they load when the first file is opened, not with the app
const FilePreview = lazy(() => import('../../screens/files/FilePreview').then((m) => ({ default: m.FilePreview })));
const HistoryPanel = lazy(() => import('../../screens/files/HistoryPanel').then((m) => ({ default: m.HistoryPanel })));
const Loading = <div className="vw-loading" role="status" aria-busy="true">Loading…</div>;
registerPanelType({ type: 'file', label: 'File', Component: ({ entry }) => <Suspense fallback={Loading}><FilePreview entry={entry} /></Suspense> });
registerPanelType({ type: 'history', label: 'History', Component: ({ entry }) => <Suspense fallback={Loading}><HistoryPanel entry={entry} /></Suspense> });
registerPanelType({ type: 'member', label: 'Member', Component: MemberPanel });
