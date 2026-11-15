/* eslint-disable @typescript-eslint/no-explicit-any -- these tests read JSON documents of many shapes */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { TUNNEL_CHUNK_BYTES, TUNNEL_MAX_FRAME_BYTES } from '@manythreads/shared';
import { startTunnel, type TunnelClient } from '../../../../tools/agent-bridge/src/tunnel.ts';
import { createWorld, personas, type World } from './world.ts';

// The tunnel through the REAL site (P26 review H1): the bridge's client dials the real server (buildServer, its websocket plugin and its 64 KiB default frame limit), and the
// site asks the bridge's stand-in agent a question whose answer is over 1 MiB, which crosses as 64 KiB data chunks. tunnel.test.ts joins the two halves with a bare `ws` server,
// which has no such limit and so could not see that the site cut every frame over 48 KiB.

const { omar } = personas;
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let w: World;
let dir: string;
let agent: Server;
let client: TunnelClient | null = null;
const clientLog: string[] = [];
let statusCalls = 0;
const HELLO = { bridgeVersion: '1.2.3', host: { hostname: 'box-big', system: 'Ubuntu 24.04', arch: 'x64' }, agents: [{ agent: 'claude-code' as const, version: '2.1.3' }, { agent: 'codex' as const, version: '0.166.0' }], allowFullAccess: false };
const INTERNAL = 'internal-key-for-this-test-0123456789';
const PAD_BYTES = Math.round(1.5 * 1024 * 1024);

const until = async (cond: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> => {
  await vi.waitFor(async () => {
    if (!(await cond())) throw new Error('not yet');
  }, { timeout: ms, interval: 40 });
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tunnel-site-'));
  agent = createServer((req, res) => {
    req.resume();
    if ((req.url ?? '').startsWith('/v1/auth/status')) {
      statusCalls += 1;
      const agentName = new URL(req.url ?? '', 'http://x').searchParams.get('agent') ?? 'codex';
      res.writeHead(200, { 'content-type': 'application/json' });
      // an answer over 1 MiB: the site reads `auth` and ignores the padding
      res.end(JSON.stringify({ auth: { agent: agentName, profile: 'default', home: 'dedicated', state: 'signed_in', kind: 'account', canLogout: true, methods: [], attempt: null, note: null }, pad: 'x'.repeat(PAD_BYTES) }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => agent.listen(join(dir, 'agent.sock'), resolve));
  w = await createWorld();
}, 120_000);

afterAll(async () => {
  await client?.close();
  await w?.close();
  await new Promise<void>((resolve) => agent.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

const rawSocket = (key: string): Promise<{ ws: WebSocket; closed: Promise<number> }> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(w.server.url.replace('http', 'ws') + '/api/bridge/connect', { headers: { authorization: `Bearer ${key}` } });
    const closed = new Promise<number>((done) => ws.on('close', (code) => done(code)));
    ws.on('open', () => resolve({ ws, closed }));
    ws.on('error', reject);
  });

describe('the tunnel through the real site', () => {
  let key = '';

  it('a frame of the size the bridge sends is under the limit the site gives the tunnel socket', () => {
    // a data chunk is base64 text in a JSON envelope: a third more than the bytes, plus a few dozen characters
    const frame = Math.ceil((TUNNEL_CHUNK_BYTES * 4) / 3) + 512;
    expect(frame).toBeLessThan(TUNNEL_MAX_FRAME_BYTES);
    expect(TUNNEL_MAX_FRAME_BYTES).toBeLessThan(1024 * 1024);
  });

  it('an answer of more than 1 MiB, in 64 KiB chunks, comes through the real site and the tunnel stays up', async () => {
    const made = await w.call<any>(omar, 'POST', '/api/admin/bot-servers', { name: 'big-1', label: 'Big' });
    expect(made.status).toBe(201);
    const done = await w.call<any>(null, 'POST', '/api/bridge/enrol', { code: made.body.code, host: HELLO.host, agents: HELLO.agents, bridgeVersion: '1.2.3', allowFullAccess: false });
    expect(done.status).toBe(200);
    key = done.body.key as string;
    client = startTunnel({
      siteUrl: w.server.url,
      key: () => key,
      socketPath: join(dir, 'agent.sock'),
      internalKey: INTERNAL,
      hello: () => HELLO,
      storeKey: async () => undefined,
      insecure: true,
      minBackoffMs: 100,
      maxBackoffMs: 200,
      log: (l) => clientLog.push(l),
    });
    await client.connected();
    // on connect the site asks the agent for each sign-in; both answers carry the padding. A runner leaves `waiting_for_sign_in` only when its whole answer arrived.
    await until(async () => {
      const rows = await w.system(async (tx) => (await tx.query<{ status: string }>("SELECT status FROM app.bot_runners WHERE name LIKE 'big-1-%' AND agent IN ('claude-code','codex')")).rows);
      return rows.length === 2 && rows.every((r) => r.status === 'ready');
    });
    expect(statusCalls).toBe(2);
    // one connection for all of it: nothing was cut and re-dialled
    expect(client.isConnected()).toBe(true);
    expect(clientLog.filter((l) => /closed|reconnect|refused|too big|1009/i.test(l))).toEqual([]);
  });

  it('the tunnel socket takes a frame of 100 KiB and closes one over its own limit with 1009 (too big)', async () => {
    const ok = await rawSocket(key);
    // not a frame of the protocol: closed as a protocol error (1002), not as too big
    ok.ws.send(JSON.stringify({ type: 'nonsense', pad: 'a'.repeat(100 * 1024) }));
    expect(await ok.closed).toBe(1002);
    const big = await rawSocket(key);
    big.ws.send(JSON.stringify({ type: 'nonsense', pad: 'a'.repeat(TUNNEL_MAX_FRAME_BYTES + 1024) }));
    expect(await big.closed).toBe(1009);
  });

  it('other sockets keep the server-wide limit: /ws closes a 70 KiB frame with 1009', async () => {
    const ws = new WebSocket(w.server.url.replace('http', 'ws') + '/ws');
    const closed = new Promise<number>((done) => ws.on('close', (code) => done(code)));
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    ws.send('a'.repeat(70 * 1024));
    expect(await closed).toBe(1009);
  });
});
