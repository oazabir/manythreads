import { createAppPool, createSecretService, createSystemPool, withSystem, CapabilityBroker, CapabilityRegistry, createDbGrantSource, createRunService, type Tx } from '@manythreads/kernel';
import type { PluginTx } from '@manythreads/sdk';
import { McpRunMintResponse, StartPersonConnectionResponse, type PersonProviderId } from '@manythreads/shared';
import { startFakeProviders, type FakeProviders } from '@manythreads/test-utils';
import type pg from 'pg';
import { expect } from 'vitest';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld, type Who } from '../../repo-git/test/world.ts';
import { compileBot } from '../src/index.ts';
import type { Declared } from '../src/compile.ts';
import type { OAuthDeps } from '../src/oauth/store.ts';
import { PERSON_TOOL_DEFS } from '../src/person-tools.ts';

// A real server with the connections plugin, a fake Google/Microsoft/Notion, and the helpers the Bundle D admin tests share: sign a person in at the fake, make a bot and open a
// run as a person who asks, call a tool through the real MCP gateway, read the database as the system. Nothing here is a test (vitest ignores the file).

export { personas, TEAM_IDS };
export const WS = personas.omar.workspaceId;

export interface AdminWorld {
  w: RepoWorld;
  fake: FakeProviders;
  sysPool: pg.Pool;
  deps: OAuthDeps;
  sys: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  asPlugin: <T>(fn: (tx: PluginTx) => Promise<T>) => Promise<T>;
  raw: (who: Who, method: string, path: string, body?: unknown) => Promise<Response>;
  connect: (who: Who & { email: string }, provider: PersonProviderId, services?: string[]) => Promise<void>;
  connectionOf: (who: { actorId: string }, provider: string) => Promise<{ id: string; status: string; state: string } | undefined>;
  makeBot: (team: string, slug: string, connections?: unknown) => Promise<{ botId: string; actorId: string }>;
  compile: (team: string, botId: string) => Promise<unknown>;
  openRun: (botId: string, team: string, askerActorId: string | null) => Promise<McpRunMintResponse>;
  called: (run: McpRunMintResponse, name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  answers: string[];
  until: <T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string) => Promise<T>;
  close: () => Promise<void>;
}

const declared: Declared = new Map([['email.read', { destructive: false }], ...PERSON_TOOL_DEFS.map((t) => [t.name, { destructive: false }] as const)]);

export async function startAdminWorld(): Promise<AdminWorld> {
  const saved: Record<string, string | undefined> = {};
  const fake = await startFakeProviders();
  for (const [k, v] of Object.entries(fake.env())) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const w = await createRepoWorld();
  const sysPool = createSystemPool(w.server.db.systemUrl, 2);
  const deps: OAuthDeps = {
    db: { system: (fn, options) => withSystem((tx) => fn(tx as unknown as PluginTx), { pool: sysPool, ...(options?.workspaceId ? { workspaceId: options.workspaceId as never } : {}) }) },
    secrets: createSecretService(),
    now: () => new Date(),
    env: process.env,
  };
  const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: WS });
  const asPlugin = <T>(fn: (tx: PluginTx) => Promise<T>): Promise<T> => sys((tx) => fn(tx as unknown as PluginTx));
  const devHeader = (who: Who): Record<string, string> => ({ 'x-manythreads-dev-actor': JSON.stringify({ kind: who.kind ?? 'person', id: who.actorId, workspaceId: who.workspaceId }) });
  const raw: AdminWorld['raw'] = (who, method, path, body) =>
    fetch(`${w.server.url}${path}`, { method, redirect: 'manual', headers: { ...devHeader(who), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

  const connect: AdminWorld['connect'] = async (who, provider, services) => {
    fake.signInAs(who.email);
    const start = await raw(who, 'POST', `/api/me/connections/${provider}/start`, services ? { services } : {});
    expect(start.status, await start.clone().text()).toBe(200);
    const url = StartPersonConnectionResponse.parse(await start.json()).url;
    const consent = await fetch(url, { redirect: 'manual' });
    expect(consent.status).toBe(302);
    const back = new URL(consent.headers.get('location')!);
    const arrived = await raw(who, 'GET', `${back.pathname}${back.search}`);
    expect(arrived.status, await arrived.clone().text()).toBe(302);
    expect(arrived.headers.get('location')).toContain(`connected=${provider}`);
  };

  const connectionOf: AdminWorld['connectionOf'] = (who, provider) =>
    sys(async (tx) =>
      (await tx.query<{ id: string; status: string; state: string }>(`SELECT c.id, c.status, o.state FROM app.connections c JOIN app.connection_oauth o ON o.connection_id = c.id WHERE c.owner_id = $1 AND c.slug = $2`, [who.actorId, provider]))
        .rows[0],
    );

  const makeBot: AdminWorld['makeBot'] = (team, slug, connections = []) =>
    sys(async (tx) => {
      const botId = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status, connections)
           VALUES ($1, $2, $3, 'agent', 'rules', 'team', repeat('e', 64), 'active', $4::jsonb) RETURNING id`,
          [WS, team, slug, JSON.stringify(connections)],
        )
      ).rows[0]!.id;
      const actorId = (await tx.query<{ id: string }>(`INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id`, [WS, botId])).rows[0]!.id;
      await tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [team, actorId, WS]);
      return { botId, actorId };
    });
  const compile: AdminWorld['compile'] = (team, botId) => asPlugin((tx) => compileBot(tx, declared, { workspaceId: WS, teamId: team, botId }));

  const openRun: AdminWorld['openRun'] = async (botId, team, askerActorId) => {
    const appPool = createAppPool(w.server.db.appUrl);
    const pool = createSystemPool(w.server.db.systemUrl, 2);
    try {
      const registry = new CapabilityRegistry();
      const broker = new CapabilityBroker({ registry, grants: createDbGrantSource({ pool }) });
      const service = createRunService({ pool: appPool, systemPool: pool, registry, broker, handlers: new Map() });
      const { run, token } = await service.open({ botId, teamId: team, workspaceId: WS, trigger: askerActorId === null ? 'webhook' : 'conversation', ...(askerActorId === null ? {} : { askerActorId }) });
      return McpRunMintResponse.parse({ runId: run.runId, botId: run.botId, url: `${w.server.url}/api/mcp/runs/${run.runId}`, token, expiresAt: run.expiresAt });
    } finally {
      await appPool.end();
      await pool.end();
    }
  };
  const answers: string[] = [];
  const called: AdminWorld['called'] = async (run, name, args = {}) => {
    const res = await fetch(`${w.server.url}/api/mcp/runs/${run.runId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${run.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = (await res.json()) as { result?: { content?: Array<{ text: string }> } };
    const text = body.result!.content![0]!.text;
    answers.push(text);
    return JSON.parse(text) as Record<string, unknown>;
  };

  const until: AdminWorld['until'] = async (fn, ms, what) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  return {
    w,
    fake,
    sysPool,
    deps,
    sys,
    asPlugin,
    raw,
    connect,
    connectionOf,
    makeBot,
    compile,
    openRun,
    called,
    answers,
    until,
    async close() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await sysPool.end();
      await w.close();
      await fake.stop();
    },
  };
}
