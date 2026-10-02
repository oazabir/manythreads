import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { Dialog } from '../../components/Dialog';
import { ForbiddenBody } from '../../components/states';
import { usePanel } from '../../kernel/panel';
import { useHeaderTopic, useHeaderActionsSlot } from '../../shell/topic';
import { useNarrow } from '../../shell/useNarrow';
import { useRowActions, type RowAction } from './actions';
import { FilesError } from './backend';
import { NewFileDialog, NewFolderDialog } from './dialogs';
import { FileList, rowId, type Filters } from './FileList';
import { FileView } from './FileView';
import { GIT_TEXT_ONLY_COPY, ROOT, acceptsUploads, parentOf, segments, type FileRow } from './model';
import { bumpFiles, useTeamFiles } from './store';
import { Tree } from './Tree';
import { useFolders } from './useFolders';

type Upload = { id: number; name: string; state: 'sending' | 'done' | 'error'; fraction: number; message?: string };

const NEW_PAGE_TITLE = 'Create a page in this folder';

/** `/t/:team/files`: the team's one tree (repo and attachments), the list of the open folder, the preview in the right panel. */
export function FilesScreen() {
  const files = useTeamFiles();
  const navigate = useNavigate();
  const loc = useLocation();
  const [params] = useSearchParams();
  const narrow = useNarrow();
  const panel = usePanel();
  const slot = useHeaderActionsSlot();

  const open = params.get('open');
  const folder = open ? parentOf(open) : (params.get('path') ?? ROOT);
  const top = panel.entries.at(-1);
  const current = top?.type === 'file' ? top.id : null;

  const folders = useFolders(files);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [filters, setFilters] = useState<Filters>({ type: 'all', source: 'any', order: 'recent' });
  const [dialog, setDialog] = useState<'page' | 'folder' | 'sheet' | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [textOnly, setTextOnly] = useState<string[]>([]);
  const [dropping, setDropping] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  // the ancestors of the open folder are open in the tree
  useEffect(() => {
    const parts = segments(folder);
    setExpanded((prev) => {
      const next = new Set(prev);
      for (let i = 1; i <= parts.length; i++) next.add(parts.slice(0, i).join('/'));
      return next.size === prev.size ? prev : next;
    });
  }, [folder]);

  const wantKey = [...expanded].sort().join('\0');
  useEffect(() => {
    folders.want([ROOT, folder, ...expanded]);
    // `folders.want` changes with the counter on purpose: it fetches again after a change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folders.want, folder, wantKey]);

  const state = folders.get(folder);
  const info = state?.listing?.folder;
  const rootState = folders.get(ROOT);
  const rows = state?.listing?.rows ?? [];
  const fileCount = rows.filter((r) => r.kind === 'file').length;
  useHeaderTopic(files ? (open ? `${files.teamName} · ${open}` : folder === ROOT ? `${files.teamName} · team repo` : `${files.teamName} · ${fileCount} ${fileCount === 1 ? 'file' : 'files'}`) : null);

  const go = useCallback(
    (next: { folder?: string; open?: string | null }): void => {
      const q = new URLSearchParams(loc.search);
      if (next.folder !== undefined) {
        if (next.folder === ROOT) q.delete('path');
        else q.set('path', next.folder);
      }
      if (next.open === null || next.folder !== undefined) q.delete('open');
      if (typeof next.open === 'string') {
        q.set('open', next.open);
        q.delete('path');
      }
      const s = q.toString();
      void navigate({ pathname: loc.pathname, search: s ? `?${s}` : '' }, { state: loc.state as unknown });
    },
    [loc.pathname, loc.search, loc.state, navigate],
  );

  const toggle = (path: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  const enterFolder = (path: string): void => {
    setExpanded((prev) => (prev.has(path) || path === ROOT ? prev : new Set(prev).add(path)));
    setDialog(null);
    go({ folder: path });
  };
  const select = (row: FileRow): void => panel.push({ type: 'file', id: rowId(row) });
  const openInCentre = (row: FileRow): void => {
    setDialog(null);
    if (row.store === 'git') go({ open: row.path });
    else select(row);
  };

  const rowActions = useRowActions(files, {
    folders: () => {
      const out = new Set<string>();
      for (const p of [ROOT, folder, ...expanded]) for (const r of folders.get(p)?.listing?.rows ?? []) if (r.kind === 'folder' && !r.path.startsWith('channels')) out.add(r.path);
      return [...out].sort();
    },
    onDone: (r) => {
      if (r.action === 'delete') {
        if (open === r.from) go({ folder: parentOf(r.from) });
        if (current === r.from) panel.close();
      } else {
        if (open === r.from) go({ open: r.to });
        if (current === r.from) panel.replace({ type: 'file', id: r.to });
      }
    },
  });

  // ---- upload ----
  const upload = async (list: File[]): Promise<void> => {
    if (!files || !info || list.length === 0) return;
    const target = { path: folder, channelId: info.channelId };
    for (const file of list) {
      const id = ++seq.current;
      setUploads((u) => [...u, { id, name: file.name, state: 'sending', fraction: 0 }]);
      try {
        await files.backend.upload(target, file, (fraction) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, fraction } : x))));
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, state: 'done', fraction: 1 } : x)));
        bumpFiles();
        window.setTimeout(() => setUploads((u) => u.filter((x) => x.id !== id)), 2500);
      } catch (err) {
        if (err instanceof FilesError && err.code === 'text_only') {
          setUploads((u) => u.filter((x) => x.id !== id));
          setTextOnly((n) => [...n, file.name]);
        } else {
          setUploads((u) => u.map((x) => (x.id === id ? { ...x, state: 'error', message: err instanceof Error ? err.message : 'The upload failed.' } : x)));
        }
      }
    }
  };
  const onPick = (list: FileList | null): void => {
    const chosen = list ? [...list] : [];
    if (picker.current) picker.current.value = '';
    void upload(chosen);
  };

  const writable = info ? !info.readOnly : false;
  const attachments = info?.store === 'attachments';
  const canUpload = Boolean(info) && (acceptsUploads(folder) ? true : !attachments && writable);
  const canCreate = Boolean(info) && !attachments && writable;

  const actions = (
    <div className="fhead-actions" data-testid="files-actions">
      <button type="button" className="btn s" data-testid="new-page" disabled={!canCreate} title={attachments ? 'Pages live in git folders such as pages/.' : writable ? NEW_PAGE_TITLE : 'Change by pull request'} onClick={() => setDialog('page')}>New page</button>
      <button type="button" className="btn s" data-testid="new-folder" disabled={!canCreate} title={attachments ? 'Channel folders come with their channels.' : undefined} onClick={() => setDialog('folder')}>New folder</button>
      <button type="button" className="btn s p" data-testid="upload" disabled={!canUpload} title={folder === 'channels' ? 'Open a channel folder to upload there.' : undefined} onClick={() => picker.current?.click()}>Upload</button>
      <input ref={picker} type="file" multiple hidden data-testid="upload-input" aria-label="Choose files to upload" onChange={(e) => onPick(e.target.files)} />
    </div>
  );

  const notice = useMemo(
    () => (
      <>
        {textOnly.length > 0 ? (
          <div className="fnote alert" role="alert" data-testid="upload-text-only">
            <span>
              <b>{textOnly.length === 1 ? textOnly[0] : `${textOnly.length} files`} was not uploaded.</b> {GIT_TEXT_ONLY_COPY}
            </span>
            <button type="button" className="btn s" onClick={() => setTextOnly([])}>Dismiss</button>
          </div>
        ) : null}
        {uploads.length > 0 ? (
          <ul className="fup" data-testid="upload-list" aria-label="Uploads">
            {uploads.map((u) => (
              <li key={u.id} className={`fup-row ${u.state}`}>
                <span className="fup-name">{u.name}</span>
                {u.state === 'sending' ? <progress max={1} value={u.fraction} aria-label={`Uploading ${u.name}`} /> : u.state === 'done' ? <span className="fup-state">Uploaded</span> : <span className="fup-state" role="alert">{u.message}</span>}
                {u.state === 'error' ? <button type="button" className="btn s" onClick={() => setUploads((x) => x.filter((y) => y.id !== u.id))}>Dismiss</button> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </>
    ),
    [textOnly, uploads],
  );

  if (!files) return <div className="view-empty" aria-busy="true" />;
  if (rootState?.status === 'error' && !rootState.listing) {
    return (
      <div className="view-empty" role="alert" data-testid="files-denied">
        {rootState.code === 'forbidden' ? <ForbiddenBody /> : <p className="view-empty-title">The files could not be loaded.</p>}
      </div>
    );
  }

  const tree = (
    <Tree
      teamName={files.teamName}
      get={folders.get}
      expanded={expanded}
      folder={folder}
      open={open}
      onToggle={toggle}
      onFolder={enterFolder}
      onFile={openInCentre}
    />
  );

  return (
    <div
      className="files"
      data-testid="files-screen"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropping(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDropping(false);
        if (canUpload) void upload([...e.dataTransfer.files]);
        else setTextOnly((n) => [...n, ...[...e.dataTransfer.files].map((f) => f.name)]);
      }}
    >
      {!narrow && slot ? createPortal(actions, slot) : null}
      <div className="fbody">
        {narrow ? null : tree}
        {open ? (
          <div className="flist file-open" data-landmark="list">
            <FileCrumb narrow={narrow} onBrowse={() => setDialog('sheet')} />
            <FileView key={open} path={open} onClose={() => go({ folder })} onMoved={(to) => go({ open: to })} onGone={() => go({ folder })} />
          </div>
        ) : (
          <FileList
            teamName={files.teamName}
            folder={folder}
            info={info}
            state={state}
            selected={current}
            filters={filters}
            onFilters={setFilters}
            onFolder={enterFolder}
            onSelect={select}
            onOpen={openInCentre}
            onAction={(a: RowAction, r: FileRow) => rowActions.start(a, r)}
            onBrowse={narrow ? () => setDialog('sheet') : undefined}
            onOpenApp={() => go({ open: folder })}
            actions={narrow ? actions : undefined}
            notice={notice}
            dropping={dropping}
          />
        )}
      </div>
      {dialog === 'page' ? <NewFileDialog files={files} folder={folder} onClose={() => setDialog(null)} onDone={(path) => { setDialog(null); go({ open: path }); }} /> : null}
      {dialog === 'folder' ? <NewFolderDialog files={files} folder={folder} onClose={() => setDialog(null)} onDone={(path) => { setDialog(null); enterFolder(path); }} /> : null}
      {dialog === 'sheet' ? (
        <Dialog title="Folders" onClose={() => setDialog(null)} testId="folder-sheet" sheet>
          {tree}
        </Dialog>
      ) : null}
      {rowActions.dialog}
    </div>
  );
}

/** The breadcrumb above a file opened in the centre; on a phone it carries the folder-sheet button. */
function FileCrumb({ narrow, onBrowse }: { narrow: boolean; onBrowse: () => void }) {
  if (!narrow) return null;
  return (
    <nav className="crumb" aria-label="Breadcrumb">
      <button type="button" className="btn s browse" onClick={onBrowse} aria-label="Browse folders" data-testid="browse-folders">Folders</button>
    </nav>
  );
}

