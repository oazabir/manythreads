import { oauthEnv, startDocServer, type DocApiRequest, type DocServer } from './doc-oauth.ts';
import type { StandInModule } from './types.ts';

/*
 * A Dropbox stand-in (PLAN Bundle D, P16-08): OAuth with PKCE (no rotation), and the calls the document reader uses on one address (the API host and the content host are
 * the same server here): `files/list_folder` (+ `continue`) with cursors and `deleted` entries, `files/download`, `sharing/list_file_members`,
 * `sharing/list_shared_links` and `users/get_current_account`.
 *
 * Cursors are made of the position in the change log and the folder, so a cursor taken after a listing returns only what changed since, and a cursor that is not ours is
 * answered with Dropbox's `reset` error (409), which a reader answers by listing the folder again.
 */

export interface FakeDropboxFile {
  /** The path as typed (any case). */
  path: string;
  content: string | Buffer;
  rev: string;
  /** Last change (ISO). */
  modified: string;
  /** A size to report instead of the real one (for a "too big" file; the download still sends `content`). */
  reportedSize?: number;
  sharing?: {
    /** Other people with access (e-mail addresses). */
    members?: string[];
    /** A group has access. */
    group?: boolean;
    /** A link anyone can open. */
    publicLink?: boolean;
    /** A link for the team of the owner only. */
    teamLink?: boolean;
  };
}

export interface FakeDropboxData {
  folders: string[];
  files: FakeDropboxFile[];
}

export function defaultDropboxData(): FakeDropboxData {
  return {
    folders: ['/Docs', '/Docs/Handbook', '/Private'],
    files: [
      { path: '/Docs/Welcome.md', content: '# Welcome\n\nHello from Dropbox.', rev: 'rev0001', modified: '2026-10-01T09:00:00.000Z', sharing: { members: ['lena@kahf.example'] } },
      { path: '/Docs/Handbook/Rules.txt', content: 'Rule one: be kind.', rev: 'rev0002', modified: '2026-10-02T09:00:00.000Z', sharing: { publicLink: true } },
      { path: '/Docs/Report.pdf', content: Buffer.from('%PDF-1.4 fake'), rev: 'rev0003', modified: '2026-10-03T09:00:00.000Z', sharing: { group: true } },
      { path: '/Docs/photo.png', content: Buffer.from('not text'), rev: 'rev0004', modified: '2026-10-03T10:00:00.000Z' },
      { path: '/Private/Notes.txt', content: 'only mine', rev: 'rev0005', modified: '2026-10-04T09:00:00.000Z' },
    ],
  };
}

export interface FakeDropbox {
  server: DocServer;
  url: string;
  data: FakeDropboxData;
  /** Adds or replaces a file (its change is logged). */
  putFile(file: Omit<FakeDropboxFile, 'rev' | 'modified'> & { rev?: string; modified?: string }): void;
  removeFile(path: string): void;
  /** The next `list_folder/continue` is answered with the `reset` error once. */
  resetNextCursor(): void;
  reset(): void;
  stop(): Promise<void>;
}

const lower = (p: string): string => p.toLowerCase();
const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

