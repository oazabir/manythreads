import type { FetchedDocumentKind, RemoteDocument } from '@manythreads/sdk';
import type { ConnectorRoot } from '@manythreads/shared';
import { safeId, type AdapterCtx, type DocAdapter } from './adapter.ts';
import { DocError, MAX_DOCUMENT_BYTES, MAX_PENDING_FOLDERS, accessAnswer, arr, capped, decodeState, encodeState, enc, isStr, kindOfFile, nameOf, rec, str, unreadableAccess, unreadableOrThrow } from './http.ts';

// Google Drive (PLAN Bundle D, P16-08, decisions D13 and D14). Read only, with the person's own `drive.readonly` grant.
//   * First pass (no cursor): the change feed's start token is taken FIRST, then the folder tree under the root is walked one folder page per call. The token taken before
//     the walk is the cursor when the walk ends, so a file edited during the walk is seen again by the next pass, never missed.
//   * Later passes: `changes.list` from the stored token. A change is kept when the file is under the root (its parents are followed up, at most 25 levels, each looked
//     up once); a removed or trashed file is reported removed whether or not it can still be placed. A file moved out of the root is not reported (the feed does not
//     say where a file used to be); the knowledge side drops it when the source is read in full again.
//   * Google Docs come out as plain text, Sheets as the CSV of the first sheet, Slides as plain text; uploaded files by their own kind.

const FILE_FIELDS = 'id,name,mimeType,modifiedTime,version,size,trashed,parents,driveId,webViewLink';
const FOLDER = 'application/vnd.google-apps.folder';
const GDOC = 'application/vnd.google-apps.document';
const GSHEET = 'application/vnd.google-apps.spreadsheet';
const GSLIDES = 'application/vnd.google-apps.presentation';
const ALL_DRIVES = { supportsAllDrives: true, includeItemsFromAllDrives: true } as const;
const PAGE = 100;

type State = { k: 'walk'; start: string; stack: Array<{ id: string; pt: string | null }> } | { k: 'chg'; t: string };
const isState = (v: Record<string, unknown>): v is State & Record<string, unknown> =>
  (v['k'] === 'chg' && isStr(v['t'])) ||
  (v['k'] === 'walk' && isStr(v['start']) && Array.isArray(v['stack']) && v['stack'].length <= MAX_PENDING_FOLDERS && v['stack'].every((e) => isStr(rec(e)['id'], 300) && (rec(e)['pt'] === null || isStr(rec(e)['pt']))));

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  version: string;
  url: string | null;
  trashed: boolean;
  parents: string[];
  driveId: string | null;
}
function fileOf(v: unknown): DriveFile | null {
  const r = rec(v);
  const id = str(r['id'], 300);
  const mimeType = str(r['mimeType'], 200);
  if (!id || !mimeType) return null;
  return {
    id,
    name: nameOf(r['name'], id),
    mimeType,
    version: str(r['version'], 40) ?? str(r['modifiedTime'], 40) ?? '0',
    url: str(r['webViewLink'], 1000),
    trashed: r['trashed'] === true,
    parents: arr(r['parents']).filter((p): p is string => typeof p === 'string'),
    driveId: str(r['driveId'], 300),
  };
}

/** What a Drive file becomes: Docs and Slides as text, Sheets as CSV, uploads by their own kind; null for what the reader does not take. */
function kindOf(f: Pick<DriveFile, 'name' | 'mimeType'>): FetchedDocumentKind | null {
  if (f.mimeType === GDOC || f.mimeType === GSLIDES) return 'text';
  if (f.mimeType === GSHEET) return 'csv';
  if (f.mimeType.startsWith('application/vnd.google-apps.')) return null;
  return kindOfFile(f.name, f.mimeType);
}
const remote = (f: DriveFile, kind: FetchedDocumentKind): RemoteDocument => ({ remoteId: f.id, name: f.name, kind, version: f.version, url: f.url, removed: false });

async function parentsOf(ctx: AdapterCtx, id: string): Promise<{ parents: string[]; driveId: string | null } | null> {
  return ctx.memo.get(`${ctx.prefix}:gd:parents:${id}`, async () => {
    try {
      const r = rec(await ctx.http.json(`/drive/v3/files/${enc(id)}`, { query: { fields: 'id,parents,driveId', supportsAllDrives: true }, doc: true }));
      return { parents: arr(r['parents']).filter((p): p is string => typeof p === 'string'), driveId: str(r['driveId'], 300) };
    } catch (err) {
      if (err instanceof DocError && (err.code === 'not_found' || err.code === 'scope_missing')) return null;
      throw err;
    }
  });
}

