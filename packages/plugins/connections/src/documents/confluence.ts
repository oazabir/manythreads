import type { RemoteDocument } from '@manythreads/sdk';
import type { ConnectorRoot } from '@manythreads/shared';
import { safeId, type AdapterCtx, type DocAdapter } from './adapter.ts';
import { DocError, MAX_DOCUMENT_BYTES, accessAnswer, arr, decodeState, encodeState, enc, isStrOrNull, nameOf, rec, str, unreadableAccess, unreadableOrThrow } from './http.ts';
import { confluenceStorageToMarkdown } from './markdown.ts';

// Confluence Cloud (PLAN Bundle D, P16-08, decisions D13 and D14), over Atlassian's gateway: the site is found from the accessible-resources list (the first site the
// person's grant reaches), and every call goes to `/ex/confluence/<site id>/wiki/...`. A root is one space (its numeric id).
//   * Pages come NEWEST EDIT FIRST (`sort=-modified-date`) and a pass stops at the first page not edited since the last one; then, if there is a last pass, the trash of the
//     space is read the same way and its pages are reported removed. State `{p, hi, after, c}`: `p` is the phase (current pages or trash), `c` Atlassian's page cursor.
//   * A page's version is the time of its latest version (`version.createdAt`). Archived pages are not read.
//   * `access`: a page is open to everyone only when the space allows anonymous reading and neither the page nor one of its ancestors (at most ten) is restricted. A
//     restriction, a group (such as the site's own users), a person known only by an account id, or anything that could not be read is "not everyone": groups true.

interface State {
  k: 'c';
  p: 'cur' | 'trash';
  hi: string | null;
  after: string | null;
  c: string | null;
}
const isState = (v: Record<string, unknown>): v is State & Record<string, unknown> =>
  v['k'] === 'c' && (v['p'] === 'cur' || v['p'] === 'trash') && isStrOrNull(v['hi'], 40) && isStrOrNull(v['after'], 40) && isStrOrNull(v['c'], 1000);

const MAX_ANCESTORS = 10;

/** The gateway prefix of the person's site. */
async function sitePrefix(ctx: AdapterCtx): Promise<string> {
  const id = await ctx.memo.get(`${ctx.prefix}:cf:site`, async () => {
    const list = await ctx.http.json('/oauth/token/accessible-resources');
    for (const raw of arr(list)) {
      const site = str(rec(raw)['id'], 100);
      if (site && safeId(site)) return site;
    }
    return null;
  });
  if (!id) throw new DocError('not_found', `${ctx.http.label} has no site this sign-in can reach.`);
  return `/ex/confluence/${enc(id)}`;
}

/** The `cursor` of an Atlassian `_links.next` (a relative address of theirs); only this one value is kept. */
function nextCursor(links: unknown): string | null {
  const next = str(rec(links)['next'], 4000);
  if (!next) return null;
  try {
    return str(new URL(next, 'https://gateway.invalid').searchParams.get('cursor'), 1000);
  } catch {
    return null;
  }
}

const webUrl = (page: Record<string, unknown>): string | null => {
  const links = rec(page['_links']);
  const base = str(links['base'], 500);
  const ui = str(links['webui'], 700);
  if (!base || !ui) return null;
  const joined = `${base.replace(/\/+$/, '')}${ui.startsWith('/') ? '' : '/'}${ui}`;
  return /^https?:\/\//i.test(joined) && joined.length <= 1000 ? joined : null;
};

