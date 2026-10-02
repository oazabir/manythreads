import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createAppPool, createSystemPool, emit, withActor, withSystem, type Actor, type Tx } from '@manythreads/kernel';
import type { PluginTx } from '@manythreads/sdk';
import type { ActorId, WorkspaceId } from '@manythreads/shared';
import { personaActor, personas, seedWorld, startTestServer, TEAM_IDS, type Persona, type TestServer } from '@manythreads/test-utils';
import type pg from 'pg';
import { createGitLayer, createRepoService, type RepoService } from '../src/index.ts';

export { personas, TEAM_IDS };
export type { Persona };

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
}

/** Anything that can call the API or open a transaction: a persona or a bot. */
export interface Who {
  kind?: 'person' | 'bot';
  actorId: string;
  workspaceId: string;
}
export interface Bot extends Who {
  kind: 'bot';
}

export interface RepoWorld {
  server: TestServer;
  repoDir: string;
  /** HTTP as `who` through the test-only dev header; `null` sends no actor. */
  call<T = unknown>(who: Who | null, method: string, path: string, body?: unknown): Promise<ApiResult<T>>;
  /** SQL as the system actor. */
  system<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** A transaction as `who` on the app pool (what a request handler gets). */
  as<T>(who: Who, fn: (tx: PluginTx & Tx) => Promise<T>): Promise<T>;
  /** A repo service of its own (its own queue and git runner): another replica of the server on the same directory and database. */
  replica(): RepoService;
  gitDir(teamId: string): string;
  /** A bot on the roster of the team with the grants given (default: `files.write`). */
  makeBot(teamId: string, grants?: string[]): Promise<Bot>;
  commit(who: Who | null, slug: string, changes: unknown[], message: string): Promise<ApiResult<any>>;
  close(): Promise<void>;
}

const headerFor = (who: Who | null): Record<string, string> =>
  who ? { 'x-manythreads-dev-actor': JSON.stringify({ kind: who.kind ?? 'person', id: who.actorId, workspaceId: who.workspaceId }) } : {};

export async function createRepoWorld(): Promise<RepoWorld> {
  const server = await startTestServer();
  const repoDir = process.env['MANYTHREADS_REPO_DIR'] ?? '';
  await seedWorld(server.db);
  const systemPool: pg.Pool = createSystemPool(server.db.systemUrl, 2);
  const appPool: pg.Pool = createAppPool(server.db.appUrl, 8);
  const call: RepoWorld['call'] = async (who, method, path, body) => {
    const headers: Record<string, string> = { ...headerFor(who) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${server.url}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as never };
  };
  const world: RepoWorld = {
    server,
    repoDir,
    call,
    system: (fn) => withSystem(fn, { pool: systemPool, workspaceId: personas.omar.workspaceId }),
    as: (who, fn) =>
      withActor({ kind: who.kind ?? 'person', id: who.actorId as ActorId, workspaceId: who.workspaceId as WorkspaceId } as Actor, (tx) => fn(tx as PluginTx & Tx), { pool: appPool }),
    replica: () =>
      createRepoService({
        repoDir,
        git: createGitLayer(),
        // The service-level tests act as people; bots are tested through HTTP, where the server's own broker answers.
        authorize: () => Promise.resolve({ allowed: true, reason: 'test', needsApproval: false }),
        emit: async (tx, event) => {
          await emit(tx as unknown as Tx, { schemaVersion: 1, workspaceId: tx.actor.workspaceId, ...event });
        },
      }),
    gitDir: (teamId) => join(repoDir, `${teamId}.git`),
    async makeBot(teamId, grants = ['files.write']) {
      const id = await world.system(async (tx) => {
        const actor = await tx.query<{ id: string }>(
          `INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id`,
          [personas.omar.workspaceId, randomUUID()],
        );
        const actorId = actor.rows[0]!.id;
        await tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [teamId, actorId, personas.omar.workspaceId]);
        for (const capability of grants) {
          await tx.query(`INSERT INTO app.capability_grants (team_id, actor_id, capability) VALUES ($1, $2, $3)`, [teamId, actorId, capability]);
        }
        return actorId;
      });
      return { kind: 'bot', actorId: id, workspaceId: personas.omar.workspaceId };
    },
    commit: (who, slug, changes, message) => call(who, 'POST', `/api/teams/${slug}/repo/commit`, { changes, message }),
    async close() {
      await systemPool.end();
      await appPool.end();
      await server.close();
    },
  };
  return world;
}

export const actorOf = (p: Persona): Actor => personaActor(p);
