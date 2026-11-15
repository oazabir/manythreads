/* eslint-disable @typescript-eslint/no-explicit-any -- these tests read JSON documents of many shapes */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createWorld, personas, type World } from './world.ts';

// Enrolled servers (P26-12, P26-13): the admin's four routes, the installer's three public ones, the tunnel's socket (who may connect, what a hello does to the runners,
// rotation, removal), and the files the installer downloads. A real server and database; the bridge is a raw WebSocket here (the tunnel's two halves have their own
// test, tunnel.test.ts).

const { omar, nadia } = personas;
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let w: World;
let installDir: string;
const saved = process.env['MANYTHREADS_BRIDGE_INSTALL_DIR'];
const HELLO = { type: 'hello', protocol: 1, bridgeVersion: '1.2.3', host: { hostname: 'box-1', system: 'Ubuntu 24.04', arch: 'x64' }, agents: [{ agent: 'claude-code', version: '2.1.3' }, { agent: 'codex', version: '0.166.0' }], allowFullAccess: false };
const SCRIPT = '#!/usr/bin/env bash\nmain() { echo "site=@@SITE@@ sha=@@BUNDLE_SHA256@@ v=@@BRIDGE_VERSION@@"; }\nmain "$@"\n';

const bundleBytes = Buffer.from('not really a tarball');
const bundleSha = createHash('sha256').update(bundleBytes).digest('hex');

beforeAll(async () => {
  installDir = mkdtempSync(join(tmpdir(), 'install-dist-'));
  mkdirSync(installDir, { recursive: true });
  writeFileSync(join(installDir, 'bridge.sh'), SCRIPT);
  writeFileSync(join(installDir, 'bridge-1.2.3.tgz'), bundleBytes);
  writeFileSync(join(installDir, 'manifest.json'), JSON.stringify({ bridgeVersion: '1.2.3', bundle: 'bridge-1.2.3.tgz', bundleSha256: bundleSha }));
  process.env['MANYTHREADS_BRIDGE_INSTALL_DIR'] = installDir;
  w = await createWorld();
}, 120_000);

afterAll(async () => {
  await w?.close();
  rmSync(installDir, { recursive: true, force: true });
  if (saved === undefined) delete process.env['MANYTHREADS_BRIDGE_INSTALL_DIR'];
  else process.env['MANYTHREADS_BRIDGE_INSTALL_DIR'] = saved;
});

const create = (name: string, label = 'Devbox') => w.call<any>(omar, 'POST', '/api/admin/bot-servers', { name, label });
const list = async () => (await w.call<{ items: any[] }>(omar, 'GET', '/api/admin/bot-servers')).body.items;
const enrol = (code: string, extra: Record<string, unknown> = {}) =>
  w.call<any>(null, 'POST', '/api/bridge/enrol', { code, host: HELLO.host, agents: HELLO.agents, bridgeVersion: '1.2.3', allowFullAccess: false, ...extra });
const runnersOf = async (serverName: string) =>
  w.system(async (tx) => (await tx.query<{ name: string; kind: string; agent: string; status: string; status_detail: string | null; profile_rule: string }>("SELECT name, kind, agent, status, status_detail, profile_rule FROM app.bot_runners WHERE name LIKE $1 ORDER BY name", [`${serverName}-%`])).rows);

/** A raw bridge: opens the socket with a key, and gives the frames it received. */
function bridge(key: string | null): Promise<{ ws: WebSocket; frames: any[]; closed: Promise<{ code: number; reason: string }> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(w.server.url.replace('http', 'ws') + '/api/bridge/connect', { headers: key === null ? {} : { authorization: `Bearer ${key}` } });
    const frames: any[] = [];
    const closed = new Promise<{ code: number; reason: string }>((done) => ws.on('close', (code, reason) => done({ code, reason: reason.toString() })));
    ws.on('message', (m) => frames.push(JSON.parse(m.toString())));
    ws.on('open', () => resolve({ ws, frames, closed }));
    ws.on('error', reject);
  });
}
const until = async (cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
};

