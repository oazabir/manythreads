import type { RemoteDocument } from '@manythreads/sdk';
import type { ConnectorRoot } from '@manythreads/shared';
import { safeId, type AdapterCtx, type DocAdapter } from './adapter.ts';
import { DocError, MAX_DOCUMENT_BYTES, MAX_PENDING_FOLDERS, accessAnswer, arr, capped, decodeState, encodeState, enc, isBinaryKind, isStr, isStrOrNull, kindOfFile, nameOf, rec, str, unreadableAccess, unreadableOrThrow } from './http.ts';

// Box (PLAN Bundle D, P16-08, decisions D13 and D14), read only with `root_readonly`. Box's own change feed (events) needs an enterprise scope, so a pass is a walk of the folder
// tree under the root, one folder page per call, and a pass after the first reports only the files edited since the last one; then the trash is read, newest first, and
// the files trashed since the last pass are reported removed.
//   * State `{ph, after, hi, stack}`: `ph` is `walk`, `trash` or `idle` (between passes: the next call starts a new walk), `after` the newest edit (ms) of the last pass,
//     `hi` the newest seen in this one, `stack` the folders left (with Box's own page marker). A folder is visited in every pass (an edit deep in the tree does not change
//     its folders), so a quiet pass over a big tree is many calls that return few files.
//   * A file moved out of the root is not noticed here (Box says nothing of where it was); one deleted for good is noticed only if it passed through the trash.
//   * `access`: the file's own link (`open` is anyone; a company link or anything else is "not everyone"), the owner, and the collaborators of the file and of each folder above
//     it (at most ten). A group, a pending invitation without an address, or anything that could not be read gives groups true.

interface Frame {
  id: string;
  m: string | null;
}
interface State {
  k: 'b';
  ph: 'walk' | 'trash' | 'idle';
  after: number | null;
  hi: number | null;
  stack: Frame[];
  /** The trash page marker. */
  tm: string | null;
}
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isState = (v: Record<string, unknown>): v is State & Record<string, unknown> =>
  v['k'] === 'b' &&
  (v['ph'] === 'walk' || v['ph'] === 'trash' || v['ph'] === 'idle') &&
  (v['after'] === null || isNum(v['after'])) &&
  (v['hi'] === null || isNum(v['hi'])) &&
  isStrOrNull(v['tm'], 1000) &&
  Array.isArray(v['stack']) &&
  v['stack'].length <= MAX_PENDING_FOLDERS &&
  v['stack'].every((f) => isStr(rec(f)['id'], 40) && safeId(String(rec(f)['id'])) && isStrOrNull(rec(f)['m'], 1000));

const FIELDS = 'id,type,name,modified_at,etag,size,sequence_id';
const PAGE = 200;
const MAX_ANCESTORS = 10;
const time = (v: unknown): number | null => {
  const s = str(v, 60);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
};
const fileUrl = (id: string): string => `https://app.box.com/file/${id}`;

