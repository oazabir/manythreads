/* eslint-disable @typescript-eslint/no-explicit-any -- these tests read JSON documents of many shapes */
import { startFakeK8s, type FakeK8s } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CANARY, CODEX_CANARY, fakeCodexCredentials, fakeCredentials } from './fixtures/credentials.ts';
import { createWorld, personas, type Persona, type World } from './world.ts';

// The Codex sign-in upload's refusals (P19-13) over HTTP (its own file and server: the upload route allows 20 tries a person a minute) on a real server and database, with a local double of the Kubernetes API for the Secret. Modelled on claude-signin-api.test.ts.

const { omar } = personas;
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let w: World;
let k8s: FakeK8s;
const saved: Record<string, string | undefined> = {};
const ENV = ['MANYTHREADS_CLAUDE_PODS_TEST_K8S_URL'];
const logs: string[] = [];

const ACK = { 'x-terms-ack': '1', 'x-signins-ack': '1' };
const put = async (who: Persona, id: string, text: string | Buffer, headers: Record<string, string> = ACK): Promise<{ status: number; text: string; body: any }> => {
  const res = await fetch(`${w.server.url}/api/admin/bot-runners/${id}/credentials`, {
    method: 'PUT',
    headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId }), 'content-type': 'application/json', ...headers },
    body: text,
  });
  const t = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(t);
  } catch {
    /* not JSON */
  }
  return { status: res.status, text: t, body };
};
const create = async (name: string, kind = 'codex_cli'): Promise<string> => (await w.call<any>(omar, 'POST', '/api/admin/bot-runners', { name, label: name, kind, teams: { all: true } })).body.runner.id;
const secretOf = (name: string, agent = 'codex') => k8s.secrets.get(`manythreads-bots/${agent}-${name}-credentials`);

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  k8s = await startFakeK8s();
  process.env['MANYTHREADS_CLAUDE_PODS_TEST_K8S_URL'] = k8s.url;
  for (const m of ['log', 'warn', 'error', 'info'] as const) {
    const orig = console[m].bind(console);
    console[m] = (...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
      orig(...a);
    };
  }
  w = await createWorld();
}, 120_000);

afterAll(async () => {
  await w?.close();
  await k8s?.stop();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('refusing a Codex sign-in file', () => {
  it('refuses a file with OPENAI_API_KEY set whole: a plain sentence, no echo, no Secret, no row change', async () => {
    const id = await create('cx-key');
    for (const key of [`sk-live-${CODEX_CANARY}`, '', 0, false, {}]) {
      const res = await put(omar, id, fakeCodexCredentials('k', { apiKey: key }));
      expect(res.status, String(key)).toBe(400);
      expect(res.body.error.message).toContain('API key');
      expect(res.text).not.toContain(CODEX_CANARY);
      expect(res.text).not.toContain('sk-live');
    }
    expect(secretOf('cx-key')).toBeUndefined();
    const row = (await w.system((tx) => tx.query<any>('SELECT credentials_sha256, login_id, status FROM app.bot_runners WHERE id = $1::uuid', [id]))).rows[0];
    expect(row).toMatchObject({ credentials_sha256: null, login_id: null, status: 'waiting_for_sign_in' });
  });

  it('refuses what is not a ChatGPT login file, and a Claude file, and a file that is too large', async () => {
    const id = await create('cx-bad');
    for (const bad of [
      'not json {',
      '[]',
      fakeCodexCredentials('b', { authMode: 'apikey' }),
      fakeCodexCredentials('b', { tokens: { refresh_token: '' } }),
      fakeCredentials('b'),
      `{"__proto__":{"x":1},"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"id_token":"a","access_token":"b","refresh_token":"${CODEX_CANARY}"}}`,
    ]) {
      const res = await put(omar, id, bad);
      expect(res.status, bad.slice(0, 30)).toBe(400);
      expect(res.text).not.toContain(CODEX_CANARY);
      expect(res.text).not.toContain(CANARY);
    }
    expect((await put(omar, id, Buffer.alloc(300 * 1024, 'a'))).status).toBe(413);
    expect(secretOf('cx-bad')).toBeUndefined();
  });

  it('needs both boxes ticked', async () => {
    const id = await create('cx-ack');
    expect((await put(omar, id, fakeCodexCredentials('d'), {})).status).toBe(400);
    expect((await put(omar, id, fakeCodexCredentials('d'), { 'x-terms-ack': '1' })).status).toBe(400);
    expect((await put(omar, id, fakeCodexCredentials('d'), { 'x-signins-ack': '1' })).status).toBe(400);
    expect(secretOf('cx-ack')).toBeUndefined();
  });

  it('a Claude runner cannot take a Codex file and the other way round', async () => {
    const claude = await create('cx-wrong-1', 'claude_cli');
    const codex = await create('cx-wrong-2');
    expect((await put(omar, claude, fakeCodexCredentials('w'))).status).toBe(400);
    expect((await put(omar, codex, fakeCredentials('w'))).status).toBe(400);
  });
});
