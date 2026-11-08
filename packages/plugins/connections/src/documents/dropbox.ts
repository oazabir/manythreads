import type { RemoteDocument } from '@manythreads/sdk';
import type { ConnectorRoot } from '@manythreads/shared';
import type { DocAdapter } from './adapter.ts';
import { DocError, MAX_DOCUMENT_BYTES, accessAnswer, arr, capped, decodeState, encodeState, isStr, kindOfFile, nameOf, rec, str, unreadableAccess, unreadableOrThrow } from './http.ts';

// Dropbox (PLAN Bundle D, P16-08, decisions D13 and D14). `files/list_folder` with `recursive`, then `list_folder/continue` with the cursor Dropbox hands back: the cursor is
// the resume point both inside a pass (while `has_more`) and between passes, and Dropbox lists a deleted file as a `deleted` entry, so removals are exact.
//   * A root is `root` (the whole Dropbox) or a top folder's lower-case path. A remote id is the file's lower-case path (a deleted entry carries nothing else). Paths only
//     ever travel inside a JSON body or a header of ours, never in an address, so any text without control characters is accepted.
//   * `access`: sharing members (people by e-mail; a group is "not everyone"), and a link anyone can open (`public`) means anyone; a link for the team or with a password is
//     "not everyone". Nothing readable gives groups true.

interface State {
  k: 'd';
  c: string;
}
const isState = (v: Record<string, unknown>): v is State & Record<string, unknown> => v['k'] === 'd' && isStr(v['c'], 4000);

// eslint-disable-next-line no-control-regex -- refusing control characters in a path is the point
const PATH = /^\/[^\u0000-\u001f\u007f]{0,1000}$/;
const pathOfRoot = (root: string): string | null => (root === 'root' ? '' : PATH.test(root) ? root : null);

/** A header value from JSON: everything outside ASCII is written as a \u escape (Dropbox's rule for `Dropbox-API-Arg`). */
const headerJson = (v: unknown): string => JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

const displayUrl = (path: string | null): string | null => {
  if (!path) return null;
  const url = `https://www.dropbox.com/home${encodeURI(path)}`;
  return url.length <= 1000 ? url : null;
};

