import { createSystemPool, withSystem, type Tx } from '@manythreads/kernel';
import { seedWorld, personas, startTestServer, type Persona, type TestServer } from '@manythreads/test-utils';
import type pg from 'pg';

export { personas };
export type { Persona };

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
}

export interface World {
  server: TestServer;
  /** Request as `who` through the test-only dev header; `null` sends no actor. */
  call<T = unknown>(who: Persona | null, method: string, path: string, body?: unknown): Promise<ApiResult<T>>;
  /** Upload an archive as `who`: the bytes are the raw request body, the choices ride in the address. */
  upload<T = unknown>(who: Persona | null, query: string, bytes: Uint8Array): Promise<ApiResult<T>>;
  /** SQL as the system actor (assertions about rows no API returns, bulk fixtures). */
  system<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const header = (who: Persona | null): Record<string, string> =>
  who ? { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId }) } : {};

/** A migrated database with every plugin, the seed world (workspace, the seven personas, the three teams) and a server on a random port with dev auth on. */
export async function createWorld(): Promise<World> {
  const server = await startTestServer();
  await seedWorld(server.db);
  const systemPool: pg.Pool = createSystemPool(server.db.systemUrl, 2);
  const world: World = {
    server,
    async call(who, method, path, body) {
      const headers: Record<string, string> = header(who);
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(`${server.url}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : null) as never };
    },
    async upload(who, query, bytes) {
      const res = await fetch(`${server.url}/api/admin/imports?${query}`, {
        method: 'POST',
        headers: { ...header(who), 'content-type': 'application/octet-stream' },
        body: bytes,
      });
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : null) as never };
    },
    system: (fn) => withSystem(fn, { pool: systemPool }),
    async close() {
      await systemPool.end();
      await server.close();
    },
  };
  return world;
}

/** Polls until `check` returns a value (not undefined/false); throws after `timeoutMs`. */
export async function eventually<T>(check: () => Promise<T | undefined | false>, timeoutMs = 60_000, what = 'condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
