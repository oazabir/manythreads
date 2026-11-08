import { oauthEnv, startDocServer, type DocApiRequest, type DocServer } from './doc-oauth.ts';
import type { StandInModule } from './types.ts';

/*
 * A Box stand-in (PLAN Bundle D, P16-08): OAuth with a rotating refresh token (form body, no PKCE), and the calls the document reader uses: the folder tree
 * (`folders/<id>/items` with marker paging, `folders/trash/items`), a file's details and content, the collaborations of a file or a folder, and `users/me`.
 * Real Box answers a content request with a redirect to a download address; this stand-in sends the bytes directly, unless `redirectDownloadsTo` is set, in which case it
 * answers the redirect (a test of what the reader does with an address it must not dial).
 */

export interface FakeBoxCollaboration {
  /** A person's address, or a group's name. */
  who: string;
  group?: boolean;
  /** Box's state of the invitation; `accepted` when left out. */
  status?: 'accepted' | 'pending' | 'rejected';
}

export interface FakeBoxFolder {
  id: string;
  name: string;
  parentId: string;
  collaborations?: FakeBoxCollaboration[];
}

export interface FakeBoxFile {
  id: string;
  name: string;
  parentId: string;
  content: string | Buffer;
  /** Last edit (ISO, any offset). */
  modified: string;
  etag: string;
  reportedSize?: number;
  /** The file's own shared link. */
  link?: 'open' | 'company' | 'collaborators';
  collaborations?: FakeBoxCollaboration[];
  /** When it was put in the trash (ISO). */
  trashedAt?: string;
}

export interface FakeBoxData {
  folders: FakeBoxFolder[];
  files: FakeBoxFile[];
}

export function defaultBoxData(): FakeBoxData {
  return {
    folders: [
      { id: '100', name: 'Docs', parentId: '0', collaborations: [{ who: 'lena@kahf.example' }] },
      { id: '101', name: 'Handbook', parentId: '100' },
      { id: '102', name: 'Private', parentId: '0' },
    ],
    files: [
      { id: '201', name: 'Welcome.md', parentId: '100', content: '# Welcome\n\nHello from Box.', modified: '2026-10-01T09:00:00-07:00', etag: '0' },
      { id: '202', name: 'Rules.txt', parentId: '101', content: 'Rule one: be kind.', modified: '2026-10-02T09:00:00-07:00', etag: '0', link: 'open' },
      { id: '203', name: 'Report.pdf', parentId: '100', content: Buffer.from('%PDF-1.4 fake'), modified: '2026-10-03T09:00:00-07:00', etag: '0', collaborations: [{ who: 'Everyone', group: true }] },
      { id: '204', name: 'photo.png', parentId: '100', content: Buffer.from('not text'), modified: '2026-10-03T10:00:00-07:00', etag: '0' },
      { id: '205', name: 'Notes.txt', parentId: '102', content: 'only mine', modified: '2026-10-04T09:00:00-07:00', etag: '0' },
    ],
  };
}

export interface FakeBox {
  server: DocServer;
  url: string;
  data: FakeBoxData;
  putFile(file: Omit<FakeBoxFile, 'modified' | 'etag'> & { modified?: string; etag?: string }): void;
  /** Moves a file to the trash. */
  trashFile(id: string, at?: string): void;
  /** Content requests answer a redirect to this address instead of the bytes. */
  redirectDownloadsTo(address: string | null): void;
  reset(): void;
  stop(): Promise<void>;
}

