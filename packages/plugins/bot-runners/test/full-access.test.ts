/* eslint-disable @typescript-eslint/no-explicit-any -- these tests read JSON documents of many shapes */
import { startFakeK8s, TEAM_IDS, type FakeK8s } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, personas, type World } from './world.ts';

// P26-06, P35-01: full access for Claude Code and Codex (docs/plans/full-access-default.md) over HTTP on a real server and database: the column, the admin-only switch, the kinds that have
// it, and the one-off data step that switched the existing runners on. Many teams may share a full-access runner (P26-21): full access applies per team pod.

const { omar, rafi } = personas;
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let w: World;
let k8s: FakeK8s;
let savedUrl: string | undefined;

const make = async (name: string, kind: string, extra: Record<string, unknown> = {}) => w.call<any>(omar, 'POST', '/api/admin/bot-runners', { name, label: name, kind, ...extra });
const patch = (id: string, body: Record<string, unknown>, who = omar) => w.call<any>(who, 'PATCH', `/api/admin/bot-runners/${id}`, body);
const teamsOf = (id: string, body: unknown) => w.call<any>(omar, 'PUT', `/api/admin/bot-runners/${id}/teams`, body);
const column = async (id: string): Promise<boolean> => (await w.system((tx) => tx.query<{ full_access: boolean }>('SELECT full_access FROM app.bot_runners WHERE id = $1::uuid', [id]))).rows[0]!.full_access;

beforeAll(async () => {
  savedUrl = process.env['MANYTHREADS_CLAUDE_PODS_TEST_K8S_URL'];
  k8s = await startFakeK8s();
  process.env['MANYTHREADS_CLAUDE_PODS_TEST_K8S_URL'] = k8s.url;
  // the job workers poll often: the data step is run through the real queue below
  w = await createWorld({ jobPollMs: 100 });
}, 120_000);
afterAll(async () => {
  await w?.close();
  await k8s?.stop();
  if (savedUrl === undefined) delete process.env['MANYTHREADS_CLAUDE_PODS_TEST_K8S_URL'];
  else process.env['MANYTHREADS_CLAUDE_PODS_TEST_K8S_URL'] = savedUrl;
});

describe('a new runner', () => {
  it('a Codex pod runner starts with full access on, for one team, for several, for every team, or for none yet', async () => {
    const one = await make('fa-one', 'codex_cli', { teams: { teams: [TEAM_IDS.Engineering] } });
    expect(one.status, JSON.stringify(one.body)).toBe(201);
    expect(one.body.runner.fullAccess).toBe(true);
    const none = await make('fa-none', 'codex_cli');
    expect(none.body.runner.fullAccess).toBe(true);
    expect(await column(none.body.runner.id)).toBe(true);
    expect((await make('fa-all', 'codex_cli', { teams: { all: true } })).body.runner.fullAccess).toBe(true);
    expect((await make('fa-two', 'codex_cli', { teams: { teams: [TEAM_IDS.Engineering, TEAM_IDS.Marketing] } })).body.runner.fullAccess).toBe(true);
  });

  it('is off when the request says so, and on when it asks for it with several teams (no one-team rule: each team has its own pod)', async () => {
    expect((await make('fa-off', 'codex_cli', { teams: { all: true }, fullAccess: false })).body.runner.fullAccess).toBe(false);
    const asked = await make('fa-asked', 'codex_cli', { teams: { all: true }, fullAccess: true });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body.runner.fullAccess).toBe(true);
  });

  it('a Claude Code pod runner starts with full access on too (P35-01), and is off when the request says so', async () => {
    const claude = await make('fa-claude', 'claude_cli', { teams: { teams: [TEAM_IDS.Engineering] } });
    expect(claude.status, JSON.stringify(claude.body)).toBe(201);
    expect(claude.body.runner.fullAccess).toBe(true);
    expect(await column(claude.body.runner.id)).toBe(true);
    expect((await make('fa-claude2', 'claude_cli', { fullAccess: false })).body.runner.fullAccess).toBe(false);
  });

  it('Hermes and the LLM gateway never have it: asking is refused, and left out it is off', async () => {
    expect((await make('fa-hpod', 'hermes_pod', { fullAccess: true })).status).toBe(400);
    const pod = await make('fa-hpod2', 'hermes_pod');
    expect(pod.status, JSON.stringify(pod.body)).toBe(201);
    expect(pod.body.runner.fullAccess).toBe(false);
  });

  it('a server runner is not made here', async () => {
    expect((await make('fa-server', 'server_agent')).status).toBe(400);
  });
});

