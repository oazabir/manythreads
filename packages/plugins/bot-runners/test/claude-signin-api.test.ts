/* eslint-disable @typescript-eslint/no-explicit-any -- these tests read JSON documents of many shapes */
import { createHash } from 'node:crypto';
import { startFakeK8s, type FakeK8s } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CANARY, fakeCredentials } from './fixtures/credentials.ts';
import { createWorld, personas, type Persona, type World } from './world.ts';

// The Claude sign-in upload (P19-06) over HTTP on a real server and database, with a local double of the Kubernetes API for the Secret.

const { omar, rafi } = personas;
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
const create = async (name: string): Promise<string> => (await w.call<any>(omar, 'POST', '/api/admin/bot-runners', { name, label: name, kind: 'claude_cli', teams: { all: true } })).body.runner.id;
const secretOf = (name: string) => k8s.secrets.get(`manythreads-bots/claude-${name}-credentials`);

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

describe('uploading a sign-in file', () => {
  it('stores the bytes exactly in the Secret and only metadata in the database', async () => {
    const id = await create('sign-a');
    const file = fakeCredentials('a');
    const res = await put(omar, id, file);
    expect(res.status).toBe(200);
    expect(res.body.replaced).toBe(false);
    expect(res.body.runner).toMatchObject({ planLabel: 'Max plan · 20x', status: 'starting', ownerActorId: omar.actorId });
    const stored = Buffer.from(secretOf('sign-a')!.data!['.credentials.json']!, 'base64');
    expect(createHash('sha256').update(stored).digest('hex')).toBe(createHash('sha256').update(file).digest('hex'));
    expect(stored.toString('utf8')).toBe(file);
    const row = (await w.system((tx) => tx.query<any>('SELECT * FROM app.bot_runners WHERE id = $1::uuid', [id]))).rows[0];
    expect(row.credentials_sha256).toBe(createHash('sha256').update(file).digest('hex'));
    expect(row.signins_ack_by).toBe(omar.actorId);
    expect(row.terms_accepted_by).toBe(omar.actorId);
    expect(JSON.stringify(row)).not.toContain(CANARY);
  });

  it('keeps the canary out of every answer, event, audit row and log line', async () => {
    const id = await create('sign-b');
    const res = await put(omar, id, fakeCredentials('b'));
    expect(res.text).not.toContain(CANARY);
    const events = await w.system((tx) => tx.query<any>("SELECT payload::text AS p FROM app.events WHERE type LIKE 'claude_pod.%' OR type = 'bot_runner.terms.accepted'"));
    expect(events.rows.length).toBeGreaterThan(0);
    for (const e of events.rows) expect(e.p).not.toContain(CANARY);
    const audit = await w.system((tx) => tx.query<any>("SELECT row_to_json(a)::text AS p FROM app.audit_events a WHERE action LIKE 'claude_pod.%'"));
    expect(audit.rows.length).toBeGreaterThan(0);
    for (const a of audit.rows) expect(a.p).not.toContain(CANARY);
    for (const line of logs) expect(line).not.toContain(CANARY);
    const list = await w.call<any>(omar, 'GET', '/api/admin/bot-runners');
    expect(JSON.stringify(list.body)).not.toContain(CANARY);
  });

  it('refuses a file whole, with a plain sentence and no echo', async () => {
    const id = await create('sign-c');
    for (const bad of [
      'not json {',
      fakeCredentials('c', { withOauth: false }),
      fakeCredentials('c', { scopes: ['user:profile'] }),
      `{"__proto__":{"x":1},"claudeAiOauth":{"accessToken":"a","refreshToken":"${CANARY}","expiresAt":1,"scopes":["user:inference"]}}`,
    ]) {
      const res = await put(omar, id, bad);
      expect(res.status, bad.slice(0, 20)).toBe(400);
      expect(res.text).not.toContain(CANARY);
    }
    expect((await put(omar, id, Buffer.alloc(300 * 1024, 'a'))).status).toBe(413);
    expect(secretOf('sign-c')).toBeUndefined();
  });

  it('needs both boxes ticked', async () => {
    const id = await create('sign-d');
    expect((await put(omar, id, fakeCredentials('d'), {})).status).toBe(400);
    expect((await put(omar, id, fakeCredentials('d'), { 'x-terms-ack': '1' })).status).toBe(400);
    expect(secretOf('sign-d')).toBeUndefined();
  });

  it('refuses the same file for a second runner, and a non-admin', async () => {
    const one = await create('sign-e1');
    const two = await create('sign-e2');
    const file = fakeCredentials('e');
    expect((await put(omar, one, file)).status).toBe(200);
    const again = await put(omar, two, file);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toContain('every Claude runner needs its own sign-in file');
    expect((await put(rafi, one, fakeCredentials('e2'))).status).toBe(403);
  });

  it('replaces and removes', async () => {
    const id = await create('sign-f');
    await put(omar, id, fakeCredentials('f1'));
    const second = await put(omar, id, fakeCredentials('f2'));
    expect(second.body.replaced).toBe(true);
    const gone = await w.call<any>(omar, 'DELETE', `/api/admin/bot-runners/${id}/credentials`);
    expect(gone.status).toBe(200);
    expect(gone.body.runner).toMatchObject({ status: 'waiting_for_sign_in', planLabel: null, uploadedAt: null });
    expect(secretOf('sign-f')).toBeUndefined();
    const types = (await w.system((tx) => tx.query<any>('SELECT type FROM app.events WHERE payload ->> \'runnerId\' = $1 ORDER BY id', [id]))).rows.map((r: any) => r.type);
    expect(types).toEqual(expect.arrayContaining(['claude_pod.credentials.uploaded', 'claude_pod.credentials.replaced', 'claude_pod.credentials.removed']));
  });

  it('answers the check as unreachable when the pod is not running', async () => {
    const id = await create('sign-g');
    await put(omar, id, fakeCredentials('g'));
    const res = await w.call<any>(omar, 'POST', `/api/admin/bot-runners/${id}/check`);
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('unreachable');
  });
});