describe('the admin routes', () => {
  it('only a workspace admin may list, make a server, mint a code, rotate or remove', async () => {
    expect((await w.call(nadia, 'GET', '/api/admin/bot-servers')).status).toBe(403);
    expect((await w.call(nadia, 'POST', '/api/admin/bot-servers', { name: 'nope', label: 'Nope' })).status).toBe(403);
    expect((await w.call(null, 'GET', '/api/admin/bot-servers')).status).toBe(401);
    const made = await create('guarded');
    expect(made.status).toBe(201);
    const id = made.body.server.id;
    for (const [m, p] of [['POST', `/api/admin/bot-servers/${id}/code`], ['POST', `/api/admin/bot-servers/${id}/rotate-key`], ['DELETE', `/api/admin/bot-servers/${id}`]] as const) {
      expect((await w.call(nadia, m, p)).status, p).toBe(403);
    }
    expect((await w.call(omar, 'DELETE', `/api/admin/bot-servers/${id}`)).status).toBe(200);
  });

  it('a new server comes with one code (mte_…, 15 minutes), shown once; the list never shows a code, key or hash', async () => {
    const made = await create('devbox-a');
    expect(made.body.code).toMatch(/^mte_[0-9a-f]{40}$/);
    const minutes = (Date.parse(made.body.expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
    expect(made.body.server).toMatchObject({ name: 'devbox-a', status: 'waiting', enrolled: false, host: null, agents: [] });
    expect(made.body.install).toMatchObject({ bridgeVersion: '1.2.3' });
    const shown = JSON.stringify(await list());
    expect(shown).not.toContain(made.body.code);
    expect(shown).not.toMatch(/hash|mte_|mtb_/);
    // the table keeps only the hash
    const row = await w.system(async (tx) => (await tx.query<{ enrol_code_hash: string }>("SELECT enrol_code_hash FROM app.bot_servers WHERE name = 'devbox-a'")).rows[0]!);
    expect(row.enrol_code_hash).toBe(createHash('sha256').update(made.body.code).digest('hex'));
  });

  it('refuses a duplicate name, a bad name, and a name whose runners would collide with a runner somebody made', async () => {
    expect((await create('devbox-a')).status).toBe(409);
    expect((await create('Bad Name')).status).toBe(400);
    expect((await w.call(omar, 'POST', '/api/admin/bot-runners', { name: 'taken-claude', label: 'x', kind: 'hermes_gateway', baseUrl: 'http://127.0.0.1:1', apiKey: 'a-key-0123456789' })).status).toBeLessThan(500);
    await w.system((tx) => tx.query("INSERT INTO app.bot_runners (workspace_id, name, label, kind, status) SELECT id, 'taken-claude', 'Taken', 'hermes_pod', 'ready' FROM app.workspaces LIMIT 1")).catch(() => undefined);
    const clash = await create('taken');
    expect(clash.status).toBe(409);
    await w.system((tx) => tx.query("DELETE FROM app.bot_runners WHERE name = 'taken-claude'"));
  });
});

describe('enrolment', () => {
  it('a code works once: the key is returned once, the runners appear (not set up until the server connects), the second use is the same answer as an unknown code', async () => {
    const made = await create('enrol-1');
    const done = await enrol(made.body.code);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.key).toMatch(/^mtb_[0-9a-f]{64}$/);
    expect(done.body).toMatchObject({ name: 'enrol-1' });
    const again = await enrol(made.body.code);
    const unknown = await enrol(`mte_${'0'.repeat(40)}`);
    expect(again.status).toBe(404);
    expect(again.body).toEqual(unknown.body);
    const runners = await runnersOf('enrol-1');
    expect(runners.map((r) => r.name)).toEqual(['enrol-1-claude', 'enrol-1-codex']);
    expect(runners.every((r) => r.kind === 'server_agent' && r.status === 'not_set_up')).toBe(true);
    expect(runners[0]!.profile_rule).toBe('claude--{team}--{bot}');
    const row = (await list()).find((s) => s.name === 'enrol-1');
    expect(row).toMatchObject({ enrolled: true, status: 'offline', codeExpiresAt: null, host: { hostname: 'box-1' }, bridgeVersion: '1.2.3' });
    expect(JSON.stringify(await w.system((tx) => tx.query('SELECT * FROM app.audit_log ORDER BY at DESC LIMIT 20').then((r) => r.rows).catch(() => [])))).not.toContain(done.body.key);
  });

  it('an expired code is refused like an unknown one', async () => {
    const made = await create('enrol-exp');
    await w.system((tx) => tx.query("UPDATE app.bot_servers SET enrol_code_expires_at = now() - interval '1 minute' WHERE name = 'enrol-exp'"));
    expect((await enrol(made.body.code)).status).toBe(404);
    expect((await list()).find((s) => s.name === 'enrol-exp')).toMatchObject({ codeExpiresAt: null, enrolled: false });
    // minting another makes the server usable again
    const fresh = await w.call<any>(omar, 'POST', `/api/admin/bot-servers/${made.body.server.id}/code`);
    expect(fresh.status).toBe(200);
    expect((await enrol(fresh.body.code)).status).toBe(200);
  });

  it('a new code replaces the old one', async () => {
    const made = await create('enrol-2');
    const fresh = await w.call<any>(omar, 'POST', `/api/admin/bot-servers/${made.body.server.id}/code`);
    expect((await enrol(made.body.code)).status).toBe(404);
    expect((await enrol(fresh.body.code)).status).toBe(200);
  });
});

describe('enrolment under pressure', () => {
  it('five bridges redeeming one code at once (the lockout allows ten wrong codes per address, so no more): exactly one gets a key, the rest are told the code is not valid, and one key opens the server', async () => {
    const made = await create('enrol-race');
    const results = await Promise.all(Array.from({ length: 5 }, () => enrol(made.body.code)));
    const won = results.filter((r) => r.status === 200);
    expect(won).toHaveLength(1);
    expect(results.filter((r) => r.status === 404)).toHaveLength(4);
    for (const lost of results.filter((r) => r.status !== 200)) expect(JSON.stringify(lost.body)).not.toMatch(/mtb_/);
    const rows = await w.system((tx) => tx.query<{ n: string }>("SELECT count(*) AS n FROM app.bot_runners WHERE name LIKE 'enrol-race-%'"));
    expect(Number(rows.rows[0]!.n)).toBe(2);
    const b = await bridge(won[0]!.body.key);
    b.ws.send(JSON.stringify(HELLO));
    await until(() => b.frames.some((f) => f.type === 'welcome'));
    b.ws.close();
  });
});

describe('two workspaces with a server of the same name', () => {
  it('each socket is its own server: the site asks only the one the runner belongs to, and one workspace\'s key opens nothing of the other', async () => {
    const made = await create('twin');
    const mine = await enrol(made.body.code);
    const otherWs = await w.system(async (tx) => (await tx.query<{ id: string }>("INSERT INTO app.workspaces (slug, name) VALUES ('twin-ws', 'Twin') RETURNING id")).rows[0]!.id);
    const theirKey = `mtb_${'7'.repeat(64)}`;
    const theirId = await w.system(async (tx) =>
      (await tx.query<{ id: string }>("INSERT INTO app.bot_servers (workspace_id, name, label, key_hash, status) VALUES ($1::uuid, 'twin', 'Twin', $2, 'offline') RETURNING id", [otherWs, createHash('sha256').update(theirKey).digest('hex')])).rows[0]!.id);
    const a = await bridge(mine.body.key);
    const b = await bridge(theirKey);
    a.ws.send(JSON.stringify(HELLO));
    b.ws.send(JSON.stringify({ ...HELLO, agents: [{ agent: 'claude-code', version: '9.9.9' }] }));
    await until(() => a.frames.some((f) => f.type === 'welcome') && b.frames.some((f) => f.type === 'welcome'));
    const welcomeA = a.frames.find((f) => f.type === 'welcome');
    const welcomeB = b.frames.find((f) => f.type === 'welcome');
    expect(welcomeA.name).toBe('twin');
    expect(welcomeB.name).toBe('twin');
    expect(welcomeA.serverId).toBe(made.body.server.id);
    expect(welcomeB.serverId).toBe(theirId);
    expect(welcomeA.serverId).not.toBe(welcomeB.serverId);
    // both are connected at once: neither replaced the other
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
    // each bridge answers a request by saying whose it is
    const answer = (who: string) => (ws: WebSocket) => {
      let seen = 0;
      ws.on('message', (m) => {
        const f = JSON.parse(m.toString());
        if (f.type !== 'request') return;
        seen += 1;
        const body = JSON.stringify({ auth: { agent: 'claude-code', profile: who, home: 'dedicated', state: 'signed_in', kind: 'account', canLogout: true, methods: [], attempt: null, note: null } });
        ws.send(JSON.stringify({ type: 'head', id: f.id, status: 200, headers: { 'content-type': 'application/json' } }));
        ws.send(JSON.stringify({ type: 'data', id: f.id, data: Buffer.from(body).toString('base64') }));
        ws.send(JSON.stringify({ type: 'end', id: f.id }));
      });
      return () => seen;
    };
    const seenA = answer('server-a')(a.ws);
    const seenB = answer('server-b')(b.ws);
    const runner = (await w.call<{ items: any[] }>(omar, 'GET', '/api/admin/bot-runners')).body.items.find((r) => r.name === 'twin-claude');
    expect(runner).toMatchObject({ serverId: made.body.server.id });
    const res = await w.call<any>(omar, 'GET', `/api/admin/bot-runners/${runner.id}/agent-auth`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.auth.profile).toBe('server-a');
    expect(seenA()).toBeGreaterThanOrEqual(1);
    expect(seenB()).toBe(0);
    // the other workspace's key is not the first one's, and its server is not in this workspace's list
    expect((await list()).filter((s) => s.name === 'twin')).toHaveLength(1);
    a.ws.close();
    b.ws.close();
  });
});

describe('the tunnel socket', () => {
  let key: string;
  let serverId: string;

  it('refuses a socket with no key, or a key the site does not know, with 1008', async () => {
    const none = await bridge(null);
    expect((await none.closed).code).toBe(1008);
    const wrong = await bridge(`mtb_${'9'.repeat(64)}`);
    expect((await wrong.closed).code).toBe(1008);
  });

  it('a hello makes the server connected and its runners ready for sign-in; the welcome says how often to beat', async () => {
    const made = await create('tun-1');
    serverId = made.body.server.id;
    key = (await enrol(made.body.code)).body.key;
    const b = await bridge(key);
    b.ws.send(JSON.stringify(HELLO));
    await until(() => b.frames.some((f) => f.type === 'welcome'));
    expect(b.frames.find((f) => f.type === 'welcome')).toMatchObject({ serverId, name: 'tun-1', heartbeatSeconds: 20 });
    const s = (await list()).find((x) => x.id === serverId);
    expect(s).toMatchObject({ status: 'connected', agents: [{ agent: 'claude-code' }, { agent: 'codex' }] });
    await until(async () => (await runnersOf('tun-1')).every((r) => r.status === 'waiting_for_sign_in'));
    b.ws.send(JSON.stringify({ type: 'beat' }));
    await until(() => b.frames.some((f) => f.type === 'beat_ack'));
    expect((await w.call<any>(null, 'GET', '/api/bridge/status')).status).toBe(401);
    const st = await fetch(`${w.server.url}/api/bridge/status`, { headers: { authorization: `Bearer ${key}` } });
    expect(await st.json()).toEqual({ status: 'connected', name: 'tun-1' });
    // a second socket for the same server closes the first
    const second = await bridge(key);
    second.ws.send(JSON.stringify(HELLO));
    await until(() => second.frames.some((f) => f.type === 'welcome'));
    expect((await b.closed).code).toBe(1000);
    // dropping the last one marks the runners not set up again after the short wait
    second.ws.close();
  });

  it('a bridge that leaves is marked offline after a moment, and its runners cannot serve a run', async () => {
    // the row and the runners follow after the short wait that keeps a restart of the bridge out of the trail (15 s)
    await until(async () => (await runnersOf('tun-1')).every((r) => r.status === 'not_set_up'), 25_000);
    expect((await list()).find((x) => x.id === serverId)?.status).toBe('offline');
    const changes = await w.system(async (tx) => (await tx.query<{ change: string }>("SELECT payload->>'change' AS change FROM app.events WHERE type = 'bot_server.server.changed' AND payload->>'name' = 'tun-1' ORDER BY id")).rows.map((r) => r.change));
    expect(changes).toEqual(['code_minted', 'enrolled', 'connected', 'disconnected']);
    // an event says that something happened to which server: no key, no code, no hash
    expect(JSON.stringify(await w.system(async (tx) => (await tx.query("SELECT payload FROM app.events WHERE type = 'bot_server.server.changed'")).rows))).not.toMatch(/mtb_|mte_|hash/);
  });

  it('a frame that is not part of the protocol closes the socket', async () => {
    const b = await bridge(key);
    b.ws.send(JSON.stringify({ type: 'nonsense' }));
    expect((await b.closed).code).toBe(1002);
  });

  it('rotate: a connected server only; the new key goes over the socket; after `rotated` the old key stops opening it', async () => {
    const offline = await w.call<any>(omar, 'POST', `/api/admin/bot-servers/${serverId}/rotate-key`);
    expect(offline.status).toBe(409);
    const b = await bridge(key);
    b.ws.send(JSON.stringify(HELLO));
    await until(() => b.frames.some((f) => f.type === 'welcome'));
    const r = await w.call<any>(omar, 'POST', `/api/admin/bot-servers/${serverId}/rotate-key`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(JSON.stringify(r.body)).not.toMatch(/mtb_/);
    await until(() => b.frames.some((f) => f.type === 'rotate'));
    const next = b.frames.find((f) => f.type === 'rotate').key as string;
    expect(next).toMatch(/^mtb_[0-9a-f]{64}$/);
    expect(next).not.toBe(key);
    b.ws.send(JSON.stringify({ type: 'rotated' }));
    // the old key stops opening it as soon as the site has taken the answer
    await until(async () => (await w.system((tx) => tx.query("SELECT 1 FROM app.bot_servers WHERE id = $1::uuid AND pending_key_hash IS NULL AND pending_key_at IS NULL", [serverId]))).rows.length === 1);
    b.ws.close();
    expect((await (await bridge(key)).closed).code).toBe(1008);
    const c = await bridge(next);
    c.ws.send(JSON.stringify(HELLO));
    await until(() => c.frames.some((f) => f.type === 'welcome'));
    key = next;
    c.ws.close();
  });

  it('a rotation the bridge never answered leaves the old key working, and the new one works too (it wrote the key, then lost the socket)', async () => {
    const b = await bridge(key);
    b.ws.send(JSON.stringify(HELLO));
    await until(() => b.frames.some((f) => f.type === 'welcome'));
    await w.call(omar, 'POST', `/api/admin/bot-servers/${serverId}/rotate-key`);
    await until(() => b.frames.some((f) => f.type === 'rotate'));
    const next = b.frames.find((f) => f.type === 'rotate').key as string;
    b.ws.terminate();
    const old = await bridge(key);
    old.ws.send(JSON.stringify(HELLO));
    await until(() => old.frames.some((f) => f.type === 'welcome'));
    old.ws.close();
    const fresh = await bridge(next);
    fresh.ws.send(JSON.stringify(HELLO));
    await until(() => fresh.frames.some((f) => f.type === 'welcome'));
    key = next;
    fresh.ws.close();
  });

  it('a second rotation while the first waits for the bridge is refused with 409 and changes nothing; one older than 15 minutes is taken as lost', async () => {
    const made = await create('tun-rot');
    const done = await enrol(made.body.code);
    const id = made.body.server.id as string;
    const b = await bridge(done.body.key);
    b.ws.send(JSON.stringify(HELLO));
    await until(() => b.frames.some((f) => f.type === 'welcome'));
    expect((await w.call<any>(omar, 'POST', `/api/admin/bot-servers/${id}/rotate-key`)).status).toBe(200);
    await until(() => b.frames.some((f) => f.type === 'rotate'));
    const first = b.frames.find((f) => f.type === 'rotate').key as string;
    const pendingOf = async () => (await w.system((tx) => tx.query<{ h: string | null }>('SELECT pending_key_hash AS h FROM app.bot_servers WHERE id = $1::uuid', [id]))).rows[0]!.h;
    const hashBefore = await pendingOf();
    const again = await w.call<any>(omar, 'POST', `/api/admin/bot-servers/${id}/rotate-key`);
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).not.toMatch(/mtb_/);
    expect(await pendingOf()).toBe(hashBefore);
    expect(b.frames.filter((f) => f.type === 'rotate')).toHaveLength(1);
    // the first rotation still completes: the key the bridge was sent is the one that opens it
    b.ws.send(JSON.stringify({ type: 'rotated' }));
    await until(async () => (await pendingOf()) === null);
    // the answer arrived: a new rotation is fine again
    expect((await w.call<any>(omar, 'POST', `/api/admin/bot-servers/${id}/rotate-key`)).status).toBe(200);
    await until(() => b.frames.filter((f) => f.type === 'rotate').length === 2);
    // that one is never answered: after 15 minutes the next one replaces it
    expect((await w.call<any>(omar, 'POST', `/api/admin/bot-servers/${id}/rotate-key`)).status).toBe(409);
    await w.system((tx) => tx.query("UPDATE app.bot_servers SET pending_key_at = now() - interval '16 minutes' WHERE id = $1::uuid", [id]));
    expect((await w.call<any>(omar, 'POST', `/api/admin/bot-servers/${id}/rotate-key`)).status).toBe(200);
    const keys = b.frames.filter((f) => f.type === 'rotate').map((f) => f.key as string);
    expect(keys).toHaveLength(3);
    expect(keys[0]).toBe(first);
    expect(new Set(keys).size).toBe(3);
    b.ws.close();
  });

  it('the old key keeps opening the server until the bridge confirms, and a replaced socket does not take the server offline', async () => {
    const made = await create('tun-rep');
    const done = await enrol(made.body.code);
    const id = made.body.server.id as string;
    const first = await bridge(done.body.key);
    first.ws.send(JSON.stringify(HELLO));
    await until(() => first.frames.some((f) => f.type === 'welcome'));
    await w.call(omar, 'POST', `/api/admin/bot-servers/${id}/rotate-key`);
    await until(() => first.frames.some((f) => f.type === 'rotate'));
    // a runner that was ready stays ready when the socket is replaced (a reconnect is not a new sign-in), one that was not set up waits for its sign-in
    await until(async () => (await runnersOf('tun-rep')).every((r) => r.status === 'waiting_for_sign_in'));
    await w.system((tx) => tx.query("UPDATE app.bot_runners SET status = 'ready', status_detail = NULL WHERE name = 'tun-rep-claude'"));
    // not confirmed yet: the old key still opens a socket, and the new socket replaces the first
    const second = await bridge(done.body.key);
    second.ws.send(JSON.stringify(HELLO));
    await until(() => second.frames.some((f) => f.type === 'welcome'));
    expect((await first.closed).code).toBe(1000);
    expect(Object.fromEntries((await runnersOf('tun-rep')).map((r) => [r.name, r.status]))).toEqual({ 'tun-rep-claude': 'ready', 'tun-rep-codex': 'waiting_for_sign_in' });
    // the replaced socket closing last must not mark the server offline while the new one is open
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect((await list()).find((x) => x.id === id)?.status).toBe('connected');
    second.ws.send(JSON.stringify({ type: 'beat' }));
    await until(() => second.frames.some((f) => f.type === 'beat_ack'));
    second.ws.close();
  });

  it('removing the server closes its socket (1008), deletes the runners, and the key stops opening anything', async () => {
    const b = await bridge(key);
    b.ws.send(JSON.stringify(HELLO));
    await until(() => b.frames.some((f) => f.type === 'welcome'));
    expect((await w.call<any>(omar, 'DELETE', `/api/admin/bot-servers/${serverId}`)).body).toEqual({ deleted: true });
    expect((await b.closed).code).toBe(1008);
    expect(await runnersOf('tun-1')).toEqual([]);
    expect((await (await bridge(key)).closed).code).toBe(1008);
    expect((await list()).find((x) => x.id === serverId)).toBeUndefined();
  });
});

describe('the delete guard', () => {
  it('a server with bots placed on its runners cannot be removed from the page, and the installer\'s uninstall leaves it offline', async () => {
    const made = await create('guard-1');
    const done = await enrol(made.body.code);
    await w.system((tx) =>
      tx.query(
        `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status, placement)
         SELECT t.workspace_id, t.id, 'on-server', 'agent', 'hermes', 'team', repeat('a', 64), 'active', '{"runs_on":"guard-1-claude"}'::jsonb FROM app.teams t WHERE t.slug = 'engineering'`,
      ),
    );
    const refused = await w.call<any>(omar, 'DELETE', `/api/admin/bot-servers/${made.body.server.id}`);
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('One bot runs');
    const un = await fetch(`${w.server.url}/api/bridge/uninstall`, { method: 'POST', headers: { authorization: `Bearer ${done.body.key}` } });
    expect(await un.json()).toEqual({ removed: false });
    expect((await list()).find((s) => s.name === 'guard-1')).toBeDefined();
    await w.system((tx) => tx.query("DELETE FROM app.bots WHERE slug = 'on-server'"));
    const un2 = await fetch(`${w.server.url}/api/bridge/uninstall`, { method: 'POST', headers: { authorization: `Bearer ${done.body.key}` } });
    expect(await un2.json()).toEqual({ removed: true });
    expect((await list()).find((s) => s.name === 'guard-1')).toBeUndefined();
  });

  it('a runner of a server cannot be deleted or made the default from the runner routes', async () => {
    const made = await create('guard-2');
    await enrol(made.body.code);
    const runner = (await w.call<{ items: any[] }>(omar, 'GET', '/api/admin/bot-runners')).body.items.find((r) => r.name === 'guard-2-claude');
    expect(runner).toMatchObject({ kind: 'server_agent', serverId: made.body.server.id });
    expect((await w.call(omar, 'DELETE', `/api/admin/bot-runners/${runner.id}`)).status).toBe(409);
    expect((await w.call(omar, 'PUT', `/api/admin/bot-runners/${runner.id}/default`)).status).toBeGreaterThanOrEqual(400);
  });
});

describe('the repository list of a server (P26-15)', () => {
  const reposOf = (key: string | null) => fetch(`${w.server.url}/api/bridge/repos`, { headers: key === null ? {} : { authorization: `Bearer ${key}` } });

  it('lists the projects of the teams on the server\'s runners for the bots placed on them, only plain allowed https addresses, and only with the key', async () => {
    const savedAllow = process.env['MANYTHREADS_CLAUDE_PODS_REPO_ORIGIN_ALLOW'];
    process.env['MANYTHREADS_CLAUDE_PODS_REPO_ORIGIN_ALLOW'] = 'https://github.com/acme';
    try {
      const made = await create('repos-1');
      const done = await enrol(made.body.code);
      const runner = (await w.call<{ items: any[] }>(omar, 'GET', '/api/admin/bot-runners')).body.items.find((r) => r.name === 'repos-1-claude');
      expect(runner).toBeDefined();
      expect(await (await reposOf(done.body.key)).json()).toEqual({ repos: [] });
      await w.system(async (tx) => {
        await tx.query("UPDATE app.bot_runners SET all_teams = false WHERE name = 'repos-1-claude'");
        await tx.query("INSERT INTO app.bot_runner_teams (runner_id, team_id) SELECT $1::uuid, t.id FROM app.teams t WHERE t.slug = 'engineering'", [runner.id]);
        await tx.query(
          `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status, placement)
           SELECT t.workspace_id, t.id, 'repo-bot', 'agent', 'hermes', 'team', repeat('a', 64), 'active', '{"runs_on":"repos-1-claude"}'::jsonb FROM app.teams t WHERE t.slug = 'engineering'`,
        );
        await tx.query(
          `INSERT INTO app.projects (workspace_id, team_id, name, repo_url, default_branch)
           SELECT t.workspace_id, t.id, p.name, p.url, 'main' FROM app.teams t, (VALUES ('site', 'https://github.com/acme/site'), ('elsewhere', 'https://example.org/x/y')) AS p (name, url) WHERE t.slug = 'engineering'`,
        );
      });
      const body = await (await reposOf(done.body.key)).json();
      expect(body).toEqual({ repos: [{ team: 'engineering', bot: 'repo-bot', project: 'site', branch: 'main', origin: 'https://github.com/acme/site' }] });
      expect((await reposOf(done.body.key)).headers.get('cache-control')).toBe('no-store');
      expect((await reposOf(null)).status).toBe(401);
      expect((await reposOf('mtb_' + '0'.repeat(64))).status).toBe(401);
    } finally {
      await w.system(async (tx) => {
        await tx.query("DELETE FROM app.bots WHERE slug = 'repo-bot'");
        await tx.query("DELETE FROM app.projects WHERE name IN ('site', 'elsewhere')");
      });
      if (savedAllow === undefined) delete process.env['MANYTHREADS_CLAUDE_PODS_REPO_ORIGIN_ALLOW'];
      else process.env['MANYTHREADS_CLAUDE_PODS_REPO_ORIGIN_ALLOW'] = savedAllow;
    }
  });
});

describe('the installer files', () => {
  it('the script carries this site\'s address and the bundle\'s hash; its own hash is the one the page shows', async () => {
    const res = await fetch(`${w.server.url}/install/bridge.sh`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(`sha=${bundleSha}`);
    expect(text).toContain('v=1.2.3');
    expect(text).not.toContain('@@');
    const made = await create('inst-1');
    expect(made.body.install.scriptSha256).toBe(createHash('sha256').update(text).digest('hex'));
    const sum = await (await fetch(`${w.server.url}/install/bridge.sh.sha256`)).text();
    expect(sum).toBe(`${made.body.install.scriptSha256}  bridge.sh\n`);
  });

  it('serves the bundle and its checksum, and nothing else', async () => {
    const tgz = await fetch(`${w.server.url}/install/bridge-1.2.3.tgz`);
    expect(Buffer.from(await tgz.arrayBuffer()).equals(bundleBytes)).toBe(true);
    expect(await (await fetch(`${w.server.url}/install/bridge-1.2.3.tgz.sha256`)).text()).toBe(`${bundleSha}  bridge-1.2.3.tgz\n`);
    for (const bad of ['manifest.json', '..%2Fmanifest.json', 'bridge-0.0.1.tgz', 'x']) expect((await fetch(`${w.server.url}/install/${bad}`)).status, bad).toBe(404);
  });
});

// Last on purpose: the lock holds the test server's one address for fifteen minutes.
describe('the lockout', () => {
  it('too many wrong codes from one address lock it, even for a right code', async () => {
    const made = await create('enrol-lock');
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await enrol(`mte_${String(i).padStart(40, '1')}`)).status;
    expect(last).toBe(429);
    expect((await enrol(made.body.code)).status).toBe(429);
  });

  it('too many wrong bridge keys from one address lock it for the key routes too, even for a right key', async () => {
    const made = await create('key-lock');
    // the enrolment lock above holds this address, so the key is put in the database: a known key for this server
    const key = `mtb_${'5'.repeat(64)}`;
    await w.system((tx) => tx.query("UPDATE app.bot_servers SET key_hash = $2 WHERE id = $1::uuid", [made.body.server.id, createHash('sha256').update(key).digest('hex')]));
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await fetch(`${w.server.url}/api/bridge/repos`, { headers: { authorization: `Bearer mtb_${String(i).padStart(64, '2')}` } })).status);
    // earlier tests in this file spent some of the ten: the first 429 comes at the tenth wrong key of all, never later, and nothing before it is anything but 401
    const first = statuses.indexOf(429);
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThanOrEqual(10);
    expect(statuses.slice(0, first).every((x) => x === 401)).toBe(true);
    expect(statuses.slice(first).every((x) => x === 429)).toBe(true);
    expect((await fetch(`${w.server.url}/api/bridge/repos`, { headers: { authorization: `Bearer ${key}` } })).status).toBe(429);
  });
});
