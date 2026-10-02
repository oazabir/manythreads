import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld as createChannelsWorld, ensureChannels, personas, type ApiResult, type Persona, type World } from '../../channels/test/world.ts';

export { ensureChannels, personas };
export type { ApiResult, Persona, World };

export interface FilesWorld extends World {
  /** The directory the storage-local provider writes to (set through MANYTHREADS_STORAGE_DIR before the server starts). */
  storageDir: string;
  /** Uploads raw bytes (or a stream) as `who`: `x-file-name` percent-encoded, `content-type` as given. */
  upload(
    who: Persona | null,
    channelId: string,
    body: Uint8Array | AsyncIterable<Uint8Array> | string,
    opts?: { name?: string; type?: string; headers?: Record<string, string> },
  ): Promise<ApiResult>;
  /** Downloads the bytes of a file as `who`. */
  download(who: Persona | null, fileId: string, query?: string): Promise<{ status: number; headers: Headers; bytes: Buffer }>;
  /** A read or post grant on a channel for a person (Lena is a guest: grants are her only access). */
  grant(channelId: string, who: Persona, permission: 'read' | 'post'): Promise<void>;
  revoke(channelId: string, who: Persona): Promise<void>;
}

const headersFor = (who: Persona | null): Record<string, string> =>
  who ? { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId }) } : {};

/** The channels world plus a storage directory of its own and upload/download helpers. */
export async function createWorld(options: { storage?: 'local' | 's3' } = {}): Promise<FilesWorld> {
  const storageDir = mkdtempSync(join(tmpdir(), 'manythreads-files-test-'));
  process.env['MANYTHREADS_STORAGE_DIR'] = storageDir;
  const w = await createChannelsWorld(options);
  const files: FilesWorld = {
    ...w,
    storageDir,
    async upload(who, channelId, body, opts = {}) {
      const headers: Record<string, string> = { ...headersFor(who), ...opts.headers };
      if (opts.type) headers['content-type'] = opts.type;
      if (opts.name !== undefined) headers['x-file-name'] = encodeURIComponent(opts.name);
      if (typeof body === 'string' || body instanceof Uint8Array) {
        const res = await fetch(`${w.server.url}/api/channels/${channelId}/files`, { method: 'POST', headers, body: (typeof body === 'string' ? Buffer.from(body) : body) as unknown as RequestInit['body'] });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
      }
      // A stream of unknown length goes chunked through node:http (fetch keeps a half-sent connection open after an early answer).
      const u = new URL(`${w.server.url}/api/channels/${channelId}/files`);
      return new Promise<ApiResult>((resolve, reject) => {
        const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', agent: false, headers: { ...headers, 'transfer-encoding': 'chunked' } }, (res) => {
          const parts: Buffer[] = [];
          res.on('data', (c: Buffer) => parts.push(c));
          res.on('end', () => {
            const text = Buffer.concat(parts).toString();
            resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
          });
        });
        req.on('error', reject);
        void (async () => {
          try {
            for await (const chunk of body) if (!req.write(chunk)) await new Promise((r) => req.once('drain', r));
            req.end();
          } catch {
            req.destroy();
          }
        })();
      });
    },
    async download(who, fileId, query = '') {
      const res = await fetch(`${w.server.url}/api/files/${fileId}/content${query}`, { headers: headersFor(who) });
      return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
    },
    grant: (channelId, who, permission) =>
      w.system(async (tx) => {
        await tx.query(
          `INSERT INTO app.acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission)
           VALUES ($1, 'channel', $2, 'person', $3, $4) ON CONFLICT DO NOTHING`,
          [who.workspaceId, channelId, who.personId, permission],
        );
      }),
    revoke: (channelId, who) =>
      w.system(async (tx) => {
        await tx.query(`DELETE FROM app.acl_entries WHERE resource_type = 'channel' AND resource_id = $1 AND subject_id = $2`, [channelId, who.personId]);
      }),
    async close() {
      await w.close();
      rmSync(storageDir, { recursive: true, force: true });
    },
  };
  return files;
}
