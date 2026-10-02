import { useSession } from '../../app/session';
import { ForbiddenBody, NotFoundBody } from '../../components/states';
import { usePanel } from '../../kernel/panel';
import { FileViewer } from '../../viewers/FileViewer';
import { ViewerMessage } from '../../viewers/common';
import { RowMenu, useRowActions } from './actions';
import { whenLabel } from './FileList';
import { MEMORY_COPY, READ_ONLY_COPY, type FileRow } from './model';
import { useTeamFiles, type TeamFiles } from './store';
import { useContent } from './useContent';
import { useFileRow } from './useFileRow';

/**
 * A file opened in the middle column (as the prototype's history plate shows `bots/coder/BOT.md`): its path and who last changed it, History, and the
 * viewer taking the rest of the column. The right panel stays free for History.
 */
export function FileView({ path, onClose, onMoved, onGone }: { path: string; onClose: () => void; onMoved: (to: string) => void; onGone: () => void }) {
  const files = useTeamFiles();
  const state = useFileRow(files, path);
  if (!files || state.status === 'loading') return <div className="fview" data-landmark="file-view"><p className="loading" aria-busy="true">Loading…</p></div>;
  if (state.status === 'forbidden') return <div className="fview" data-landmark="file-view"><div className="fempty" role="alert"><ForbiddenBody /></div></div>;
  if (state.status === 'missing') return <div className="fview" data-landmark="file-view"><div className="fempty" role="alert"><NotFoundBody /><button type="button" className="btn s" onClick={onClose}>Back to the folder</button></div></div>;
  if (state.status === 'error') return <div className="fview" data-landmark="file-view"><ViewerMessage title="This file could not be loaded" tone="alert">{state.message}</ViewerMessage></div>;
  return <FileViewBody files={files} row={state.row} onClose={onClose} onMoved={onMoved} onGone={onGone} />;
}

function FileViewBody({ files, row, onClose, onMoved, onGone }: { files: TeamFiles; row: FileRow; onClose: () => void; onMoved: (to: string) => void; onGone: () => void }) {
  const panel = usePanel();
  const session = useSession();
  const { content, save } = useContent(files, row);
  const actions = useRowActions(files, { onDone: (r) => (r.action === 'delete' ? onGone() : onMoved(r.to)) });
  const git = row.store === 'git';
  const pr = row.readOnlyReason === 'change_by_pull_request';
  return (
    <div className="fview" data-landmark="file-view" data-testid="file-view" data-path={row.path}>
      <div className="fvh">
        <span className="p" data-testid="file-view-path">{row.path}</span>
        <span className="m" data-vt-mask>{row.modifiedAt ? `updated ${whenLabel(row.modifiedAt)}` : ''}{row.by ? ` by ${row.by.name}` : ''}</span>
        <div className="r">
          {git ? <button type="button" className="btn s" data-testid="open-history" onClick={() => panel.push({ type: 'history', id: row.path })}>History</button> : null}
          <RowMenu row={row} start={actions.start} />
          <button type="button" className="btn s" data-testid="close-file" onClick={onClose}>Close</button>
        </div>
      </div>
      {pr ? (
        <p className="fnote" data-testid="read-only-note" role="note">
          <b>{READ_ONLY_COPY}.</b> You can read this file; a change to it is made by a pull request.{' '}
          <button type="button" className="linkish" data-testid="change-by-pr" onClick={() => actions.start('pull-request', row)}>How to change it</button>
        </p>
      ) : null}
      {row.managedBy ? <p className="fnote memory" role="note"><b>{MEMORY_COPY}.</b> Edits to facts are kept by the team's memory.</p> : null}
      <div className="fvb">
        <FileViewer
          path={row.path}
          {...(row.mime ? { mime: row.mime } : {})}
          source={content.source}
          readOnly={row.readOnly}
          {...(save ? { onSave: save } : {})}
          context={{ teamSlug: files.slug, teamName: files.teamName, authorName: session.person.name }}
        />
      </div>
      {actions.dialog}
    </div>
  );
}
