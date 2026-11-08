import { oauthEnv, startDocServer, type DocApiRequest, type DocServer } from './doc-oauth.ts';
import type { StandInModule } from './types.ts';

/*
 * A Confluence Cloud stand-in (PLAN Bundle D, P16-08). Atlassian 3LO like Jira (consent, token with a rotating refresh token, `accessible-resources`) and the part of the
 * site's REST the document reader uses, under Atlassian's gateway address `/ex/confluence/<site id>/wiki/...`:
 *   - v2 spaces, pages (newest edit first, cursor paging through `_links.next`, `status=current|trashed`), one page with its body in storage format, a page's ancestors, a
 *     space's permissions;
 *   - the v1 read restrictions of a page.
 * A page's `version.createdAt` is its last edit; `trashPage` and `editPage` move it.
 */

export const CONFLUENCE_SITE_ID = 'fake-site-0001';

export interface FakeConfluenceSpace {
  id: string;
  key: string;
  name: string;
  /** Anonymous readers may open the space (a public space). */
  anonymousRead?: boolean;
  /** The site's own users group may read it (default true). */
  groupRead?: boolean;
}

export interface FakeConfluencePage {
  id: string;
  spaceId: string;
  title: string;
  /** Storage format (XHTML). */
  body: string;
  /** Last edit (ISO). */
  modified: string;
  status: 'current' | 'trashed' | 'archived';
  /** A read restriction on this very page. */
  restricted?: boolean;
  parentId?: string;
}

export interface FakeConfluenceData {
  spaces: FakeConfluenceSpace[];
  pages: FakeConfluencePage[];
}

export function defaultConfluenceData(): FakeConfluenceData {
  return {
    spaces: [
      { id: '1001', key: 'ENG', name: 'Engineering' },
      { id: '1002', key: 'PUB', name: 'Public handbook', anonymousRead: true },
    ],
    pages: [
      { id: '2001', spaceId: '1001', title: 'Release process', body: '<h1>Release process</h1><p>We ship on <strong>Tuesdays</strong>.</p><ul><li>Cut the branch</li><li>Run the checks</li></ul>', modified: '2026-10-01T09:00:00.000Z', status: 'current' },
      { id: '2002', spaceId: '1001', title: 'On call', body: '<p>The on-call phone rotates every Monday.</p>', modified: '2026-10-02T09:00:00.000Z', status: 'current', parentId: '2001' },
      { id: '2003', spaceId: '1001', title: 'Salary bands', body: '<p>Private.</p>', modified: '2026-10-03T09:00:00.000Z', status: 'current', restricted: true },
      { id: '2004', spaceId: '1002', title: 'Welcome', body: '<p>Welcome to the handbook.</p>', modified: '2026-10-04T09:00:00.000Z', status: 'current' },
    ],
  };
}

export interface FakeConfluence {
  server: DocServer;
  url: string;
  data: FakeConfluenceData;
  /** Adds or replaces a page (edited at `modified`, default now). */
  putPage(page: Omit<FakeConfluencePage, 'modified' | 'status'> & { modified?: string; status?: FakeConfluencePage['status'] }): void;
  /** Changes a page's body or title and moves its edit time (default now). */
  editPage(id: string, changes: { title?: string; body?: string }, modified?: string): void;
  /** Moves a page to the trash (its edit time moves too). */
  trashPage(id: string, modified?: string): void;
  restrictPage(id: string, restricted: boolean): void;
  reset(): void;
  stop(): Promise<void>;
}