export const box: DocAdapter = {
  async listRoots(ctx) {
    const roots: ConnectorRoot[] = [{ id: '0', name: 'All files', kind: 'folder', parent: null }];
    const top = rec(await ctx.http.json('/2.0/folders/0/items', { query: { fields: 'id,type,name', limit: 1000, usemarker: true } }));
    for (const raw of arr(top['entries'])) {
      const e = rec(raw);
      const id = str(e['id'], 40);
      if (e['type'] === 'folder' && id && safeId(id)) roots.push({ id, name: nameOf(e['name'], id), kind: 'folder', parent: 'All files' });
    }
    return roots.slice(0, 200);
  },

  async listChanges(ctx, { root, cursor }) {
    if (!safeId(root)) throw new DocError('not_found', 'That folder is not one this reader can open.');
    const given = decodeState<State>(cursor, isState);
    const fresh = (after: number | null): State => ({ k: 'b', ph: 'walk', after, hi: null, stack: [{ id: root, m: null }], tm: null });
    let state: State = !given ? fresh(null) : given.ph === 'idle' ? fresh(given.after) : given;
    if (state.ph === 'walk' && state.stack.length === 0) state = { ...state, ph: state.after === null ? 'idle' : 'trash' };
    return state.ph === 'trash' ? trashStep(ctx, state) : state.ph === 'idle' ? idle(state) : walkStep(ctx, state);
  },

  async fetch(ctx, remoteId) {
    if (!safeId(remoteId)) throw new DocError('not_found', 'That file is not one this reader can open.');
    const meta = rec(await ctx.http.json(`/2.0/files/${enc(remoteId)}`, { query: { fields: 'id,type,name,size,trashed_at' }, doc: true }));
    if (meta['type'] !== 'file' || str(meta['trashed_at'], 60) !== null) throw new DocError('not_found', `${ctx.http.label} has no such file any more.`);
    const kind = kindOfFile(nameOf(meta['name'], remoteId));
    if (!kind) throw new DocError('not_found', 'That kind of file is not read.');
    if (isBinaryKind(kind) && isNum(meta['size']) && meta['size'] > MAX_DOCUMENT_BYTES) throw new DocError('not_found', 'That file is too large to be read.');
    // Box answers with a redirect to a short-lived download address; it is followed without the token and only to a public address
    const got = await ctx.http.bytes(`/2.0/files/${enc(remoteId)}/content`, { doc: true }, MAX_DOCUMENT_BYTES);
    return capped(ctx.http.label, got, kind);
  },

  async access(ctx, remoteId) {
    if (!safeId(remoteId)) return unreadableAccess();
    try {
      const meta = rec(await ctx.http.json(`/2.0/files/${enc(remoteId)}`, { query: { fields: 'id,shared_link,path_collection,owned_by' }, doc: true }));
      if (meta['id'] === undefined) return unreadableAccess();
      let anyone = false;
      let groups = false;
      const users: string[] = [];
      const link = rec(meta['shared_link']);
      if (meta['shared_link'] !== null && meta['shared_link'] !== undefined) {
        const level = str(link['effective_access'], 30) ?? str(link['access'], 30);
        if (level === 'open') anyone = true;
        else if (level !== 'collaborators') groups = true; // a company link, or one this reader does not know
      }
      const owner = str(rec(meta['owned_by'])['login'], 320);
      if (owner) users.push(owner);
      else groups = true;

      const folders: string[] = [];
      const path = rec(meta['path_collection']);
      const entries = arr(path['entries']);
      if (!Array.isArray(path['entries'])) return unreadableAccess();
      for (const raw of entries) {
        const e = rec(raw);
        const id = str(e['id'], 40);
        if (!id || !safeId(id)) return unreadableAccess();
        if (id !== '0') folders.push(id);
      }
      if (folders.length > MAX_ANCESTORS) return unreadableAccess();

      for (const [kind, id] of [['files', remoteId], ...folders.map((f) => ['folders', f] as const)] as Array<readonly ['files' | 'folders', string]>) {
        const part = await collaborators(ctx, kind, id);
        if (part === null) return unreadableAccess();
        users.push(...part.users);
        if (part.groups) groups = true;
      }
      return accessAnswer({ anyone, domains: [], users, groups });
    } catch (err) {
      return unreadableOrThrow(err);
    }
  },
};

const idle = (state: State) => {
  const encoded = encodeState(state);
  return { items: [] as RemoteDocument[], next: null, cursor: encoded };
};

