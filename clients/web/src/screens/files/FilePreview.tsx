import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { fileKind, fileSize } from '../../channels/format';
import { ForbiddenBody } from '../../components/states';
import { usePanel } from '../../kernel/panel';
import { usePanelSub, usePanelTitle } from '../../kernel/panel/sub';
import { FileViewer } from '../../viewers/FileViewer';
import { ViewerMessage } from '../../viewers/common';
import { useSession } from '../../app/session';
import { RowMenu, useRowActions } from './actions';
import { whenLabel } from './FileList';
import { READ_ONLY_COPY, MEMORY_COPY, isPage, parentOf, type FileRow } from './model';
import { filesHref } from './paths';
import { useTeamFiles, type TeamFiles } from './store';
import { useContent } from './useContent';
import { useFileRow } from './useFileRow';

/** The line under the title: where a page lives and who last changed it, or what an attachment is. */
export function describe(row: FileRow): string {
  if (row.store === 'attachments') {
    const kind = fileKind(row.name, row.mime ?? '');
    return [row.size === null ? null : fileSize(row.size), kind.label].filter(Boolean).join(' · ');
  }
  const folder = parentOf(row.path);
  return [folder === '' ? 'Top folder' : folder, row.by ? `updated by ${row.by.name}` : null, row.modifiedAt ? whenLabel(row.modifiedAt) : null].filter(Boolean).join(' · ');
}

function Kv({ row, files }: { row: FileRow; files: TeamFiles }) {
  const channel = row.where?.replace(/^#\s*/, '') ?? null;
  return (
    <dl className="fp-kv" data-testid="file-details">
      <dt>Path</dt>
      <dd className="mono" data-testid="file-path">{row.path}</dd>
      {row.by ? (<><dt>Posted by</dt><dd data-vt-mask>{row.by.name}</dd></>) : null}
      {channel ? (<><dt>In</dt><dd>{`# ${channel}`}</dd></>) : null}
      <dt>Visible to</dt>
      <dd>{row.store === 'attachments' && channel ? `Everyone who can read # ${channel}` : `${files.teamName} team`}</dd>
    </dl>
  );
}

/**
 * The right-panel entry `file:<id>`: a file of the team repo (by path) or an attachment (by file id) in its viewer, with what a person can do
 * with it. A page under `pages/` opens as a read view with Edit; History is the next panel on the stack.
 */
export function FilePreview({ entry }: { entry: { type: string; id: string } }) {
  const files = useTeamFiles();
  const state = useFileRow(files, entry.id);
  const row = state.status === 'ok' ? state.row : null;
  usePanelTitle(row?.name ?? null);
  usePanelSub(row ? describe(row) : null);

  if (!files || state.status === 'loading') return <div className="vw-loading" role="status" aria-busy="true">Loading…</div>;
  if (state.status === 'forbidden') return <div className="panel-empty"><ForbiddenBody /></div>;
  if (state.status === 'missing') return <div className="panel-empty" role="alert"><ViewerMessage title="This file no longer exists">It may have been moved, renamed or deleted.</ViewerMessage></div>;
  if (state.status === 'error' || !row) return <ViewerMessage title="This file could not be loaded" tone="alert">{state.status === 'error' ? state.message : null}</ViewerMessage>;
  return <PreviewBody key={row.fileId ?? row.path} files={files} row={row} />;
}

function PreviewBody({ files, row }: { files: TeamFiles; row: FileRow }) {
  const navigate = useNavigate();
  const panel = usePanel();
  const session = useSession();
  const git = row.store === 'git';
  const page = git && isPage(row.path);
  const [editing, setEditing] = useState(false);
  const { content, save } = useContent(files, row);
  const folder = parentOf(row.path);
  const actions = useRowActions(files, {
    onDone: (r) => {
      if (r.action === 'delete') panel.close();
      else panel.replace({ type: 'file', id: r.to });
    },
  });
  const reading = page && !editing;
  const pr = row.readOnlyReason === 'change_by_pull_request';
  const canEdit = git && !row.readOnly && Boolean(save);

  return (
    <div className={`fp ${reading ? 'reading' : ''}`} data-testid="file-preview" data-store={row.store} data-path={row.path}>
      <div className="fp-bar" data-testid="file-actions">
        {git ? <button type="button" className="btn s" data-testid="open-history" onClick={() => panel.push({ type: 'history', id: row.path })}>History</button> : null}
        <button type="button" className="btn s" data-testid="open-in-files" onClick={() => void navigate(filesHref(files.slug, git ? { folder, open: row.path } : { folder, panel: `file:${row.fileId ?? row.path}` }))}>Open in Files</button>
        {page && canEdit ? <button type="button" className="btn s" aria-pressed={editing} onClick={() => setEditing((e) => !e)}>{editing ? 'Done' : 'Edit'}</button> : null}
        {row.store === 'attachments' && row.where ? <Link className="btn s" to={`/t/${encodeURIComponent(files.slug)}/c/${encodeURIComponent(row.where.replace(/^#\s*/, ''))}`}>Open channel</Link> : null}
        <span className="fp-spacer" />
        <RowMenu row={row} start={actions.start} />
      </div>
      {pr ? (
        <p className="fnote" data-testid="read-only-note" role="note">
          <b>{READ_ONLY_COPY}.</b> You can read this file; a change to it is made by a pull request.{' '}
          <button type="button" className="linkish" data-testid="change-by-pr" onClick={() => actions.start('pull-request', row)}>How to change it</button>
        </p>
      ) : null}
      {row.managedBy ? <p className="fnote memory" role="note"><b>{MEMORY_COPY}.</b> Edits to facts are kept by the team's memory.</p> : null}
      <FileViewer
        path={row.path}
        {...(row.mime ? { mime: row.mime } : {})}
        source={content.source}
        readOnly={reading || row.readOnly}
        {...(save ? { onSave: save } : {})}
        context={{ teamSlug: files.slug, teamName: files.teamName, authorName: session.person.name }}
      />
      {row.store === 'attachments' ? <Kv row={row} files={files} /> : null}
      {actions.dialog}
    </div>
  );
}