export async function startFakeConfluence(options: { host?: string; port?: number; publicHost?: string; clientId?: string; clientSecret?: string } = {}): Promise<FakeConfluence> {
  let data = defaultConfluenceData();
  let baseUrl = '';
  const GW = `/ex/confluence/${CONFLUENCE_SITE_ID}`;

  const pageJson = (p: FakeConfluencePage, withBody: boolean): Record<string, unknown> => ({
    id: p.id,
    status: p.status,
    title: p.title,
    spaceId: p.spaceId,
    parentId: p.parentId ?? null,
    version: { number: 1, createdAt: p.modified },
    ...(withBody ? { body: { storage: { representation: 'storage', value: p.body } } } : {}),
    _links: { webui: `/spaces/${data.spaces.find((s) => s.id === p.spaceId)?.key ?? 'X'}/pages/${p.id}`, base: `${baseUrl}/wiki` },
  });

  const api = (r: DocApiRequest): void => {
    if (r.path === '/oauth/token/accessible-resources') return r.send(200, [{ id: CONFLUENCE_SITE_ID, url: `${baseUrl}/site`, name: 'kahf', scopes: r.scopes }]);
    if (r.path === '/me') return r.send(200, { email: r.account, name: r.account, account_id: 'acct-1' });
    if (!r.path.startsWith(`${GW}/wiki/`)) return;
    const sub = r.path.slice(GW.length);
    if (r.method !== 'GET') return r.send(405, { message: 'read only' });

    if (sub === '/wiki/api/v2/spaces') return r.send(200, { results: data.spaces.map((s) => ({ id: s.id, key: s.key, name: s.name, type: 'global', status: 'current' })), _links: {} });

    if (sub === '/wiki/api/v2/pages') {
      const space = r.query.get('space-id');
      const status = r.query.get('status') ?? 'current';
      const limit = Math.max(1, Math.min(250, Number(r.query.get('limit') ?? 25)));
      const from = Number(r.query.get('cursor') ?? 0) || 0;
      const found = data.pages
        .filter((p) => (space === null || p.spaceId === space) && p.status === status)
        .sort((a, b) => b.modified.localeCompare(a.modified) || b.id.localeCompare(a.id));
      const page = found.slice(from, from + limit);
      const more = from + limit < found.length;
      return r.send(200, {
        results: page.map((p) => pageJson(p, false)),
        _links: more ? { next: `/wiki/api/v2/pages?${new URLSearchParams({ ...(space ? { 'space-id': space } : {}), status, limit: String(limit), cursor: String(from + limit) }).toString()}` } : {},
      });
    }

    const one = /^\/wiki\/api\/v2\/pages\/([^/]+)(\/ancestors)?$/.exec(sub);
    if (one) {
      const p = data.pages.find((x) => x.id === decodeURIComponent(one[1]!));
      if (!p) return r.send(404, { errors: [{ status: 404, title: 'Not Found' }] });
      if (one[2]) {
        const chain: FakeConfluencePage[] = [];
        let at = p.parentId ? data.pages.find((x) => x.id === p.parentId) : undefined;
        while (at && chain.length < 50) {
          chain.push(at);
          at = at.parentId ? data.pages.find((x) => x.id === at!.parentId) : undefined;
        }
        return r.send(200, { results: chain.map((c) => ({ id: c.id, type: 'page' })), _links: {} });
      }
      return r.send(200, pageJson(p, r.query.get('body-format') === 'storage'));
    }

    const perms = /^\/wiki\/api\/v2\/spaces\/([^/]+)\/permissions$/.exec(sub);
    if (perms) {
      const s = data.spaces.find((x) => x.id === decodeURIComponent(perms[1]!));
      if (!s) return r.send(404, { errors: [{ status: 404, title: 'Not Found' }] });
      const read = { key: 'read', targetType: 'space' };
      return r.send(200, {
        results: [
          ...(s.groupRead === false ? [] : [{ id: 'p1', principal: { type: 'group', id: 'confluence-users' }, operation: read }]),
          ...(s.anonymousRead ? [{ id: 'p2', principal: { type: 'anonymous', id: 'anonymous' }, operation: read }] : []),
        ],
        _links: {},
      });
    }

    const restriction = /^\/wiki\/rest\/api\/content\/([^/]+)\/restriction\/byOperation\/read$/.exec(sub);
    if (restriction) {
      const p = data.pages.find((x) => x.id === decodeURIComponent(restriction[1]!));
      if (!p) return r.send(404, { message: 'No content found' });
      return r.send(200, { operation: 'read', restrictions: { user: { results: p.restricted ? [{ type: 'known', accountId: 'acct-restricted' }] : [], size: p.restricted ? 1 : 0 }, group: { results: [], size: 0 } } });
    }
  };

  const server = await startDocServer({
    id: 'confluence',
    ...options,
    authorizePath: '/authorize',
    tokenPath: '/oauth/token',
    pkce: false,
    rotate: true,
    api,
  });
  baseUrl = server.url;
  const now = (): string => new Date().toISOString();

  return {
    server,
    url: server.url,
    get data() {
      return data;
    },
    putPage(page) {
      const made: FakeConfluencePage = { modified: now(), status: 'current', ...page };
      const at = data.pages.findIndex((p) => p.id === page.id);
      if (at >= 0) data.pages[at] = made;
      else data.pages.push(made);
    },
    editPage(id, changes, modified) {
      const p = data.pages.find((x) => x.id === id);
      if (!p) throw new Error(`no page ${id}`);
      if (changes.title !== undefined) p.title = changes.title;
      if (changes.body !== undefined) p.body = changes.body;
      p.modified = modified ?? now();
    },
    trashPage(id, modified) {
      const p = data.pages.find((x) => x.id === id);
      if (!p) throw new Error(`no page ${id}`);
      p.status = 'trashed';
      p.modified = modified ?? now();
    },
    restrictPage(id, restricted) {
      const p = data.pages.find((x) => x.id === id);
      if (p) p.restricted = restricted;
    },
    reset() {
      data = defaultConfluenceData();
      server.clearLogs();
    },
    stop: () => server.stop(),
  };
}

export const confluenceModule: StandInModule = {
  id: 'confluence',
  async start(ctx) {
    const fake = await startFakeConfluence({
      host: ctx.host,
      port: ctx.port,
      publicHost: ctx.publicHost,
      ...(ctx.clientId ? { clientId: ctx.clientId } : {}),
      ...(ctx.clientSecret ? { clientSecret: ctx.clientSecret } : {}),
    });
    return {
      id: 'confluence',
      api: fake,
      urls: { url: fake.url },
      env: () => oauthEnv('confluence', fake.server),
      state: () => ({ apiCalls: fake.server.apiCalls, tokenCalls: fake.server.tokenCalls, consents: fake.server.consents, pages: fake.data.pages.map((p) => ({ id: p.id, space: p.spaceId, title: p.title, status: p.status, modified: p.modified })) }),
      reset: () => fake.reset(),
      stop: () => fake.stop(),
    };
  },
};