export async function startFakeBox(options: { host?: string; port?: number; publicHost?: string; clientId?: string; clientSecret?: string } = {}): Promise<FakeBox> {
  let data = defaultBoxData();
  let redirectTo: string | null = null;
  let etags = 100;

  const size = (f: FakeBoxFile): number => f.reportedSize ?? Buffer.byteLength(f.content);
  const fileJson = (f: FakeBoxFile): Record<string, unknown> => ({
    type: 'file',
    id: f.id,
    name: f.name,
    size: size(f),
    etag: f.etag,
    sequence_id: f.etag,
    modified_at: f.modified,
    trashed_at: f.trashedAt ?? null,
  });
  const folderJson = (f: FakeBoxFolder): Record<string, unknown> => ({ type: 'folder', id: f.id, name: f.name });
  const pathOf = (f: FakeBoxFile): Array<Record<string, unknown>> => {
    const chain: Array<Record<string, unknown>> = [];
    let at = data.folders.find((x) => x.id === f.parentId);
    while (at && chain.length < 50) {
      chain.unshift({ type: 'folder', id: at.id, name: at.name });
      at = data.folders.find((x) => x.id === at!.parentId);
    }
    return [{ type: 'folder', id: '0', name: 'All Files' }, ...chain];
  };
  const collabJson = (list: FakeBoxCollaboration[] | undefined): unknown[] =>
    (list ?? []).map((c, i) => ({ type: 'collaboration', id: `col-${i}`, status: c.status ?? 'accepted', accessible_by: c.group ? { type: 'group', id: `g-${i}`, name: c.who } : { type: 'user', id: `u-${i}`, login: c.who, name: c.who } }));
  const page = <T>(rows: T[], r: DocApiRequest): { entries: T[]; next_marker: string } => {
    const limit = Math.max(1, Math.min(1000, Number(r.query.get('limit') ?? 100)));
    const from = Number(r.query.get('marker') ?? 0) || 0;
    return { entries: rows.slice(from, from + limit), next_marker: from + limit < rows.length ? String(from + limit) : '' };
  };

  const api = (r: DocApiRequest): void => {
    if (r.method !== 'GET') return;
    if (r.path === '/2.0/users/me') return r.send(200, { type: 'user', id: 'u0', login: r.account, name: r.account });

    if (r.path === '/2.0/folders/trash/items') {
      const rows = data.files.filter((f) => f.trashedAt).sort((a, b) => Date.parse(b.trashedAt!) - Date.parse(a.trashedAt!));
      const p = page(rows, r);
      return r.send(200, { ...p, entries: p.entries.map(fileJson) });
    }
    const items = /^\/2\.0\/folders\/([^/]+)\/items$/.exec(r.path);
    if (items) {
      const id = decodeURIComponent(items[1]!);
      if (id !== '0' && !data.folders.some((f) => f.id === id)) return r.send(404, { type: 'error', status: 404, code: 'not_found' });
      const rows = [...data.folders.filter((f) => f.parentId === id).map(folderJson), ...data.files.filter((f) => f.parentId === id && !f.trashedAt).map(fileJson)];
      return r.send(200, page(rows, r));
    }
    const file = /^\/2\.0\/files\/([^/]+)(\/content|\/collaborations)?$/.exec(r.path);
    if (file) {
      const f = data.files.find((x) => x.id === decodeURIComponent(file[1]!));
      if (!f) return r.send(404, { type: 'error', status: 404, code: 'not_found' });
      if (file[2] === '/content') {
        if (redirectTo) return r.redirect(redirectTo);
        return r.sendBytes(200, Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content), 'application/octet-stream');
      }
      if (file[2] === '/collaborations') return r.send(200, { entries: collabJson(f.collaborations), next_marker: '' });
      return r.send(200, {
        ...fileJson(f),
        shared_link: f.link ? { url: 'https://box.example/s/link', access: f.link, effective_access: f.link } : null,
        path_collection: { total_count: pathOf(f).length, entries: pathOf(f) },
        owned_by: { type: 'user', id: 'u0', login: r.account },
      });
    }
    const folder = /^\/2\.0\/folders\/([^/]+)\/collaborations$/.exec(r.path);
    if (folder) {
      const f = data.folders.find((x) => x.id === decodeURIComponent(folder[1]!));
      if (!f) return r.send(404, { type: 'error', status: 404, code: 'not_found' });
      return r.send(200, { entries: collabJson(f.collaborations), next_marker: '' });
    }
  };

  const server = await startDocServer({
    id: 'box',
    ...options,
    authorizePath: '/api/oauth2/authorize',
    tokenPath: '/oauth2/token',
    pkce: false,
    rotate: true,
    api,
  });
  const now = (): string => new Date().toISOString();

  return {
    server,
    url: server.url,
    get data() {
      return data;
    },
    putFile(file) {
      const made: FakeBoxFile = { modified: now(), etag: String(++etags), ...file };
      const at = data.files.findIndex((f) => f.id === file.id);
      if (at >= 0) data.files[at] = made;
      else data.files.push(made);
    },
    trashFile(id, at) {
      const f = data.files.find((x) => x.id === id);
      if (!f) throw new Error(`no file ${id}`);
      f.trashedAt = at ?? now();
    },
    redirectDownloadsTo: (address) => void (redirectTo = address),
    reset() {
      data = defaultBoxData();
      redirectTo = null;
      etags = 100;
      server.clearLogs();
    },
    stop: () => server.stop(),
  };
}

export const boxModule: StandInModule = {
  id: 'box',
  async start(ctx) {
    const fake = await startFakeBox({
      host: ctx.host,
      port: ctx.port,
      publicHost: ctx.publicHost,
      ...(ctx.clientId ? { clientId: ctx.clientId } : {}),
      ...(ctx.clientSecret ? { clientSecret: ctx.clientSecret } : {}),
    });
    return {
      id: 'box',
      api: fake,
      urls: { url: fake.url },
      env: () => oauthEnv('box', fake.server),
      state: () => ({ apiCalls: fake.server.apiCalls, tokenCalls: fake.server.tokenCalls, consents: fake.server.consents, files: fake.data.files.map((f) => ({ id: f.id, name: f.name, trashed: f.trashedAt !== undefined })) }),
      reset: () => fake.reset(),
      stop: () => fake.stop(),
    };
  },
};