export const dropbox: DocAdapter = {
  async listRoots(ctx) {
    const roots: ConnectorRoot[] = [{ id: 'root', name: 'Dropbox', kind: 'folder', parent: null }];
    const answer = rec(await ctx.http.json('/2/files/list_folder', { method: 'POST', body: { path: '', recursive: false, limit: 200, include_deleted: false } }));
    for (const raw of arr(answer['entries'])) {
      const e = rec(raw);
      const path = str(e['path_lower'], 1000);
      if (e['.tag'] === 'folder' && path && PATH.test(path)) roots.push({ id: path, name: nameOf(e['name'], path), kind: 'folder', parent: 'Dropbox' });
    }
    return roots.slice(0, 200);
  },

  async listChanges(ctx, { root, cursor }) {
    const path = pathOfRoot(root);
    if (path === null) throw new DocError('not_found', 'That folder is not one this reader can open.');
    const given = decodeState<State>(cursor, isState);
    let answer: Record<string, unknown>;
    if (given) {
      try {
        answer = rec(await ctx.http.json('/2/files/list_folder/continue', { method: 'POST', body: { cursor: given.c } }));
      } catch (err) {
        // the cursor is no longer valid (Dropbox asks for a reset) or not one of ours: list the folder again from the start
        if (!(err instanceof DocError) || (err.status !== 400 && err.status !== 409)) throw err;
        answer = await first(ctx, path);
      }
    } else {
      answer = await first(ctx, path);
    }
    const items: RemoteDocument[] = [];
    for (const raw of arr(answer['entries'])) {
      const e = rec(raw);
      const tag = e['.tag'];
      const lower = str(e['path_lower'], 1000);
      if (!lower || !PATH.test(lower)) continue;
      if (tag === 'deleted') {
        items.push({ remoteId: lower, name: nameOf(e['name'], lower.slice(lower.lastIndexOf('/') + 1)), kind: 'text', version: 'removed', url: null, removed: true });
      } else if (tag === 'file') {
        const name = nameOf(e['name'], lower.slice(lower.lastIndexOf('/') + 1));
        if (e['is_downloadable'] === false) continue;
        const kind = kindOfFile(name);
        if (!kind) continue;
        items.push({ remoteId: lower, name, kind, version: str(e['rev'], 100) ?? str(e['content_hash'], 100) ?? str(e['server_modified'], 60) ?? '0', url: displayUrl(str(e['path_display'], 1000)), removed: false });
      }
    }
    const next = str(answer['cursor'], 4000);
    if (!next) throw new DocError('provider_down', `${ctx.http.label} did not give a resume point.`);
    const encoded = encodeState({ k: 'd', c: next } satisfies State);
    return { items, next: answer['has_more'] === true ? encoded : null, cursor: encoded };
  },

  async fetch(ctx, remoteId) {
    if (!PATH.test(remoteId)) throw new DocError('not_found', 'That file is not one this reader can open.');
    const name = remoteId.slice(remoteId.lastIndexOf('/') + 1);
    const kind = kindOfFile(name);
    if (!kind) throw new DocError('not_found', 'That kind of file is not read.');
    const got = await ctx.http.bytes('/2/files/download', { method: 'POST', content: true, headers: { 'dropbox-api-arg': headerJson({ path: remoteId }) }, doc: true }, MAX_DOCUMENT_BYTES);
    return capped(ctx.http.label, got, kind);
  },

  async access(ctx, remoteId) {
    if (!PATH.test(remoteId)) return unreadableAccess();
    try {
      let anyone = false;
      let groups = false;
      const users: string[] = [];
      const members = rec(await ctx.http.json('/2/sharing/list_file_members', { method: 'POST', body: { file: remoteId, include_inherited: true, limit: 100 }, doc: true }));
      if (!Array.isArray(members['users']) || !Array.isArray(members['groups']) || !Array.isArray(members['invitees'])) return unreadableAccess();
      if (typeof members['cursor'] === 'string' && members['cursor'] !== '') groups = true; // a longer list than one page: "more than we saw"
      for (const raw of members['users']) {
        const email = str(rec(rec(raw)['user'])['email'], 320);
        if (email) users.push(email);
        else groups = true;
      }
      if (members['groups'].length > 0) groups = true;
      for (const raw of members['invitees']) {
        const invitee = rec(rec(raw)['invitee']);
        const email = invitee['.tag'] === 'email' ? str(invitee['email'], 320) : null;
        if (email) users.push(email);
        else groups = true;
      }
      const links = rec(await ctx.http.json('/2/sharing/list_shared_links', { method: 'POST', body: { path: remoteId, direct_only: true }, doc: true }));
      if (!Array.isArray(links['links'])) return unreadableAccess();
      for (const raw of links['links']) {
        const visibility = rec(rec(raw)['link_permissions'])['resolved_visibility'] ?? rec(rec(raw)['link_permissions'])['effective_audience'];
        const tag = str(rec(visibility)['.tag'], 40);
        if (tag === 'public') anyone = true;
        else groups = true; // team only, password, no one: not everyone
      }
      return accessAnswer({ anyone, domains: [], users, groups });
    } catch (err) {
      return unreadableOrThrow(err);
    }
  },
};

async function first(ctx: Parameters<DocAdapter['listChanges']>[0], path: string): Promise<Record<string, unknown>> {
  try {
    return rec(await ctx.http.json('/2/files/list_folder', { method: 'POST', body: { path, recursive: true, limit: 200, include_deleted: false, include_non_downloadable_files: false } }));
  } catch (err) {
    if (err instanceof DocError && err.code === 'not_found') throw new DocError('not_found', `${ctx.http.label} has no such folder.`);
    throw err;
  }
}