async function walkStep(ctx: AdapterCtx, state: State) {
  const top = state.stack[state.stack.length - 1]!;
  const rest = state.stack.slice(0, -1);
  const answer = rec(
    await ctx.http.json(`/2.0/folders/${enc(top.id)}/items`, { query: { fields: FIELDS, limit: PAGE, usemarker: true, ...(top.m ? { marker: top.m } : {}) }, doc: true }),
  );
  const items: RemoteDocument[] = [];
  const folders: Frame[] = [];
  let hi = state.hi;
  for (const raw of arr(answer['entries'])) {
    const e = rec(raw);
    const id = str(e['id'], 40);
    if (!id || !safeId(id)) continue;
    if (e['type'] === 'folder') {
      folders.push({ id, m: null });
      continue;
    }
    if (e['type'] !== 'file') continue;
    const modified = time(e['modified_at']);
    if (modified !== null && (hi === null || modified > hi)) hi = modified;
    if (state.after !== null && modified !== null && modified <= state.after) continue;
    const name = nameOf(e['name'], id);
    const kind = kindOfFile(name);
    if (!kind) continue;
    items.push({ remoteId: id, name, kind, version: str(e['etag'], 100) ?? str(e['modified_at'], 60) ?? '0', url: fileUrl(id), removed: false });
  }
  const marker = str(answer['next_marker'], 1000);
  const stack = [...rest, ...(marker ? [{ id: top.id, m: marker }] : []), ...folders];
  if (stack.length > MAX_PENDING_FOLDERS) throw new DocError('provider_down', 'That folder holds too many sub-folders to be read in one go. Pick a smaller folder.');
  // the walk is over: the trash is read next when there is an earlier pass to compare with; otherwise the pass ends here
  const resume: State = stack.length > 0 ? { ...state, hi, stack } : state.after === null ? { ...state, ph: 'idle', after: hi, hi: null, stack: [] } : { ...state, ph: 'trash', hi, stack: [], tm: null };
  const encoded = encodeState(resume);
  return { items, next: resume.ph === 'idle' ? null : encoded, cursor: encoded };
}

async function trashStep(ctx: AdapterCtx, state: State) {
  const answer = rec(
    await ctx.http.json('/2.0/folders/trash/items', { query: { fields: 'id,type,name,trashed_at', limit: PAGE, usemarker: true, sort: 'date', direction: 'DESC', ...(state.tm ? { marker: state.tm } : {}) } }),
  );
  const items: RemoteDocument[] = [];
  let hi = state.hi;
  let reachedOld = false;
  for (const raw of arr(answer['entries'])) {
    const e = rec(raw);
    const id = str(e['id'], 40);
    if (!id || !safeId(id) || e['type'] !== 'file') continue;
    const trashed = time(e['trashed_at']);
    if (trashed !== null && (hi === null || trashed > hi)) hi = trashed;
    if (state.after !== null && trashed !== null && trashed <= state.after) {
      reachedOld = true;
      break;
    }
    items.push({ remoteId: id, name: nameOf(e['name'], id), kind: 'text', version: 'removed', url: null, removed: true });
  }
  const marker = str(answer['next_marker'], 1000);
  const resume: State = marker && !reachedOld ? { ...state, hi, tm: marker } : { ...state, ph: 'idle', after: hi ?? state.after, hi: null, stack: [], tm: null };
  const encoded = encodeState(resume);
  return { items, next: resume.ph === 'idle' ? null : encoded, cursor: encoded };
}

/** The people and groups who may open something through collaboration on a file or a folder; null when it could not be read. */
async function collaborators(ctx: AdapterCtx, kind: 'files' | 'folders', id: string): Promise<{ users: string[]; groups: boolean } | null> {
  return ctx.memo.get(`${ctx.prefix}:box:collab:${kind}:${id}`, async () => {
    try {
      const answer = rec(await ctx.http.json(`/2.0/${kind}/${enc(id)}/collaborations`, { query: { limit: 1000, fields: 'id,status,accessible_by' }, doc: true }));
      if (!Array.isArray(answer['entries'])) return null;
      const users: string[] = [];
      let groups = typeof answer['next_marker'] === 'string' && answer['next_marker'] !== '';
      for (const raw of answer['entries']) {
        const by = rec(rec(raw)['accessible_by']);
        const login = str(by['login'], 320);
        if (by['type'] === 'user' && login) users.push(login);
        else groups = true; // a group, or an invitation with no address
      }
      return { users, groups };
    } catch (err) {
      if (err instanceof DocError && (err.code === 'not_connected' || err.code === 'provider_down')) throw err;
      return null;
    }
  });
}
