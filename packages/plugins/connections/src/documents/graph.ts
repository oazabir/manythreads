import type { RemoteDocument } from '@manythreads/sdk';
import type { ConnectorRoot } from '@manythreads/shared';
import { safeId, type AdapterCtx, type DocAdapter } from './adapter.ts';
import { DocError, MAX_DOCUMENT_BYTES, accessAnswer, arr, capped, decodeState, emailDomain, encodeState, enc, isBinaryKind, isStr, kindOfFile, nameOf, rec, str, unreadableAccess, unreadableOrThrow } from './http.ts';

// Microsoft Graph files, shared by OneDrive (the person's own drive; a root is the whole drive or one of its top folders) and SharePoint (a root is one document library of a
// site). Both are read with the library's `delta` feed: the first pass is the feed from the start (every file, page by page), the pass after it is the feed from the
// `@odata.deltaLink` the last one ended with. A link a provider sends is never dialled: only its path and query are kept, on our own base (`http.relative`).
//
//   * OneDrive keeps a folder root by the ancestry of each file (the item's parent chain is followed up, at most 25 levels, each looked up once per grant); the whole drive
//     needs no check. SharePoint reads a whole library.
//   * A removed file comes as `deleted` and is reported removed. A file moved out of a folder root is not told apart from one that never was in it (Graph names no old place).
//   * A SharePoint remote id is `<drive id>/<item id>`, so a file can be fetched with the id alone; a OneDrive remote id is the item id.

export type GraphKind = 'onedrive' | 'sharepoint';

interface State {
  k: 'delta';
  /** Path and query of the next page of the feed, on our base. */
  p: string;
}
const isState = (v: Record<string, unknown>): v is State & Record<string, unknown> => v['k'] === 'delta' && isStr(v['p'], 4000) && String(v['p']).startsWith('/');

const driveBase = (kind: GraphKind, root: string): string => (kind === 'onedrive' ? '/me/drive' : `/drives/${enc(root)}`);

/** `drive/item` for SharePoint, the item id for OneDrive; null when the id is not one we could have given out. */
function parseRemote(kind: GraphKind, remoteId: string): { base: string; item: string } | null {
  if (kind === 'onedrive') return safeId(remoteId) ? { base: '/me/drive', item: remoteId } : null;
  const slash = remoteId.indexOf('/');
  if (slash <= 0) return null;
  const drive = remoteId.slice(0, slash);
  const item = remoteId.slice(slash + 1);
  return safeId(drive) && safeId(item) ? { base: `/drives/${enc(drive)}`, item } : null;
}

async function parentOf(ctx: AdapterCtx, base: string, id: string): Promise<string | null> {
  return ctx.memo.get(`${ctx.prefix}:ms:parent:${base}:${id}`, async () => {
    try {
      const r = rec(await ctx.http.json(`${base}/items/${enc(id)}`, { query: { $select: 'id,parentReference' }, doc: true }));
      return str(rec(r['parentReference'])['id'], 300);
    } catch (err) {
      if (err instanceof DocError && (err.code === 'not_found' || err.code === 'scope_missing')) return null;
      throw err;
    }
  });
}

async function underFolder(ctx: AdapterCtx, base: string, root: string, parent: string | null): Promise<boolean> {
  let at = parent;
  for (let depth = 0; depth < 25 && at !== null; depth++) {
    if (at === root) return true;
    if (!safeId(at)) return false;
    at = await parentOf(ctx, base, at);
  }
  return false;
}

async function ownerDomain(ctx: AdapterCtx): Promise<string | null> {
  return ctx.memo.get(`${ctx.prefix}:ms:domain`, async () => {
    const me = rec(await ctx.http.json('/me', { query: { $select: 'mail,userPrincipalName' } }));
    const mail = str(me['mail'], 320) ?? str(me['userPrincipalName'], 320);
    return mail ? emailDomain(mail) : null;
  });
}

