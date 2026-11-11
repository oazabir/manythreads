/* eslint-disable @typescript-eslint/no-explicit-any -- these tests read JSON documents of many shapes */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../../../tools/agent-bridge/src/config.ts';
import { startBridge, type Bridge } from '../../../../tools/agent-bridge/src/server.ts';
import { createWorld, personas, type World } from './world.ts';

// P19-14: a Hermes gateway runner can say what answers at its address: Hermes (the default), or the agent bridge running Claude Code or Codex. Only an admin sets
// it, only a gateway runner has it, a change needs a new Test, the Test asks the bridge's health (not a Hermes profile), and a team never sees it.

const { omar, nadia, tariq } = personas;
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const BRIDGE_KEY = 'host-bridge-key-0123456789abcdef';
const savedAllowed = process.env['MANYTHREADS_HERMES_ALLOWED_HOSTS'];
let w: World;
let bridge: Bridge;
let dir: string;
let notBridge: Server;
let notBridgeUrl: string;

const adminCreate = (body: Record<string, unknown>) => w.call<{ runner: any }>(omar, 'POST', '/api/admin/bot-runners', body);

beforeAll(async () => {
  process.env['MANYTHREADS_HERMES_ALLOWED_HOSTS'] = '127.0.0.1';
  dir = mkdtempSync(join(tmpdir(), 'bridge-agent-'));
  // A bridge with no `default` profile, as the host's bridge is configured: the Test must not depend on one.
  const config = parseConfig({ profiles: { engineer: { agent: 'claude-code', workdir: join(dir, 'work') } } });
  bridge = await startBridge({ config, apiKey: BRIDGE_KEY, stateDir: join(dir, 'state'), port: 0, log: () => undefined, tmpRoot: dir });
  // Something that answers 200 on every path but is not a bridge.
  notBridge = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>hello</html>');
  });
  await new Promise<void>((resolve) => notBridge.listen(0, '127.0.0.1', resolve));
  notBridgeUrl = `http://127.0.0.1:${(notBridge.address() as AddressInfo).port}`;
  w = await createWorld();
}, 120_000);

afterAll(async () => {
  await w?.close();
  await bridge?.close();
  await new Promise<void>((resolve) => (notBridge ? notBridge.close(() => resolve()) : resolve()));
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (savedAllowed === undefined) delete process.env['MANYTHREADS_HERMES_ALLOWED_HOSTS'];
  else process.env['MANYTHREADS_HERMES_ALLOWED_HOSTS'] = savedAllowed;
});

