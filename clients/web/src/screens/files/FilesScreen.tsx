import { friendlyPath } from '../../components/friendlyPath';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery } from '../../app/useQuery';
import { Dialog } from '../../components/Dialog';
import { ForbiddenBody } from '../../components/states';
import { usePanel } from '../../kernel/panel';
import { PageHeader } from '../../components/PageHeader';
import { useNarrow } from '../../shell/useNarrow';
import { useRowActions, type MenuEntry, type RowAction } from './actions';
import { FilesError } from './backend';
import { ProposeDialog } from '../proposals/ProposeDialog';
import { useProposalPerms } from '../proposals/store';
import { NewFileDialog, NewFolderDialog, moveRows } from './dialogs';
import { FileList, rowId, type DragApi, type Filters, type View } from './FileList';
import { FileView } from './FileView';
import { inboxLink } from '../memory/inboxWords';
import {
  DEFAULT_SORT,
  GIT_TEXT_ONLY_COPY,
  INBOX_FOLDER,
  ROOT,
  acceptsUploads,
  bytesLabel,
  parentOf,
  rowKey,
  segments,
  type FileRow,
  type Sort,
} from './model';
import { NONE, type Selection } from './selection';
import { PERSONAL, isPersonalKey, personalPanelId, spaceHref } from './spaces';
import { bumpFiles, useAdminFiles, useFileSpaces, useFilesVersion, type TeamFiles } from './store';
import { Tree, treeKey } from './Tree';
import { useFolders } from './useFolders';
import { NewFolderIcon, UploadIcon } from './icons';
import { savePersonalSpaceZip } from './personalApi';

type Upload = { id: number; name: string; state: 'sending' | 'done' | 'error'; fraction: number; message?: string };

const NEW_PAGE_TITLE = 'Create a page in this folder';
const PREF = 'mt.files.prefs';

/** The look a person chose (list or grid, the sort) is theirs alone; it is kept in this browser and the screen works without it. */
function loadPrefs(): { view: View; sort: Sort } {
  const fallback = { view: 'list' as View, sort: DEFAULT_SORT };
  try {
    const raw = window.localStorage.getItem(PREF);
    if (!raw) return fallback;
    const v = JSON.parse(raw) as { view?: unknown; sort?: { key?: unknown; dir?: unknown } };
    const keys = ['name', 'where', 'by', 'modified', 'size'];
    return {
      view: v.view === 'grid' ? 'grid' : 'list',
      sort: v.sort && typeof v.sort.key === 'string' && keys.includes(v.sort.key) && (v.sort.dir === 'asc' || v.sort.dir === 'desc') ? ({ key: v.sort.key, dir: v.sort.dir } as Sort) : DEFAULT_SORT,
    };
  } catch {
    return fallback;
  }
}
function savePrefs(view: View, sort: Sort): void {
  try {
    window.localStorage.setItem(PREF, JSON.stringify({ view, sort }));
  } catch {
    // private window or blocked storage: the look simply is not remembered
  }
}

/** How much of the 5 GiB allowance of Personal is used, as a bar and in words. */
function Quota({ files }: { files: TeamFiles }) {
  const version = useFilesVersion();
  const usage = useQuery(`files-usage:${files.slug}:${version}`, () => (files.personal ? files.personal.usage() : Promise.reject(new Error('no allowance'))));
  if (usage.status !== 'ok') return <div className="fstatus" aria-busy={usage.status === 'loading'} />;
  const { usedBytes, quotaBytes } = usage.data;
  const share = Math.min(1, usedBytes / quotaBytes);
  const level = share >= 1 ? 'full' : share >= 0.9 ? 'high' : 'ok';
  return (
    <div className="fstatus" data-testid="quota">
      <span className={`fquota ${level}`}>
        <span className="fquota-bar" role="meter" aria-label="Personal files used" aria-valuemin={0} aria-valuemax={quotaBytes} aria-valuenow={usedBytes} aria-valuetext={`${bytesLabel(usedBytes)} of ${bytesLabel(quotaBytes)}`}>
          <span className="fquota-fill" style={{ width: `${Math.max(share > 0 ? 2 : 0, Math.round(share * 100))}%` }} />
        </span>
        <span className="fquota-text" data-testid="quota-text">{bytesLabel(usedBytes)} of {bytesLabel(quotaBytes)} used</span>
      </span>
      {level === 'full' ? <span className="fquota-note" role="alert">Your Personal files are full. Delete something to add more.</span> : null}
    </div>
  );
}