describe('the switch', () => {
  it('turns on for any number of teams, off at any time, and says what changed', async () => {
    const id = (await make('fa-sw', 'codex_cli', { teams: { all: true }, fullAccess: false })).body.runner.id as string;
    expect(await column(id)).toBe(false);
    const on = await patch(id, { fullAccess: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.runner.fullAccess).toBe(true);
    expect(await column(id)).toBe(true);
    // the same value again is "nothing to change"
    expect((await patch(id, { fullAccess: true })).status).toBe(400);
    const off = await patch(id, { fullAccess: false });
    expect(off.body.runner.fullAccess).toBe(false);
  });

  it('keeps full access when the team list changes: a second team or "every team" is allowed', async () => {
    const id = (await make('fa-keep', 'codex_cli', { teams: { teams: [TEAM_IDS.Engineering] } })).body.runner.id as string;
    expect((await teamsOf(id, { teams: [TEAM_IDS.Engineering, TEAM_IDS.Marketing] })).status).toBe(200);
    expect((await teamsOf(id, { all: true })).status).toBe(200);
    expect((await teamsOf(id, { teams: [TEAM_IDS.Marketing] })).status).toBe(200);
    expect(await column(id)).toBe(true);
  });

  it('turns off and on for a Claude Code runner; is refused for a Hermes runner and for anyone who is not an admin', async () => {
    const claude = (await make('fa-cl-sw', 'claude_cli', { teams: { teams: [TEAM_IDS.Engineering] } })).body.runner.id as string;
    expect((await patch(claude, { fullAccess: false })).body.runner.fullAccess).toBe(false);
    expect((await patch(claude, { fullAccess: true })).body.runner.fullAccess).toBe(true);
    const hermes = (await make('fa-h-sw', 'hermes_pod')).body.runner.id as string;
    const refused = await patch(hermes, { fullAccess: true });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toBe('Full access belongs to a Claude Code or Codex runner only.');
    const codex = (await make('fa-adm', 'codex_cli', { teams: { all: true }, fullAccess: false })).body.runner.id as string;
    expect((await patch(codex, { fullAccess: true }, rafi)).status).toBe(403);
  });

  it('the database itself refuses full access on anything but a Claude Code or Codex runner (bot-runners 0010)', async () => {
    const claude = (await make('fa-db', 'claude_cli', { fullAccess: false })).body.runner.id as string;
    await w.system((tx) => tx.query('UPDATE app.bot_runners SET full_access = true WHERE id = $1::uuid', [claude]));
    expect(await column(claude)).toBe(true);
    const hermes = (await make('fa-db-h', 'hermes_pod')).body.runner.id as string;
    await expect(w.system((tx) => tx.query('UPDATE app.bot_runners SET full_access = true WHERE id = $1::uuid', [hermes]))).rejects.toThrow(/bot_runners_full_access_agent/);
    // the column's default stays false: a row inserted without naming it (adoption, an old server) has it off
    const bare = await w.system((tx) =>
      tx.query<{ full_access: boolean }>(
        "INSERT INTO app.bot_runners (workspace_id, name, label, kind, status) VALUES ($1::uuid, 'fa-db-bare', 'bare', 'claude_cli', 'not_set_up') RETURNING full_access",
        [omar.workspaceId],
      ),
    );
    expect(bare.rows[0]!.full_access).toBe(false);
  });
});

describe('the one-off data step (P35-01): the runners that existed before the default are switched on once, each with an audited event', () => {
  const QUEUE = 'bot-runners.data-steps';
  const STEP = 'full-access-default-2026-11-20';
  const NIL = '00000000-0000-0000-0000-000000000000';
  const idle = async (): Promise<boolean> =>
    (await w.system((tx) => tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.jobs WHERE queue = $1 AND state IN ('ready', 'running')", [QUEUE]))).rows[0]!.n === 0;
  const marked = async (): Promise<boolean> => (await w.system((tx) => tx.query('SELECT 1 FROM app.bot_runner_data_steps WHERE step = $1', [STEP]))).rows.length === 1;
  const enqueue = () => w.system((tx) => tx.query('SELECT app.enqueue_job($1, $2::jsonb, NULL, NULL)', [QUEUE, '{}']));
  const updates = async (runnerId: string): Promise<any[]> =>
    (await w.system((tx) => tx.query<{ actor_id: string; payload: any }>("SELECT actor_id, payload FROM app.events WHERE type = 'bot_runner.runner.updated' AND payload->>'runnerId' = $1 ORDER BY id", [runnerId]))).rows;

  it('switches on Claude Code and Codex pod runners and server runners of those agents, leaves Hermes off, writes one event per runner as the system, and never runs again', async () => {
    // rows as they were before P35-01: off, written without the route (the route now turns a new one on)
    const off = async (name: string, kind: string, agent = 'hermes', serverId: string | null = null): Promise<string> =>
      (
        await w.system((tx) =>
          tx.query<{ id: string }>(
            "INSERT INTO app.bot_runners (workspace_id, name, label, kind, agent, server_id, status, full_access) VALUES ($1::uuid, $2, $2, $3, $4, $5::uuid, 'not_set_up', false) RETURNING id",
            [omar.workspaceId, name, kind, agent, serverId],
          ),
        )
      ).rows[0]!.id;
    const server = (
      await w.system((tx) => tx.query<{ id: string }>("INSERT INTO app.bot_servers (workspace_id, name, label) VALUES ($1::uuid, 'ds-box', 'DS box') RETURNING id", [omar.workspaceId]))
    ).rows[0]!.id;
    const claude = await off('ds-claude', 'claude_cli');
    const codex = await off('ds-codex', 'codex_cli');
    const srvClaude = await off('ds-box-claude', 'server_agent', 'claude-code', server);
    const srvCodex = await off('ds-box-codex', 'server_agent', 'codex', server);
    const srvHermes = await off('ds-box-hermes', 'server_agent', 'hermes-acp', server);
    const hermesPod = await off('ds-hpod', 'hermes_pod');

    // the cron's first slot may already have run on the empty database: let it finish, then take its marker away so the step runs on these rows
    await vi.waitFor(async () => expect(await idle()).toBe(true), { timeout: 30_000, interval: 100 });
    await w.system((tx) => tx.query('DELETE FROM app.bot_runner_data_steps WHERE step = $1', [STEP]));
    await enqueue();
    await vi.waitFor(async () => expect(await marked()).toBe(true), { timeout: 30_000, interval: 100 });
    await vi.waitFor(async () => expect(await idle()).toBe(true), { timeout: 30_000, interval: 100 });

    for (const id of [claude, codex, srvClaude, srvCodex]) {
      expect(await column(id), id).toBe(true);
      const events = await updates(id);
      expect(events).toHaveLength(1);
      expect(events[0]!.actor_id).toBe(NIL);
      expect(events[0]!.payload).toMatchObject({ runnerId: id, changed: ['full_access'], actorId: NIL });
    }
    for (const id of [srvHermes, hermesPod]) {
      expect(await column(id), id).toBe(false);
      expect(await updates(id)).toHaveLength(0);
    }

    // an admin turns one off afterwards; the step's marker is there, so the next slot changes nothing
    expect((await patch(claude, { fullAccess: false })).status).toBe(200);
    await enqueue();
    await vi.waitFor(async () => expect(await idle()).toBe(true), { timeout: 30_000, interval: 100 });
    expect(await column(claude)).toBe(false);
    expect(await updates(codex)).toHaveLength(1);
  });
});