/** True when the file sits under `root`: `root` itself is one of its ancestors, or (My Drive as a whole) the chain ends at the top of My Drive. */
async function underRoot(ctx: AdapterCtx, root: string, file: DriveFile): Promise<boolean> {
  if (file.driveId !== null) {
    if (file.driveId === root) return true;
  }
  const myDrive = root === 'root';
  if (file.parents.length === 0) return myDrive && file.driveId === null;
  let frontier = file.parents;
  let reachedTop = false;
  const seen = new Set<string>();
  let lookups = 0;
  for (let depth = 0; depth < 25 && frontier.length > 0; depth++) {
    if (frontier.includes(root)) return true;
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (++lookups > 60) return false;
      const info = await parentsOf(ctx, id);
      if (!info) continue;
      if (info.driveId !== null && info.driveId === root) return true;
      if (info.parents.length > 0) next.push(...info.parents);
      else if (info.driveId === null) reachedTop = true;
    }
    frontier = next;
  }
  return myDrive && reachedTop;
}

async function startState(ctx: AdapterCtx, root: string): Promise<State> {
  const answer = rec(await ctx.http.json('/drive/v3/changes/startPageToken', { query: { supportsAllDrives: true } }));
  const start = str(answer['startPageToken'], 500);
  if (!start) throw new DocError('provider_down', `${ctx.http.label} did not give a starting point.`);
  return { k: 'walk', start, stack: [{ id: root, pt: null }] };
}

export const googleDrive: DocAdapter = {
  async listRoots(ctx) {
    const roots: ConnectorRoot[] = [{ id: 'root', name: 'My Drive', kind: 'folder', parent: null }];
    const folders = rec(
      await ctx.http.json('/drive/v3/files', {
        query: { q: `'root' in parents and mimeType = '${FOLDER}' and trashed = false`, pageSize: 200, fields: 'files(id,name)', orderBy: 'name', ...ALL_DRIVES },
      }),
    );
    for (const f of arr(folders['files'])) {
      const id = str(rec(f)['id'], 300);
      if (id && safeId(id)) roots.push({ id, name: nameOf(rec(f)['name'], id), kind: 'folder', parent: 'My Drive' });
    }
    // shared drives: best effort (a grant without them, or an older service, just has none)
    try {
      const drives = rec(await ctx.http.json('/drive/v3/drives', { query: { pageSize: 100, fields: 'drives(id,name)' } }));
      for (const d of arr(drives['drives'])) {
        const id = str(rec(d)['id'], 300);
        if (id && safeId(id)) roots.push({ id, name: nameOf(rec(d)['name'], id), kind: 'drive', parent: null });
      }
    } catch (err) {
      if (!(err instanceof DocError) || err.code === 'not_connected') throw err;
    }
    return roots.slice(0, 200);
  },

  async listChanges(ctx, { root, cursor }) {
    if (!safeId(root)) throw new DocError('not_found', 'That folder is not one this reader can open.');
    let state = decodeState<State>(cursor, isState) ?? (await startState(ctx, root));
    for (let attempt = 0; ; attempt++) {
      try {
        return state.k === 'walk' ? await walkStep(ctx, root, state) : await changesStep(ctx, root, state);
      } catch (err) {
        // the stored point is no longer valid (Drive keeps change tokens for a limited time): start over once with a full listing; unchanged files are skipped by version
        if (err instanceof DocError && state.k === 'chg' && attempt === 0 && (err.status === 400 || err.status === 410)) {
          state = await startState(ctx, root);
          continue;
        }
        throw err;
      }
    }
  },

  async fetch(ctx, remoteId) {
    if (!safeId(remoteId)) throw new DocError('not_found', 'That file is not one this reader can open.');
    const meta = rec(await ctx.http.json(`/drive/v3/files/${enc(remoteId)}`, { query: { fields: 'id,name,mimeType,size,trashed', supportsAllDrives: true }, doc: true }));
    const file = fileOf(meta);
    if (!file || file.trashed) throw new DocError('not_found', `${ctx.http.label} has no such file any more.`);
    const kind = kindOf(file);
    if (!kind) throw new DocError('not_found', 'That kind of file is not read.');
    if (file.mimeType.startsWith('application/vnd.google-apps.')) {
      const got = await ctx.http.bytes(`/drive/v3/files/${enc(remoteId)}/export`, { query: { mimeType: kind === 'csv' ? 'text/csv' : 'text/plain' }, doc: true }, MAX_DOCUMENT_BYTES);
      return capped(ctx.http.label, got, kind);
    }
    const size = Number(str(meta['size'], 20) ?? '0');
    if (Number.isFinite(size) && size > MAX_DOCUMENT_BYTES && ['pdf', 'docx', 'xlsx', 'pptx'].includes(kind)) throw new DocError('not_found', 'That file is too large to be read.');
    const got = await ctx.http.bytes(`/drive/v3/files/${enc(remoteId)}`, { query: { alt: 'media', supportsAllDrives: true }, doc: true }, MAX_DOCUMENT_BYTES);
    return capped(ctx.http.label, got, kind);
  },

  async access(ctx, remoteId) {
    if (!safeId(remoteId)) return unreadableAccess();
    try {
      let anyone = false;
      let groups = false;
      const domains: string[] = [];
      const users: string[] = [];
      let pageToken: string | undefined;
      for (let page = 0; ; page++) {
        const answer = rec(
          await ctx.http.json(`/drive/v3/files/${enc(remoteId)}/permissions`, {
            query: { fields: 'nextPageToken,permissions(type,role,emailAddress,domain,deleted)', pageSize: 100, supportsAllDrives: true, ...(pageToken ? { pageToken } : {}) },
            doc: true,
          }),
        );
        const list = answer['permissions'];
        if (!Array.isArray(list)) return unreadableAccess();
        for (const p of list) {
          const r = rec(p);
          if (r['deleted'] === true) continue;
          const type = str(r['type'], 20);
          if (type === 'anyone') anyone = true;
          else if (type === 'domain') {
            const d = str(r['domain'], 255);
            if (d) domains.push(d);
            else groups = true;
          } else if (type === 'user') {
            const e = str(r['emailAddress'], 320);
            if (e) users.push(e);
            else groups = true;
          } else groups = true; // a group, or a kind of sharing this reader does not know
        }
        const more = str(answer['nextPageToken'], 1000);
        if (!more) break;
        // a long list is read for three pages and then taken as "shared widely": never as "shared with nobody"
        if (page >= 2) {
          groups = true;
          break;
        }
        pageToken = more;
      }
      return accessAnswer({ anyone, domains, users, groups });
    } catch (err) {
      return unreadableOrThrow(err);
    }
  },
};