/**
 * `/files` (Personal), `/t/:team/files` (that team) and `/files/person/:personId` (an admin's read-only look into one person's Personal space): the tree of
 * every space the person can read, the list of the open folder, the preview in the right panel.
 */
export function FilesScreen() {
  const { team: teamParam, personId } = useParams();
  const spaces = useFileSpaces();
  const admin = useAdminFiles(personId ?? null);
  const navigate = useNavigate();
  const loc = useLocation();
  const [params] = useSearchParams();
  const narrow = useNarrow();
  const panel = usePanel();

  const space = admin ? admin.slug : teamParam !== undefined ? teamParam : PERSONAL;
  const lookup = useCallback((key: string): TeamFiles | null => (admin && key === admin.slug ? admin : spaces.get(key)), [admin, spaces]);
  const files = lookup(space);
  const personal = Boolean(files && files.space === 'personal');
  const adminView = Boolean(admin);

  const open = params.get('open');
  const folder = open ? parentOf(open) : (params.get('path') ?? ROOT);
  // a link to `?path=inbox` lands on the Memory inbox, which is where that folder lives
  const inboxSlug = folder === INBOX_FOLDER && !open && files && !personal ? files.slug : null;
  useEffect(() => {
    if (inboxSlug) void navigate(inboxLink(inboxSlug), { replace: true });
  }, [inboxSlug, navigate]);
  const top = panel.entries.at(-1);
  const current = top?.type === 'file' ? top.id : null;

  const folders = useFolders(lookup);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [filters, setFilters] = useState<Filters>({ type: 'all', source: 'any' });
  const [prefs, setPrefs] = useState(loadPrefs);
  const [sel, setSel] = useState<Selection>(NONE);
  const [dialog, setDialog] = useState<'page' | 'folder' | 'sheet' | 'propose' | null>(null);
  const proposals = useProposalPerms();
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [textOnly, setTextOnly] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [exporting, setExporting] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const depth = useRef(0);
  // set state only while the screen is up: a download or an upload can finish after the person left
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const setView = (view: View): void => {
    setPrefs((p) => ({ ...p, view }));
    savePrefs(view, prefs.sort);
  };
  const setSort = (sort: Sort): void => {
    setPrefs((p) => ({ ...p, sort }));
    savePrefs(prefs.view, sort);
  };

  // the open space and the ancestors of the open folder are open in the tree
  useEffect(() => {
    const parts = segments(folder);
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(treeKey(space, ROOT));
      for (let i = 1; i <= parts.length; i++) next.add(treeKey(space, parts.slice(0, i).join('/')));
      return next.size === prev.size ? prev : next;
    });
  }, [space, folder]);

  // another folder or space starts with nothing selected
  useEffect(() => {
    setSel(NONE);
    setProblem(null);
  }, [space, folder]);

  const wantKey = [...expanded].sort().join('\n');
  useEffect(() => {
    const bySpace = new Map<string, Set<string>>();
    for (const key of [treeKey(space, ROOT), treeKey(space, folder), ...expanded]) {
      const i = key.indexOf('\0');
      const sp = key.slice(0, i);
      const set = bySpace.get(sp) ?? new Set<string>();
      set.add(key.slice(i + 1));
      bySpace.set(sp, set);
    }
    for (const [sp, paths] of bySpace) folders.want(sp, [...paths]);
    // `folders.want` changes with the counter on purpose: it fetches again after a change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folders.want, space, folder, wantKey]);

  const state = folders.get(space, folder);
  const info = state?.listing?.folder;
  const rootState = folders.get(space, ROOT);
  const rows = state?.listing?.rows ?? [];
  const itemCount = rows.length;

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

  const toggle = (sp: string, path: string): void => {
    // the inbox is not a repo folder: it has nothing to expand
    if (path === INBOX_FOLDER && !isPersonalKey(sp)) return;
    const key = treeKey(sp, path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };
  const enterFolder = (sp: string, path: string): void => {
    // the inbox row opens the Memory screen's Inbox tab
    if (path === INBOX_FOLDER && !isPersonalKey(sp) && !adminView) {
      void navigate(inboxLink(sp));
      return;
    }
    setDialog(null);
    if (sp !== space) {
      // another space has its own address
      void navigate(spaceHref(sp, path ? { folder: path } : {}));
      return;
    }
    const key = treeKey(sp, path);
    setExpanded((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    go({ folder: path });
  };
  const idOf = (path: string): string => (files?.space === 'personal' ? personalPanelId(path) : path);
  const openInCentre = (row: FileRow): void => {
    setDialog(null);
    if (row.store === 'attachments') panel.push({ type: 'file', id: rowId(row) });
    else go({ open: row.path });
  };
  // an admin's view has no right-panel entries (they would look in the admin's own space), so a click opens the file in the centre
  const select = (row: FileRow): void => (adminView ? openInCentre(row) : panel.push({ type: 'file', id: rowId(row) }));
  const openFromTree = (sp: string, row: FileRow): void => {
    if (sp === space) {
      openInCentre(row);
      return;
    }
    void navigate(spaceHref(sp, { open: row.path }));
  };

  const spaceFolders = (): string[] => {
    const out = new Set<string>();
    const mine = [ROOT, folder, ...[...expanded].filter((k) => k.startsWith(`${space}\0`)).map((k) => k.slice(space.length + 1))];
    for (const p of mine) for (const r of folders.get(space, p)?.listing?.rows ?? []) if (r.kind === 'folder' && !r.path.startsWith('channels')) out.add(r.path);
    return [...out].sort();
  };

  const rowActions = useRowActions(files, {
    folders: spaceFolders,
    onDone: (r) => {
      setSel(NONE);
      if (r.action === 'delete') {
        if (open === r.from) go({ folder: parentOf(r.from) });
        if (current === idOf(r.from)) panel.close();
      } else if (r.action === 'delete-many') {
        if (open && r.paths.includes(open)) go({ folder });
        if (current && r.paths.some((p) => idOf(p) === current)) panel.close();
      } else if (r.action === 'move-many') {
        if (open && r.paths.includes(open)) go({ folder });
        if (current && r.paths.some((p) => idOf(p) === current)) panel.close();
      } else {
        if (open === r.from) go({ open: r.to });
        if (current === idOf(r.from)) panel.replace({ type: 'file', id: idOf(r.to) });
      }
    },
  });

  // ---- drag to move ----
  const dragged = useRef<{ space: string; rows: FileRow[] }>({ space, rows: [] });
  const [dragKeys, setDragKeys] = useState<ReadonlySet<string>>(new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const canDropIn = (sp: string, path: string): boolean => {
    const d = dragged.current;
    if (d.rows.length === 0 || d.space !== sp) return false;
    // a file already there stays; Personal keeps its files in folders, never at the top
    if (d.rows.every((r) => parentOf(r.path) === path)) return false;
    if (isPersonalKey(sp) && path === ROOT) return false;
    const target = folders.get(sp, path)?.listing?.folder;
    if (target && (target.readOnly || target.store === 'attachments')) return false;
    return true;
  };
  const endDrag = (): void => {
    dragged.current = { space, rows: [] };
    setDragKeys(new Set());
    setDropTarget(null);
  };
  const dropOn = (sp: string, path: string): void => {
    const d = dragged.current;
    const target = lookup(sp);
    endDrag();
    if (!target || d.rows.length === 0 || d.space !== sp) return;
    void moveRows(target, d.rows, path).then((res) => {
      setProblem(res.error);
      if (res.moved.length === 0) return;
      setSel(NONE);
      const moved = d.rows.map((r) => r.path);
      if (open && moved.includes(open)) go({ folder });
      if (current && moved.some((p) => idOf(p) === current)) panel.close();
    });
  };
  const drag: DragApi = {
    start: (row) => {
      const inSel = sel.keys.has(rowKey(row));
      const list = (inSel ? rows.filter((r) => sel.keys.has(rowKey(r))) : [row]).filter((r) => r.kind === 'file');
      dragged.current = { space, rows: list };
      setDragKeys(new Set(list.map(rowKey)));
    },
    end: endDrag,
    can: (path) => canDropIn(space, path),
    over: (path) => dropTarget === treeKey(space, path),
    enter: (path) => setDropTarget((k) => (k === treeKey(space, path) ? k : treeKey(space, path))),
    leave: (path) => setDropTarget((k) => (k === treeKey(space, path) ? null : k)),
    drop: (path) => dropOn(space, path),
    active: dragKeys,
  };

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
  const canUpload = Boolean(info) && !adminView && (personal ? writable && folder !== ROOT : acceptsUploads(folder) ? true : !attachments && writable);
  const canCreate = Boolean(info) && !adminView && !attachments && writable;
  const canPage = canCreate && !(personal && folder === ROOT);

  const uploadTitle = personal && folder === ROOT ? 'Open a folder first: files in Personal live inside a folder.' : folder === 'channels' ? 'Open a channel folder to upload there.' : undefined;
  const actions = adminView ? undefined : (
    <div className="fhead-actions" data-testid="files-actions">
      <button type="button" className="btn s" data-testid="new-page" disabled={!canPage} title={attachments ? 'Pages live in git folders such as pages/.' : personal && folder === ROOT ? 'Open a folder first: notes live inside a folder.' : writable ? (personal ? 'Create a note in this folder' : NEW_PAGE_TITLE) : 'This folder changes by proposal'} onClick={() => setDialog('page')}>{personal ? 'New note' : 'New page'}</button>
      {info?.readOnlyReason === 'change_by_pull_request' ? (
        <button type="button" className="btn s" data-testid="propose-new-file" title="Propose a new file in this folder" onClick={() => setDialog('propose')}>Propose a file</button>
      ) : null}
      <button type="button" className="btn s" data-testid="new-folder" disabled={!canCreate} title={attachments ? 'Channel folders come with their channels.' : undefined} onClick={() => setDialog('folder')}><NewFolderIcon /> New folder</button>
      <button type="button" className="btn s p" data-testid="upload" disabled={!canUpload} title={uploadTitle} onClick={() => picker.current?.click()}><UploadIcon /> Upload</button>
      <input ref={picker} type="file" multiple hidden data-testid="upload-input" aria-label="Choose files to upload" onChange={(e) => onPick(e.target.files)} />
    </div>
  );

  const emptyEntries: MenuEntry[] = [];
  if (!adminView) {
    if (canPage) emptyEntries.push({ id: 'new-page', label: personal ? 'New note' : 'New page', run: () => setDialog('page') });
    if (canCreate) emptyEntries.push({ id: 'new-folder', label: 'New folder', run: () => setDialog('folder') });
    if (canUpload) emptyEntries.push({ id: 'upload', label: 'Upload files…', run: () => picker.current?.click() });
  }

  const meta = admin?.personal?.admin?.() ?? null;
  const personName = meta?.displayName ?? 'this person';
  const exportZip = (): void => {
    if (!personId || exporting) return;
    setExporting(true);
    const name = `${personName.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'personal'}-files.zip`;
    // called straight from the click: the browser's "save as" window needs it
    savePersonalSpaceZip(personId, name).then(
      () => {
        if (alive.current) setExporting(false);
      },
      (err: unknown) => {
        if (!alive.current) return;
        setProblem(err instanceof Error ? err.message : 'The download could not be made.');
        setExporting(false);
      },
    );
  };
  const notice = (
    <>
      {adminView ? (
        <p className="fnote admin" role="status" data-testid="admin-view-note">
          <span>
            <b>You are reading {personName}’s Personal space.</b> It is read-only, and {personName} can see that you opened it.
            {meta ? <> Your access ends at <span data-vt-mask>{new Date(meta.validUntil).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>.</> : null}
          </span>
          <span className="fnote-actions">
            <button type="button" className="btn s" disabled={exporting || !meta} data-testid="admin-view-export" onClick={exportZip}>{exporting ? 'Preparing…' : 'Download as zip'}</button>
            <Link className="btn s" to="/settings/workspace/members" data-testid="admin-view-close">Close</Link>
          </span>
        </p>
      ) : null}
      {problem ? (
        <div className="fnote alert" role="alert" data-testid="move-problem">
          <span>{problem}</span>
          <button type="button" className="btn s" onClick={() => setProblem(null)}>Dismiss</button>
        </div>
      ) : null}
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
  );

  const tree = (
    <Tree
      personal={admin ?? spaces.personal}
      teams={admin ? [] : spaces.teams}
      folders={folders}
      space={space}
      folder={folder}
      open={open}
      expanded={expanded}
      onToggle={toggle}
      onFolder={enterFolder}
      onFile={openFromTree}
      dropTarget={dropTarget}
      canDrop={canDropIn}
      onDragTarget={setDropTarget}
      onDropOn={dropOn}
    />
  );

  if (!files) {
    // a guest has no Personal space; before the team list arrives there is nothing to show yet
    if (space === PERSONAL && spaces.personal === null) {
      return (
        <div className="view-empty" data-testid="files-no-personal">
          <p className="view-empty-title">Personal files are not available here.</p>
          <p className="view-empty-body">A guest works in the channels that were shared with them.</p>
        </div>
      );
    }
    return <div className="view-empty" aria-busy="true" />;
  }
  if (adminView && rootState?.status === 'error' && !rootState.listing && rootState.code === 'forbidden') {
    // the hour lapsed, or the space was never opened: the server asks for a reason first
    return (
      <div className="view-empty" role="alert" data-testid="admin-view-closed">
        <p className="view-empty-title">Open this Personal space first.</p>
        <p className="view-empty-body">An admin opens a person’s Personal space for an hour, with a reason the person can see.</p>
        <Link className="btn s" to="/settings/workspace/members">Go to Members</Link>
      </div>
    );
  }
  if (rootState?.status === 'error' && !rootState.listing) {
    return (
      <div className="view-empty" role="alert" data-testid="files-denied">
        {rootState.code === 'forbidden' ? <ForbiddenBody /> : <p className="view-empty-title">The files could not be loaded.</p>}
      </div>
    );
  }

  const emptyHint = adminView
    ? 'There are no files in this folder.'
    : personal
    ? 'Drop files here, choose Upload, or create a note or a folder.'
    : info?.store === 'attachments' && folder !== 'channels'
      ? 'Files posted in this channel show up here. Upload one to add it.'
      : folder === 'channels'
        ? 'A folder appears here for each channel you can read.'
        : 'Create a page or a folder, or upload a text file.';

  const dropWords = !canUpload ? (personal && !adminView && folder === ROOT ? 'Open a folder first to drop files' : 'Files cannot be added here') : `Drop to upload to ${folder === ROOT ? files.teamName : friendlyPath(folder)}`;
  const description = adminView ? `Reading ${personName}’s Personal space` : open ? friendlyPath(open) : `${itemCount} ${itemCount === 1 ? 'item' : 'items'}`;

  return (
    <div
      className="files"
      data-testid="files-screen"
      data-space={space}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        depth.current += 1;
        setDropping(true);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = canUpload ? 'copy' : 'none';
      }}
      onDragLeave={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDropping(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        depth.current = 0;
        setDropping(false);
        if (canUpload) void upload([...e.dataTransfer.files]);
        else if (!personal) setTextOnly((n) => [...n, ...[...e.dataTransfer.files].map((f) => f.name)]);
      }}
    >
      <PageHeader title="Files" description={description} actions={narrow ? undefined : actions} />
      <div className="fbody">
        {narrow ? null : tree}
        {open ? (
          <div className="flist file-open" data-landmark="list">
            <FileCrumb narrow={narrow} onBrowse={() => setDialog('sheet')} />
            <FileView key={`${space}:${open}`} files={files} path={open} onClose={() => go({ folder })} onMoved={(to) => go({ open: to })} onGone={() => go({ folder })} />
          </div>
        ) : (
          <FileList
            files={files}
            folder={folder}
            info={info}
            state={state}
            current={current}
            filters={filters}
            onFilters={setFilters}
            sort={prefs.sort}
            onSort={setSort}
            view={prefs.view}
            onView={setView}
            sel={sel}
            onSel={setSel}
            onFolder={(path) => enterFolder(space, path)}
            onSelect={select}
            onOpen={openInCentre}
            onAction={(a: RowAction, r: FileRow) => rowActions.start(a, r)}
            onActionMany={(a, list) => rowActions.startMany(a, list)}
            onBrowse={narrow ? () => setDialog('sheet') : undefined}
            onOpenApp={() => go({ open: folder })}
            actions={narrow ? actions : undefined}
            notice={notice}
            footer={personal && !adminView ? <Quota files={files} /> : undefined}
            drag={drag}
            emptyEntries={emptyEntries}
            emptyHint={emptyHint}
          />
        )}
        {dropping ? (
          <div className={`fdrop ${canUpload ? '' : 'no'}`} role="presentation" data-testid="drop-overlay">
            <span className="fdrop-card"><UploadIcon /> {dropWords}</span>
          </div>
        ) : null}
      </div>
      {dialog === 'propose' ? <ProposeDialog slug={proposals.slug} path={folder === '' ? '' : `${folder}/`} mode="new" canApply={proposals.canApply} onClose={() => { setDialog(null); bumpFiles(); }} /> : null}
      {dialog === 'page' ? <NewFileDialog files={files} folder={folder} onClose={() => setDialog(null)} onDone={(path) => { setDialog(null); go({ open: path }); }} /> : null}
      {dialog === 'folder' ? <NewFolderDialog files={files} folder={folder} onClose={() => setDialog(null)} onDone={(path) => { setDialog(null); enterFolder(space, path); }} /> : null}
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
