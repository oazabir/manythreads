import { useMemo } from 'react';
import { isGuardedRepoPath } from '@manythreads/shared';
import { useSession } from '../app/session';
import { usePanelSub } from '../kernel/panel/sub';
import type { PanelEntry } from '../kernel/panel/stack';
import { ViewerMessage } from './common';
import { FileViewer } from './FileViewer';
import { repoFile } from './repoFile';
import { useShell } from '../shell/context';

const isLead = (role: string | undefined): boolean => role === 'lead';

/** The right-panel entry `file:<path>`: a file of the team repo in its viewer. */
export function FilePanel({ entry }: { entry: PanelEntry }) {
  const { team, teamSlug } = useShell();
  const session = useSession();
  const slug = team?.slug ?? teamSlug ?? '';
  const path = entry.id;
  usePanelSub(path.slice(path.lastIndexOf('/') + 1));
  const file = useMemo(() => (slug ? repoFile(slug, path) : null), [slug, path]);

  if (!file) return <ViewerMessage title="Open a team first" />;
  if (path.startsWith('channels/')) {
    return <ViewerMessage title="Attachments open from their message">Open this file from the channel message that holds it.</ViewerMessage>;
  }
  const role = session.teams.find((t) => t.slug === slug)?.role;
  const admin = session.role === 'owner' || session.role === 'admin';
  // bots/, skills/, routines/ and TEAM.md change by pull request unless the person leads the team or administers the workspace
  const readOnly = isGuardedRepoPath(path) && !isLead(role) && !admin;
  return (
    <div className="file-panel">
      <FileViewer
        path={path}
        source={file.source}
        readOnly={readOnly}
        onSave={file.save}
        context={{ teamSlug: slug, teamName: team?.name ?? slug, authorName: session.person.name }}
      />
    </div>
  );
}
