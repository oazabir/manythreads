import { createSystemPool, withSystem, type Tx } from '@manythreads/kernel';
import {
  createPersonas,
  personas,
  startTestServer,
  type Persona,
  type TestServer,
} from '@manythreads/test-utils';
import type pg from 'pg';

export { personas };
export type { Persona };

/** Who a request acts as: a persona, or any actor row (people created by accepting an invitation). */
export interface ActingAs {
  actorId: string;
  workspaceId: string;
}

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
}

export interface World {
  server: TestServer;
  /** Request as `who` (dev header actor); `null` sends no actor. */
  call(who: Persona | ActingAs | null, method: string, path: string, body?: unknown): Promise<ApiResult>;
  /** Run SQL as the system actor (assertions about rows no API returns). */
  system<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const actingAs = (who: Persona | ActingAs): ActingAs =>
  'actorId' in who && 'workspaceId' in who ? { actorId: who.actorId, workspaceId: who.workspaceId } : (who as ActingAs);

/** A migrated database with every plugin (teams included), the seven personas, and a server on a random port. */
export async function createWorld(): Promise<World> {
  const server = await startTestServer();
  await createPersonas(server.db);
  const systemPool: pg.Pool = createSystemPool(server.db.systemUrl, 2);
  return {
    server,
    async call(who, method, path, body) {
      const headers: Record<string, string> = {};
      if (who) {
        const a = actingAs(who);
        headers['x-manythreads-dev-actor'] = JSON.stringify({ kind: 'person', id: a.actorId, workspaceId: a.workspaceId });
      }
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(`${server.url}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
    },
    system: (fn) => withSystem(fn, { pool: systemPool }),
    async close() {
      await systemPool.end();
      await server.close();
    },
  };
}