describe('the agent of a gateway runner', () => {
  let id = '';

  it('is Hermes unless an admin says otherwise, and is shown to the admin only', async () => {
    const plain = await adminCreate({ name: 'plain', label: 'Plain Hermes', kind: 'hermes_gateway', baseUrl: bridge.url, apiKey: BRIDGE_KEY });
    expect(plain.status, JSON.stringify(plain.body)).toBe(201);
    expect(plain.body.runner.agent).toBe('hermes');
    const made = await adminCreate({ name: 'host-claude', label: 'Claude Code on the host', kind: 'hermes_gateway', baseUrl: bridge.url, apiKey: BRIDGE_KEY, agent: 'claude-code', teams: { all: true } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.runner).toMatchObject({ kind: 'hermes_gateway', agent: 'claude-code', status: 'not_set_up', hasKey: true });
    id = made.body.runner.id;
    const row = await w.system(async (tx) => (await tx.query<{ agent: string }>('SELECT agent FROM app.bot_runners WHERE id = $1', [id])).rows[0]);
    expect(row?.agent).toBe('claude-code');
    const listed = await w.call<{ items: any[] }>(omar, 'GET', '/api/admin/bot-runners');
    expect(listed.body.items.map((r) => [r.name, r.agent]).sort()).toEqual([['host-claude', 'claude-code'], ['plain', 'hermes']]);
  });

  it('is refused for a word that is no agent and for every kind that is not a gateway', async () => {
    expect((await adminCreate({ name: 'gemini', label: 'x', kind: 'hermes_gateway', baseUrl: bridge.url, apiKey: BRIDGE_KEY, agent: 'gemini' })).status).toBe(400);
    const pod = await adminCreate({ name: 'pod-agent', label: 'x', kind: 'hermes_pod', agent: 'codex' });
    expect(pod.status).toBe(400);
    expect(JSON.stringify(pod.body)).toContain('Hermes gateway runner only');
    expect((await adminCreate({ name: 'llm-agent', label: 'x', kind: 'llm_gateway', modelAlias: 'smart', agent: 'claude-code' })).status).toBe(400);
    const pod2 = await adminCreate({ name: 'pod-two', label: 'x', kind: 'hermes_pod' });
    expect((await w.call(omar, 'PATCH', `/api/admin/bot-runners/${pod2.body.runner.id}`, { agent: 'codex' })).status).toBe(400);
    await w.call(omar, 'DELETE', `/api/admin/bot-runners/${pod2.body.runner.id}`);
  });

  it('is tested by asking the bridge whether it is up: the key is checked, no default profile is needed, and a thing that is not a bridge is told apart', async () => {
    const ok = await w.call<any>(omar, 'POST', `/api/admin/bot-runners/${id}/test`, {});
    expect(ok.body, JSON.stringify(ok.body)).toMatchObject({ ok: true, error: null, status: 'ready' });
    // a profile typed for a Hermes test is not used for the bridge
    expect((await w.call<any>(omar, 'POST', `/api/admin/bot-runners/${id}/test`, { profile: 'nobody' })).body).toMatchObject({ ok: true });

    // the same address as a Hermes gateway has no default profile to list, so that test fails: the agent decides what is asked
    const hermes = await w.call<any>(omar, 'POST', `/api/admin/bot-runners/${(await w.call<any>(omar, 'GET', '/api/admin/bot-runners')).body.items.find((r: any) => r.name === 'plain').id}/test`, {});
    expect(hermes.body.ok).toBe(false);

    const wrongKey = await w.call<{ runner: any }>(omar, 'PATCH', `/api/admin/bot-runners/${id}`, { apiKey: 'a-key-the-bridge-does-not-know' });
    expect(wrongKey.status).toBe(200);
    const refused = await w.call<any>(omar, 'POST', `/api/admin/bot-runners/${id}/test`, {});
    expect(refused.body).toMatchObject({ ok: false, status: 'not_set_up' });
    expect(refused.body.error).toContain('The bridge refused the key');
    expect(JSON.stringify(refused.body)).not.toContain('a-key-the-bridge-does-not-know');

    await w.call(omar, 'PATCH', `/api/admin/bot-runners/${id}`, { apiKey: BRIDGE_KEY, baseUrl: notBridgeUrl });
    const wrongThing = await w.call<any>(omar, 'POST', `/api/admin/bot-runners/${id}/test`, {});
    expect(wrongThing.body).toMatchObject({ ok: false, error: 'The address did not answer as an agent bridge.' });
    expect(JSON.stringify(wrongThing.body)).not.toContain('hello');

    await w.call(omar, 'PATCH', `/api/admin/bot-runners/${id}`, { baseUrl: bridge.url });
    expect((await w.call<any>(omar, 'POST', `/api/admin/bot-runners/${id}/test`, {})).body).toMatchObject({ ok: true, status: 'ready' });
  });

  it('can be changed, and then the runner must be tested again; the event names the setting and not its value', async () => {
    expect((await w.call(omar, 'PATCH', `/api/admin/bot-runners/${id}`, { agent: 'claude-code' })).status).toBe(400); // nothing changes
    const changed = await w.call<{ runner: any }>(omar, 'PATCH', `/api/admin/bot-runners/${id}`, { agent: 'codex' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.runner).toMatchObject({ agent: 'codex', status: 'not_set_up' });
    const events = await w.system(async (tx) => (await tx.query<{ payload: any }>(`SELECT payload FROM app.events WHERE type = 'bot_runner.runner.updated' ORDER BY id`)).rows);
    expect(events.some((e) => e.payload.changed.includes('agent'))).toBe(true);
    expect(JSON.stringify(events)).not.toContain('codex');
    expect((await w.call<any>(omar, 'POST', `/api/admin/bot-runners/${id}/test`, {})).body).toMatchObject({ ok: true, status: 'ready' });
    // back to Hermes
    expect((await w.call<{ runner: any }>(omar, 'PATCH', `/api/admin/bot-runners/${id}`, { agent: 'hermes' })).body.runner).toMatchObject({ agent: 'hermes', status: 'not_set_up' });
  });

  it('is not for a team lead or a member to set, and a team never reads it: the short list keeps its eight fields', async () => {
    for (const who of [tariq, nadia]) {
      expect((await w.call(who, 'POST', '/api/admin/bot-runners', { name: 'sneaky', label: 'x', kind: 'hermes_gateway', baseUrl: bridge.url, apiKey: BRIDGE_KEY, agent: 'claude-code' })).status, who.name).toBe(403);
      expect((await w.call(who, 'PATCH', `/api/admin/bot-runners/${id}`, { agent: 'claude-code' })).status, who.name).toBe(403);
    }
    expect(await w.system(async (tx) => (await tx.query<{ agent: string }>('SELECT agent FROM app.bot_runners WHERE id = $1', [id])).rows[0]?.agent)).toBe('hermes');
    await w.call(omar, 'PATCH', `/api/admin/bot-runners/${id}`, { agent: 'claude-code' });
    const view = await w.call<{ items: any[] }>(tariq, 'GET', '/api/teams/marketing/bot-runners');
    expect(view.status).toBe(200);
    const mine = view.body.items.find((r) => r.name === 'host-claude');
    expect(mine).toBeDefined();
    expect(Object.keys(mine).sort()).toEqual(['isDefault', 'kind', 'label', 'name', 'ownerName', 'planLabel', 'sharedWith', 'status']);
    const text = JSON.stringify(view.body);
    expect(text).not.toContain('claude-code');
    expect(text).not.toContain(BRIDGE_KEY);
    expect(text).not.toContain(bridge.url);
  });
});
