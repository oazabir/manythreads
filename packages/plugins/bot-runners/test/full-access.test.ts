/* eslint-disable @typescript-eslint/no-explicit-any -- these tests read JSON documents of many shapes */
import { startFakeK8s, TEAM_IDS, type FakeK8s } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, personas, type World } from './world.ts';

// P26-06: Codex full access (docs/plans/agents-anywhere.md §4) over HTTP on a real server and database: the column, the admin-only switch, Codex only. Many teams may share a full-access runner (P26-21): full access applies per team pod.

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
  w = await createWorld();
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

  it('a Claude Code runner never has full access: it is false and asking for it is refused', async () => {
    const claude = await make('fa-claude', 'claude_cli', { teams: { teams: [TEAM_IDS.Engineering] } });
    expect(claude.body.runner.fullAccess).toBe(false);
    expect((await make('fa-claude2', 'claude_cli', { fullAccess: true })).status).toBe(400);
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

  it('is refused for a Claude Code runner and for anyone who is not an admin', async () => {
    const claude = (await make('fa-cl-sw', 'claude_cli', { teams: { teams: [TEAM_IDS.Engineering] } })).body.runner.id as string;
    const refused = await patch(claude, { fullAccess: true });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('Codex');
    const codex = (await make('fa-adm', 'codex_cli', { teams: { all: true } })).body.runner.id as string;
    expect((await patch(codex, { fullAccess: true }, rafi)).status).toBe(403);
  });

  it('the database itself refuses full access on anything but a Codex runner', async () => {
    const claude = (await make('fa-db', 'claude_cli')).body.runner.id as string;
    await expect(w.system((tx) => tx.query('UPDATE app.bot_runners SET full_access = true WHERE id = $1::uuid', [claude]))).rejects.toThrow(/bot_runners_full_access_codex/);
  });
});
