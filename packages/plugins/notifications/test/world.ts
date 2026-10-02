import { createSystemPool, withSystem, type Tx } from '@manythreads/kernel';
import type { NavChannelDirectory } from '@manythreads/shared';
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
  /** SQL as the system actor (assertions about rows no API returns, bulk fixtures). */
  system<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** The channel with this name in the team, found through the system role (no visibility rules). */
  channelId(teamSlug: string, name: string): Promise<string>;
  /** The channel id as `who` sees it in the sidebar directory, or undefined. */
  directoryChannel(who: Persona, teamSlug: string, name: string): Promise<string | undefined>;
  close(): Promise<void>;
}

/**
 * A migrated database with every plugin, the seed world (workspace, the seven personas, the three teams with the templates they
 * were made from) and a server on a random port with dev auth on. Template channels appear when somebody first asks for a
 * team's directory (or when `team.template.applied` is consumed): call `ensureChannels` to make them now.
 */
export async function createWorld(): Promise<World> {
  const server = await startTestServer();
  await seedWorld(server.db);
  const systemPool: pg.Pool = createSystemPool(server.db.systemUrl, 2);
  const call: World['call'] = async (who, method, path, body) => {
    const headers: Record<string, string> = {};
    if (who) headers['x-manythreads-dev-actor'] = JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId });
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${server.url}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as never };
  };
  const world: World = {
    server,
    call,
    system: (fn) => withSystem(fn, { pool: systemPool }),
    async channelId(teamSlug, name) {
      const id = await world.system(async (tx) => {
        const r = await tx.query<{ id: string }>(
          'SELECT c.id FROM app.channels c JOIN app.teams t ON t.id = c.team_id WHERE t.slug = $1 AND c.name = $2',
          [teamSlug, name.replace(/^#/, '')],
        );
        return r.rows[0]?.id;
      });
      if (!id) throw new Error(`no channel #${name} in ${teamSlug}`);
      return id;
    },
    async directoryChannel(who, teamSlug, name) {
      const res = await call<NavChannelDirectory>(who, 'GET', `/api/teams/${teamSlug}/channels`);
      return res.body.groups.flatMap((g) => g.channels).find((c) => c.name.replace(/^#/, '') === name.replace(/^#/, ''))?.id;
    },
    async close() {
      await systemPool.end();
      await server.close();
    },
  };
  return world;
}

/** Makes the template channels of the three seeded teams exist (the directory does it on first request). */
export async function ensureChannels(w: World): Promise<void> {
  const { omar, sameera, tariq } = personas;
  await w.call(omar, 'GET', '/api/teams/engineering/channels');
  await w.call(sameera, 'GET', '/api/teams/customer-support/channels');
  await w.call(tariq, 'GET', '/api/teams/marketing/channels');
}

/** Polls until `check` returns a value (not undefined/false); throws the last state after `timeoutMs`. */
export async function eventually<T>(check: () => Promise<T | undefined | false>, timeoutMs = 20_000, what = 'condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Waits until the outbox consumer has handled every event written so far (nothing ready, claimed or retrying). */
export async function drained(w: World): Promise<void> {
  await eventually(
    async () => {
      const n = await w.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.outbox WHERE done_at IS NULL AND dead_at IS NULL')).rows[0]!.n);
      return n === 0 ? true : undefined;
    },
    30_000,
    'the outbox to drain',
  );
}