export async function startFakeDropbox(options: { host?: string; port?: number; publicHost?: string; clientId?: string; clientSecret?: string } = {}): Promise<FakeDropbox> {
  let data = defaultDropboxData();
  let seq = 1000;
  let log: Array<{ seq: number; path: string }> = [];
  let resetOnce = false;

  const under = (root: string, path: string): boolean => root === '' || lower(path) === lower(root) || lower(path).startsWith(`${lower(root)}/`);
  const encodeCursor = (mode: 's' | 'd', at: number, root: string, offset: number): string => `${mode}.${String(at)}.${String(offset)}.${Buffer.from(root).toString('base64url')}`;
  const decodeCursor = (c: string): { mode: 's' | 'd'; at: number; offset: number; root: string } | null => {
    const m = /^([sd])\.(\d+)\.(\d+)\.([A-Za-z0-9_-]*)$/.exec(c);
    return m ? { mode: m[1] as 's' | 'd', at: Number(m[2]), offset: Number(m[3]), root: Buffer.from(m[4]!, 'base64url').toString('utf8') } : null;
  };
  const fileEntry = (f: FakeDropboxFile): Record<string, unknown> => ({
    '.tag': 'file',
    name: nameOf(f.path),
    path_lower: lower(f.path),
    path_display: f.path,
    id: `id:${lower(f.path)}`,
    rev: f.rev,
    size: f.reportedSize ?? Buffer.byteLength(f.content),
    server_modified: f.modified,
    is_downloadable: true,
    content_hash: `hash-${f.rev}`,
  });
  const folderEntry = (p: string): Record<string, unknown> => ({ '.tag': 'folder', name: nameOf(p), path_lower: lower(p), path_display: p, id: `id:${lower(p)}` });
  const find = (p: string): FakeDropboxFile | undefined => data.files.find((f) => lower(f.path) === lower(p));

  /** Everything under `root` as it is now, in path order. */
  const snapshot = (root: string, recursive: boolean): Array<Record<string, unknown>> => {
    const depth = (p: string): number => p.split('/').length;
    const inRoot = (p: string): boolean => under(root, p) && lower(p) !== lower(root) && (recursive || depth(p) === depth(root) + 1);
    return [...data.folders.filter(inRoot).map(folderEntry), ...data.files.filter((f) => inRoot(f.path)).map(fileEntry)].sort((a, b) => String(a['path_lower']).localeCompare(String(b['path_lower'])));
  };
  /** What changed under `root` after `since`: the latest state of each changed path, `deleted` when it is gone. */
  const delta = (root: string, since: number): Array<Record<string, unknown>> => {
    const latest = new Map<string, number>();
    for (const c of log) if (c.seq > since && under(root, c.path)) latest.set(lower(c.path), c.seq);
    return [...latest.keys()]
      .sort()
      .map((p) => {
        const f = find(p);
        return f ? fileEntry(f) : { '.tag': 'deleted', name: nameOf(p), path_lower: p, path_display: p };
      });
  };

  const pathError = (r: DocApiRequest): void => r.send(409, { error_summary: 'path/not_found/..', error: { '.tag': 'path', path: { '.tag': 'not_found' } } });

  const api = (r: DocApiRequest): void => {
    if (r.method !== 'POST') return;
    const json = (): Record<string, unknown> => {
      try {
        return rec(JSON.parse(r.body || '{}'));
      } catch {
        return {};
      }
    };
    if (r.path === '/2/users/get_current_account') return r.send(200, { email: r.account, account_id: 'dbid:fake', name: { display_name: r.account } });

    if (r.path === '/2/files/list_folder') {
      const b = json();
      const root = typeof b['path'] === 'string' ? (b['path'] as string) : '';
      if (root !== '' && !data.folders.some((f) => lower(f) === lower(root))) return pathError(r);
      const limit = Math.max(1, Math.min(2000, Number(b['limit'] ?? 500)));
      const entries = snapshot(root, b['recursive'] === true);
      const page = entries.slice(0, limit);
      const more = entries.length > limit;
      return r.send(200, { entries: page, cursor: more ? encodeCursor('s', seq, root, limit) : encodeCursor('d', seq, root, 0), has_more: more });
    }
    if (r.path === '/2/files/list_folder/continue') {
      const c = typeof json()['cursor'] === 'string' ? decodeCursor(json()['cursor'] as string) : null;
      if (resetOnce || !c) {
        resetOnce = false;
        return r.send(409, { error_summary: 'reset/..', error: { '.tag': 'reset' } });
      }
      if (c.mode === 's') {
        // the rest of a first listing (recursive, as the reader asks); the position is where the last page stopped
        const entries = snapshot(c.root, true);
        const page = entries.slice(c.offset, c.offset + 2000);
        const more = c.offset + 2000 < entries.length;
        return r.send(200, { entries: page, cursor: more ? encodeCursor('s', c.at, c.root, c.offset + 2000) : encodeCursor('d', c.at, c.root, 0), has_more: more });
      }
      return r.send(200, { entries: delta(c.root, c.at), cursor: encodeCursor('d', seq, c.root, 0), has_more: false });
    }
    if (r.path === '/2/files/download') {
      let arg: Record<string, unknown> = {};
      try {
        arg = rec(JSON.parse(String(r.headers['dropbox-api-arg'] ?? '{}')));
      } catch {
        /* a bad header */
      }
      const f = typeof arg['path'] === 'string' ? find(arg['path']) : undefined;
      if (!f) return pathError(r);
      return r.sendBytes(200, Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content), 'application/octet-stream', { 'dropbox-api-result': JSON.stringify(fileEntry(f)).replace(/[\u007f-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`) });
    }
    if (r.path === '/2/sharing/list_file_members') {
      const f = typeof json()['file'] === 'string' ? find(json()['file'] as string) : undefined;
      if (!f) return pathError(r);
      return r.send(200, {
        users: [
          { access_type: { '.tag': 'owner' }, user: { account_id: 'dbid:owner', email: r.account }, permissions: [], is_inherited: false },
          ...(f.sharing?.members ?? []).map((email) => ({ access_type: { '.tag': 'viewer' }, user: { account_id: `dbid:${email}`, email }, permissions: [], is_inherited: false })),
        ],
        groups: f.sharing?.group ? [{ access_type: { '.tag': 'viewer' }, group: { group_id: 'g:1', group_name: 'Everyone' }, permissions: [], is_inherited: false }] : [],
        invitees: [],
      });
    }
    if (r.path === '/2/sharing/list_shared_links') {
      const f = typeof json()['path'] === 'string' ? find(json()['path'] as string) : undefined;
      if (!f) return pathError(r);
      const links = [
        ...(f.sharing?.publicLink ? [{ '.tag': 'file', url: 'https://dropbox.example/s/public', link_permissions: { resolved_visibility: { '.tag': 'public' } } }] : []),
        ...(f.sharing?.teamLink ? [{ '.tag': 'file', url: 'https://dropbox.example/s/team', link_permissions: { resolved_visibility: { '.tag': 'team_only' } } }] : []),
      ];
      return r.send(200, { links, has_more: false });
    }
  };

  const server = await startDocServer({
    id: 'dropbox',
    ...options,
    authorizePath: '/oauth2/authorize',
    tokenPath: '/oauth2/token',
    pkce: true,
    rotate: false,
    accessTtl: 14400,
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
      const made: FakeDropboxFile = { rev: `rev${String(++seq)}`, modified: now(), ...file };
      const at = data.files.findIndex((f) => lower(f.path) === lower(file.path));
      if (at >= 0) data.files[at] = made;
      else data.files.push(made);
      log.push({ seq: ++seq, path: file.path });
    },
    removeFile(path) {
      data.files = data.files.filter((f) => lower(f.path) !== lower(path));
      log.push({ seq: ++seq, path });
    },
    resetNextCursor: () => void (resetOnce = true),
    reset() {
      data = defaultDropboxData();
      log = [];
      seq = 1000;
      resetOnce = false;
      server.clearLogs();
    },
    stop: () => server.stop(),
  };
}

export const dropboxModule: StandInModule = {
  id: 'dropbox',
  async start(ctx) {
    const fake = await startFakeDropbox({
      host: ctx.host,
      port: ctx.port,
      publicHost: ctx.publicHost,
      ...(ctx.clientId ? { clientId: ctx.clientId } : {}),
      ...(ctx.clientSecret ? { clientSecret: ctx.clientSecret } : {}),
    });
    return {
      id: 'dropbox',
      api: fake,
      urls: { url: fake.url },
      env: () => oauthEnv('dropbox', fake.server),
      state: () => ({ apiCalls: fake.server.apiCalls, tokenCalls: fake.server.tokenCalls, consents: fake.server.consents, files: fake.data.files.map((f) => ({ path: f.path, rev: f.rev })) }),
      reset: () => fake.reset(),
      stop: () => fake.stop(),
    };
  },
};
