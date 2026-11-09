/* eslint-disable @typescript-eslint/no-explicit-any -- these tests read JSON documents of many shapes */
import { createHash } from 'node:crypto';
import { startFakeK8s, type FakeK8s } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CODEX_CANARY, fakeCodexCredentials, fakeCredentials } from './fixtures/credentials.ts';
import { createWorld, personas, type Persona, type World } from './world.ts';

// The Codex sign-in upload (P19-13) over HTTP on a real server and database, with a local double of the Kubernetes API for the Secret. Modelled on claude-signin-api.test.ts.

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
const create = async (name: string, kind = 'codex_cli'): Promise<string> => (await w.call<any>(omar, 'POST', '/api/admin/bot-runners', { name, label: name, kind, teams: { all: true } })).body.runner.id;
const secretOf = (name: string, agent = 'codex') => k8s.secrets.get(`manythreads-bots/${agent}-${name}-credentials`);
const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');

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

describe('creating a Codex runner', () => {
  it('starts it waiting for a sign-in, with runs-at-once allowed', async () => {
    const res = await w.call<any>(omar, 'POST', '/api/admin/bot-runners', { name: 'cx-new', label: 'Codex', kind: 'codex_cli', teams: { all: true }, maxConcurrent: 2 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.runner).toMatchObject({ kind: 'codex_cli', status: 'waiting_for_sign_in', maxConcurrent: 2, planLabel: null });
    expect((await w.call<any>(omar, 'GET', '/api/admin/bot-runners')).body.claudePodsAvailable).toBe(true);
  });
});

describe('uploading a Codex sign-in file', () => {
  it('stores the bytes exactly in the Codex Secret and only metadata in the database', async () => {
    const id = await create('cx-a');
    const file = fakeCodexCredentials('a');
    const res = await put(omar, id, file);
    expect(res.status, res.text).toBe(200);
    expect(res.body.replaced).toBe(false);
    expect(res.body.runner).toMatchObject({ kind: 'codex_cli', planLabel: 'ChatGPT plan', status: 'starting', ownerActorId: omar.actorId });
    const secret = secretOf('cx-a')!;
    expect(Object.keys(secret.data!)).toContain('auth.json');
    expect(Object.keys(secret.data!)).not.toContain('.credentials.json');
    const stored = Buffer.from(secret.data!['auth.json']!, 'base64');
    expect(sha(stored)).toBe(sha(file));
    expect(stored.toString('utf8')).toBe(file);
    expect(secretOf('cx-a', 'claude')).toBeUndefined();
    const row = (await w.system((tx) => tx.query<any>('SELECT * FROM app.bot_runners WHERE id = $1::uuid', [id]))).rows[0];
    expect(row.credentials_sha256).toBe(sha(file));
    expect(row.signins_ack_by).toBe(omar.actorId);
    expect(row.terms_accepted_by).toBe(omar.actorId);
    expect(row.credentials_expires_at).toBeNull();
    expect(row.login_id).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(CODEX_CANARY);
    expect(JSON.stringify(row)).not.toContain('acct-a');
  });

  it('stores a file with an extra key unchanged: the SHA-256 of the Secret equals the upload', async () => {
    const id = await create('cx-extra');
    const file = fakeCodexCredentials('x', { extra: { future_login: { token: `t-${CODEX_CANARY}`, nested: [1, 2, { a: 'b' }] }, 'unicode-κλειδί': 'ω' } });
    const res = await put(omar, id, file);
    expect(res.status, res.text).toBe(200);
    const stored = Buffer.from(secretOf('cx-extra')!.data!['auth.json']!, 'base64');
    expect(sha(stored)).toBe(sha(file));
    expect(res.text).not.toContain(CODEX_CANARY);
  });

  it('takes the plan name from the fixed list in the header, and nothing else', async () => {
    const id = await create('cx-plan');
    const res = await put(omar, id, fakeCodexCredentials('p'), { ...ACK, 'x-plan-label': 'ChatGPT Pro plan' });
    expect(res.body.runner.planLabel).toBe('ChatGPT Pro plan');
    const id2 = await create('cx-plan2');
    const odd = await put(omar, id2, fakeCodexCredentials('p2'), { ...ACK, 'x-plan-label': '<script>alert(1)</script>' });
    expect(odd.body.runner.planLabel).toBe('ChatGPT plan');
    expect(odd.text).not.toContain('script');
  });

  it('keeps the canary out of every answer, event, audit row and log line', async () => {
    const id = await create('cx-canary');
    const res = await put(omar, id, fakeCodexCredentials('c'), { ...ACK, 'x-plan-label': 'ChatGPT Plus plan' });
    expect(res.text).not.toContain(CODEX_CANARY);
    await put(omar, id, fakeCodexCredentials('c2'));
    await w.call<any>(omar, 'POST', `/api/admin/bot-runners/${id}/check`);
    await w.call<any>(omar, 'DELETE', `/api/admin/bot-runners/${id}/credentials`);
    const events = await w.system((tx) => tx.query<any>("SELECT payload::text AS p FROM app.events WHERE type LIKE 'codex_pod.%' OR type = 'bot_runner.terms.accepted'"));
    expect(events.rows.length).toBeGreaterThan(0);
    for (const e of events.rows) expect(e.p).not.toContain(CODEX_CANARY);
    const audit = await w.system((tx) => tx.query<any>("SELECT row_to_json(a)::text AS p FROM app.audit_events a WHERE action LIKE 'codex_pod.%'"));
    expect(audit.rows.length).toBeGreaterThan(0);
    for (const a of audit.rows) expect(a.p).not.toContain(CODEX_CANARY);
    // the rows hold neither a token nor the account id
    const all = await w.system((tx) => tx.query<any>('SELECT row_to_json(r)::text AS p FROM app.bot_runners r'));
    for (const r of all.rows) expect(r.p).not.toMatch(/CANARY|acct-/);
    for (const line of logs) expect(line).not.toContain(CODEX_CANARY);
    expect(JSON.stringify((await w.call<any>(omar, 'GET', '/api/admin/bot-runners')).body)).not.toContain(CODEX_CANARY);
  });

  it('refuses the same file for a second Codex runner, the same account in another file, and a non-admin', async () => {
    const one = await create('cx-e1');
    const two = await create('cx-e2');
    const file = fakeCodexCredentials('e');
    expect((await put(omar, one, file)).status).toBe(200);
    const again = await put(omar, two, file);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toContain('every Codex runner needs its own sign-in file');
    expect(again.text).not.toContain('acct-e');
    // the same ChatGPT account with fresh tokens (a second `codex login`) is still the same login
    const relogin = await put(omar, two, fakeCodexCredentials('e', { tokens: { refresh_token: 'rt-another' } }));
    expect(relogin.status).toBe(409);
    // the sentence of the check itself (the unique index behind it would only say "That already exists")
    expect(relogin.body.error.message).toContain('every Codex runner needs its own sign-in file');
    expect(relogin.text).not.toContain('acct-e');
    expect(secretOf('cx-e2')).toBeUndefined();
    // another account is fine
    expect((await put(omar, two, fakeCodexCredentials('e-other'))).status).toBe(200);
    expect((await put(rafi, one, fakeCodexCredentials('e3'))).status).toBe(403);
  });

  it('a runner may replace its own file with a new login of the same account', async () => {
    const id = await create('cx-same');
    expect((await put(omar, id, fakeCodexCredentials('s'))).status).toBe(200);
    const again = await put(omar, id, fakeCodexCredentials('s', { tokens: { refresh_token: 'rt-newer' } }));
    expect(again.status, again.text).toBe(200);
    expect(again.body.replaced).toBe(true);
  });

  it('a Claude file and a Codex file never count as the same login', async () => {
    const claude = await create('cx-claude', 'claude_cli');
    const codex = await create('cx-codex-side');
    expect((await put(omar, claude, fakeCredentials('same'))).status).toBe(200);
    expect((await put(omar, codex, fakeCodexCredentials('same'))).status).toBe(200);
    expect(secretOf('cx-claude', 'claude')).toBeDefined();
    expect(secretOf('cx-claude', 'codex')).toBeUndefined();
  });

  it('replaces and removes, with the Codex events', async () => {
    const id = await create('cx-f');
    await put(omar, id, fakeCodexCredentials('f1'));
    const second = await put(omar, id, fakeCodexCredentials('f2'));
    expect(second.body.replaced).toBe(true);
    const gone = await w.call<any>(omar, 'DELETE', `/api/admin/bot-runners/${id}/credentials`);
    expect(gone.status).toBe(200);
    expect(gone.body.runner).toMatchObject({ status: 'waiting_for_sign_in', planLabel: null, uploadedAt: null });
    expect(secretOf('cx-f')).toBeUndefined();
    const types = (await w.system((tx) => tx.query<any>("SELECT type FROM app.events WHERE payload ->> 'runnerId' = $1 ORDER BY id", [id]))).rows.map((r: any) => r.type);
    expect(types).toEqual(expect.arrayContaining(['codex_pod.credentials.uploaded', 'codex_pod.credentials.replaced', 'codex_pod.credentials.removed']));
    expect(types.filter((t: string) => t.startsWith('claude_pod.'))).toEqual([]);
  });

  it('deleting the runner removes its Codex Secret', async () => {
    const id = await create('cx-h');
    await put(omar, id, fakeCodexCredentials('h'));
    expect(secretOf('cx-h')).toBeDefined();
    expect((await w.call<any>(omar, 'DELETE', `/api/admin/bot-runners/${id}`)).status).toBe(200);
    expect(secretOf('cx-h')).toBeUndefined();
  });

  it('answers the check as unreachable when the pod is not running, in Codex words for a refusal', async () => {
    const id = await create('cx-g');
    await put(omar, id, fakeCodexCredentials('g'));
    const res = await w.call<any>(omar, 'POST', `/api/admin/bot-runners/${id}/check`);
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('unreachable');
    expect(JSON.stringify(res.body)).not.toMatch(/Claude/);
  });

});