async function walkStep(ctx: AdapterCtx, root: string, state: Extract<State, { k: 'walk' }>) {
  const top = state.stack[state.stack.length - 1];
  const pending = state.stack.slice(0, -1);
  const items: RemoteDocument[] = [];
  const subfolders: Array<{ id: string; pt: string | null }> = [];
  let continuation: { id: string; pt: string } | null = null;
  if (top) {
    if (!safeId(top.id)) throw new DocError('not_found', 'That folder is not one this reader can open.');
    const answer = rec(
      await ctx.http.json('/drive/v3/files', {
        query: { q: `'${top.id}' in parents and trashed = false`, pageSize: PAGE, fields: `nextPageToken,files(${FILE_FIELDS})`, corpora: 'allDrives', ...ALL_DRIVES, ...(top.pt ? { pageToken: top.pt } : {}) },
      }),
    );
    for (const raw of arr(answer['files'])) {
      const f = fileOf(raw);
      if (!f || f.trashed) continue;
      if (f.mimeType === FOLDER) {
        if (safeId(f.id)) subfolders.push({ id: f.id, pt: null });
        continue;
      }
      const kind = kindOf(f);
      if (kind) items.push(remote(f, kind));
    }
    const more = str(answer['nextPageToken'], 1000);
    if (more) continuation = { id: top.id, pt: more };
  }
  const stack = [...pending, ...(continuation ? [continuation] : []), ...subfolders];
  if (stack.length > MAX_PENDING_FOLDERS) throw new DocError('provider_down', 'That folder holds too many sub-folders to be read in one go. Pick a smaller folder.');
  const resume: State = stack.length === 0 ? { k: 'chg', t: state.start } : { k: 'walk', start: state.start, stack };
  const encoded = encodeState(resume);
  void root;
  return { items, next: stack.length === 0 ? null : encoded, cursor: encoded };
}

async function changesStep(ctx: AdapterCtx, root: string, state: Extract<State, { k: 'chg' }>) {
  const answer = rec(
    await ctx.http.json('/drive/v3/changes', {
      query: { pageToken: state.t, pageSize: PAGE, includeRemoved: true, fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`, ...ALL_DRIVES },
    }),
  );
  const items: RemoteDocument[] = [];
  for (const raw of arr(answer['changes'])) {
    const c = rec(raw);
    const fileId = str(c['fileId'], 300);
    if (!fileId) continue;
    const file = fileOf(c['file']);
    if (c['removed'] === true || !file || file.trashed) {
      const kind = file ? kindOf(file) : null;
      items.push({ remoteId: fileId, name: file?.name ?? fileId, kind: kind ?? 'text', version: file?.version ?? 'removed', url: null, removed: true });
      continue;
    }
    if (file.mimeType === FOLDER) continue;
    const kind = kindOf(file);
    if (!kind) continue;
    if (await underRoot(ctx, root, file)) items.push(remote(file, kind));
  }
  const more = str(answer['nextPageToken'], 1000);
  const fresh = str(answer['newStartPageToken'], 1000);
  const t = more ?? fresh;
  if (!t) throw new DocError('provider_down', `${ctx.http.label} did not give a resume point.`);
  const encoded = encodeState({ k: 'chg', t });
  return { items, next: more ? encoded : null, cursor: encoded };
}