export function graphAdapter(kind: GraphKind): DocAdapter {
  const remoteIdOf = (root: string, item: string): string => (kind === 'sharepoint' ? `${root}/${item}` : item);

  return {
    async listRoots(ctx) {
      if (kind === 'onedrive') {
        const roots: ConnectorRoot[] = [{ id: 'root', name: 'OneDrive', kind: 'drive', parent: null }];
        const top = rec(await ctx.http.json('/me/drive/root/children', { query: { $top: 200, $select: 'id,name,folder' } }));
        for (const raw of arr(top['value'])) {
          const r = rec(raw);
          const id = str(r['id'], 300);
          if (id && safeId(id) && r['folder'] !== undefined) roots.push({ id, name: nameOf(r['name'], id), kind: 'folder', parent: 'OneDrive' });
        }
        return roots.slice(0, 200);
      }
      const roots: ConnectorRoot[] = [];
      const sites = rec(await ctx.http.json('/sites', { query: { search: '*', $top: 30, $select: 'id,displayName' } }));
      for (const raw of arr(sites['value']).slice(0, 30)) {
        const site = rec(raw);
        const siteId = str(site['id'], 300);
        if (!siteId || !safeId(siteId)) continue;
        const siteName = nameOf(site['displayName'], siteId);
        let libraries: unknown[];
        try {
          libraries = arr(rec(await ctx.http.json(`/sites/${enc(siteId)}/drives`, { query: { $select: 'id,name' } }))['value']);
        } catch (err) {
          if (err instanceof DocError && (err.code === 'not_found' || err.code === 'scope_missing')) continue;
          throw err;
        }
        for (const lib of libraries) {
          const id = str(rec(lib)['id'], 300);
          if (id && safeId(id)) roots.push({ id, name: `${siteName} / ${nameOf(rec(lib)['name'], id)}`, kind: 'library', parent: siteName });
        }
        if (roots.length >= 200) break;
      }
      return roots.slice(0, 200);
    },

    async listChanges(ctx, { root, cursor }) {
      if (!safeId(root)) throw new DocError('not_found', 'That folder is not one this reader can open.');
      const base = driveBase(kind, root);
      const first = `${base}/root/delta?$top=200`;
      let p = first;
      const given = decodeState<State>(cursor, isState);
      // a stored link must still be the feed of THIS library: anything else is "no cursor"
      if (given && (given.p === `${base}/root/delta` || given.p.startsWith(`${base}/root/delta?`) || given.p.startsWith(`${base}/root/delta(`))) p = given.p;
      for (let attempt = 0; ; attempt++) {
        try {
          const answer = rec(await ctx.http.json(p));
          const items: RemoteDocument[] = [];
          for (const raw of arr(answer['value'])) {
            const r = rec(raw);
            const id = str(r['id'], 300);
            if (!id || !safeId(id)) continue;
            if (r['deleted'] !== undefined) {
              items.push({ remoteId: remoteIdOf(root, id), name: nameOf(r['name'], id), kind: 'text', version: 'removed', url: null, removed: true });
              continue;
            }
            const file = rec(r['file']);
            if (r['folder'] !== undefined || r['root'] !== undefined || r['package'] !== undefined || Object.keys(file).length === 0) continue;
            const name = nameOf(r['name'], id);
            const docKind = kindOfFile(name, str(file['mimeType'], 200));
            if (!docKind) continue;
            if (kind === 'onedrive' && root !== 'root') {
              if (!(await underFolder(ctx, base, root, str(rec(r['parentReference'])['id'], 300)))) continue;
            }
            items.push({ remoteId: remoteIdOf(root, id), name, kind: docKind, version: str(r['eTag'], 200) ?? str(r['lastModifiedDateTime'], 60) ?? '0', url: str(r['webUrl'], 1000), removed: false });
          }
          const nextLink = str(answer['@odata.nextLink'], 4000);
          const deltaLink = str(answer['@odata.deltaLink'], 4000);
          const link = nextLink ?? deltaLink;
          if (!link) throw new DocError('provider_down', `${ctx.http.label} did not give a resume point.`);
          const encoded = encodeState({ k: 'delta', p: ctx.http.relative(link) } satisfies State);
          return { items, next: nextLink ? encoded : null, cursor: encoded };
        } catch (err) {
          // the stored point has expired (Graph answers 410 "resync required"): start over once with the whole feed; files the knowledge side already has are skipped by version
          if (err instanceof DocError && err.status === 410 && attempt === 0 && p !== first) {
            p = first;
            continue;
          }
          throw err;
        }
      }
    },

    async fetch(ctx, remoteId) {
      const at = parseRemote(kind, remoteId);
      if (!at) throw new DocError('not_found', 'That file is not one this reader can open.');
      const meta = rec(await ctx.http.json(`${at.base}/items/${enc(at.item)}`, { query: { $select: 'id,name,size,file,folder,deleted' }, doc: true }));
      const file = rec(meta['file']);
      if (meta['deleted'] !== undefined || meta['folder'] !== undefined || Object.keys(file).length === 0) throw new DocError('not_found', `${ctx.http.label} has no such file any more.`);
      const docKind = kindOfFile(nameOf(meta['name'], at.item), str(file['mimeType'], 200));
      if (!docKind) throw new DocError('not_found', 'That kind of file is not read.');
      const size = typeof meta['size'] === 'number' ? meta['size'] : 0;
      if (isBinaryKind(docKind) && size > MAX_DOCUMENT_BYTES) throw new DocError('not_found', 'That file is too large to be read.');
      const got = await ctx.http.bytes(`${at.base}/items/${enc(at.item)}/content`, { doc: true }, MAX_DOCUMENT_BYTES);
      return capped(ctx.http.label, got, docKind);
    },

    async access(ctx, remoteId) {
      const at = parseRemote(kind, remoteId);
      if (!at) return unreadableAccess();
      try {
        const answer = rec(await ctx.http.json(`${at.base}/items/${enc(at.item)}/permissions`, { doc: true }));
        const list = answer['value'];
        if (!Array.isArray(list)) return unreadableAccess();
        let anyone = false;
        let groups = typeof answer['@odata.nextLink'] === 'string'; // a list that goes on is read for its first page only: "more than we saw" is "not everyone"
        const domains: string[] = [];
        const users: string[] = [];
        const emailOf = (identity: unknown): string | null => str(rec(rec(identity)['user'])['email'], 320) ?? str(rec(rec(identity)['siteUser'])['email'], 320);
        for (const raw of list) {
          const perm = rec(raw);
          const link = rec(perm['link']);
          const scope = str(link['scope'], 30);
          if (scope === 'anonymous') {
            anyone = true;
          } else if (scope === 'organization') {
            const domain = await ownerDomain(ctx);
            if (domain) domains.push(domain);
            else groups = true;
          } else if (scope === 'users') {
            const named = arr(perm['grantedToIdentitiesV2']).map(emailOf).filter((e): e is string => e !== null);
            if (named.length === 0) groups = true;
            else users.push(...named);
          } else if (scope !== null) {
            groups = true; // a kind of link this reader does not know
          } else {
            const to = rec(perm['grantedToV2']);
            const email = emailOf(to);
            if (email) users.push(email);
            else groups = true; // a group, a site group, an app, or a person with no address
          }
        }
        return accessAnswer({ anyone, domains, users, groups });
      } catch (err) {
        return unreadableOrThrow(err);
      }
    },
  };
}