export const confluence: DocAdapter = {
  async listRoots(ctx) {
    const gw = await sitePrefix(ctx);
    const roots: ConnectorRoot[] = [];
    const answer = rec(await ctx.http.json(`${gw}/wiki/api/v2/spaces`, { query: { limit: 200, status: 'current' } }));
    for (const raw of arr(answer['results'])) {
      const r = rec(raw);
      const id = str(r['id'], 40);
      if (id && safeId(id)) roots.push({ id, name: nameOf(r['name'], id), kind: 'space', parent: null });
    }
    return roots.slice(0, 200);
  },

  async listChanges(ctx, { root, cursor }) {
    if (!safeId(root)) throw new DocError('not_found', 'That space is not one this reader can open.');
    const gw = await sitePrefix(ctx);
    const state: State = decodeState<State>(cursor, isState) ?? { k: 'c', p: 'cur', hi: null, after: null, c: null };
    const answer = rec(
      await ctx.http.json(`${gw}/wiki/api/v2/pages`, {
        query: { 'space-id': root, status: state.p === 'cur' ? 'current' : 'trashed', sort: '-modified-date', limit: 50, ...(state.c ? { cursor: state.c } : {}) },
      }),
    );
    let hi = state.hi;
    let reachedOld = false;
    const items: RemoteDocument[] = [];
    for (const raw of arr(answer['results'])) {
      const page = rec(raw);
      const id = str(page['id'], 40);
      const edited = str(rec(page['version'])['createdAt'], 40);
      if (!id || !safeId(id) || !edited) continue;
      if (hi === null || edited > hi) hi = edited;
      if (state.after !== null && edited <= state.after) {
        reachedOld = true;
        break;
      }
      if (state.p === 'trash') {
        items.push({ remoteId: id, name: nameOf(page['title'], id), kind: 'md', version: edited, url: null, removed: true });
      } else if (page['status'] === undefined || page['status'] === 'current') {
        items.push({ remoteId: id, name: nameOf(page['title'], id), kind: 'md', version: edited, url: webUrl(page), removed: false });
      }
    }
    const more = nextCursor(answer['_links']);
    if (more && !reachedOld) {
      const resume = encodeState({ k: 'c', p: state.p, hi, after: state.after, c: more } satisfies State);
      return { items, next: resume, cursor: resume };
    }
    // the current pages are done: with an earlier pass behind us, the trash is read next (a first pass has nothing to remove)
    if (state.p === 'cur' && state.after !== null) {
      const resume = encodeState({ k: 'c', p: 'trash', hi, after: state.after, c: null } satisfies State);
      return { items, next: resume, cursor: resume };
    }
    const done = encodeState({ k: 'c', p: 'cur', hi: null, after: hi ?? state.after, c: null } satisfies State);
    return { items, next: null, cursor: done };
  },

  async fetch(ctx, remoteId) {
    if (!safeId(remoteId)) throw new DocError('not_found', 'That page is not one this reader can open.');
    const gw = await sitePrefix(ctx);
    const page = rec(await ctx.http.json(`${gw}/wiki/api/v2/pages/${enc(remoteId)}`, { query: { 'body-format': 'storage' }, doc: true }));
    const status = str(page['status'], 20);
    if (status !== null && status !== 'current') throw new DocError('not_found', 'That page is not current.');
    const value = str(rec(rec(page['body'])['storage'])['value'], 20 * 1024 * 1024) ?? '';
    const md = confluenceStorageToMarkdown(nameOf(page['title'], 'Untitled'), value);
    return { bytes: new Uint8Array(Buffer.from(md, 'utf8').subarray(0, MAX_DOCUMENT_BYTES)), kind: 'md' };
  },

  async access(ctx, remoteId) {
    if (!safeId(remoteId)) return unreadableAccess();
    try {
      const gw = await sitePrefix(ctx);
      const page = rec(await ctx.http.json(`${gw}/wiki/api/v2/pages/${enc(remoteId)}`, { doc: true }));
      const spaceId = str(page['spaceId'], 40);
      if (!spaceId || !safeId(spaceId)) return unreadableAccess();

      // the page itself and every ancestor: a read restriction anywhere on the chain makes it "not everyone"
      const chain = [remoteId];
      const ancestors = rec(await ctx.http.json(`${gw}/wiki/api/v2/pages/${enc(remoteId)}/ancestors`, { query: { limit: MAX_ANCESTORS + 1 }, doc: true }));
      const list = arr(ancestors['results']);
      if (list.length > MAX_ANCESTORS || nextCursor(ancestors['_links']) !== null) return unreadableAccess();
      for (const a of list) {
        const id = str(rec(a)['id'], 40);
        if (!id || !safeId(id)) return unreadableAccess();
        chain.push(id);
      }
      for (const id of chain) {
        if (await restricted(ctx, gw, id)) return unreadableAccess();
      }

      // the space: anonymous readers mean anyone; any other reader (a group, a person) means "not everyone"
      const perms = rec(await ctx.memo.get(`${ctx.prefix}:cf:space:${spaceId}`, () => ctx.http.json(`${gw}/wiki/api/v2/spaces/${enc(spaceId)}/permissions`, { query: { limit: 250 }, doc: true })));
      if (nextCursor(perms['_links']) !== null || !Array.isArray(perms['results'])) return unreadableAccess();
      let anonymous = false;
      for (const raw of perms['results']) {
        const p = rec(raw);
        if (rec(p['operation'])['key'] === 'read' && rec(p['principal'])['type'] === 'anonymous') anonymous = true;
      }
      return accessAnswer({ anyone: anonymous, domains: [], users: [], groups: !anonymous });
    } catch (err) {
      return unreadableOrThrow(err);
    }
  },
};

/** True when the page has a read restriction of its own, or when that could not be told. */
async function restricted(ctx: AdapterCtx, gw: string, id: string): Promise<boolean> {
  return ctx.memo.get(`${ctx.prefix}:cf:restricted:${id}`, async () => {
    try {
      const answer = rec(await ctx.http.json(`${gw}/wiki/rest/api/content/${enc(id)}/restriction/byOperation/read`, { doc: true }));
      const r = rec(answer['restrictions']);
      const users = arr(rec(r['user'])['results']);
      const groups = arr(rec(r['group'])['results']);
      if (!('restrictions' in answer)) return true;
      return users.length > 0 || groups.length > 0;
    } catch (err) {
      if (err instanceof DocError && (err.code === 'not_connected' || err.code === 'provider_down')) throw err;
      return true;
    }
  });
}
