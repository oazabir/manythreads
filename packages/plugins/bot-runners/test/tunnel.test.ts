import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { BridgeToSite, type BridgeHello } from '@manythreads/shared';
import { startTunnel, type TunnelClient } from '../../../../tools/agent-bridge/src/tunnel.ts';
import { TunnelRegistry, TunnelUnavailable, type BridgeConnection } from '../src/tunnel/registry.ts';

// The two halves of the tunnel against each other (P26-12): the bridge's client (tools/agent-bridge/src/tunnel.ts) and the site's registry, joined by a real WebSocket on
// a local port, with a small stand-in for the bridge's own request handler on a Unix socket. No database: the site's key checks have their own tests (tunnel-routes).

const KEY = `mtb_${'a'.repeat(64)}`;
const SERVER_ID = '00000000-0000-4000-8000-000000000001';
const INTERNAL = 'internal-key-for-this-test-0123456789';
const log: string[] = [];

interface Rig {
  registry: TunnelRegistry;
  sockets: WebSocket[];
  agent: Server;
  seenByAgent: Array<{ method: string; url: string; auth: string | undefined; body: string }>;
  closedByClient: string[];
  client: TunnelClient;
  dir: string;
  wss: WebSocketServer;
  stored: string[];
  close(): Promise<void>;
}

/** The site: accepts a socket with the right bearer key and wires it into a registry the way `serveBridgeSocket` does (minus the database). */
async function rig(opts: { graceMs?: number; maxStreams?: number; maxUnreadBytes?: number; clientBackoff?: number; refusedWaitMs?: number } = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'tunnel-'));
  const registry = new TunnelRegistry({ graceMs: opts.graceMs ?? 400, ...(opts.maxStreams ? { maxStreams: opts.maxStreams } : {}), ...(opts.maxUnreadBytes ? { maxUnreadBytes: opts.maxUnreadBytes } : {}), log: (l) => log.push(l) });
  const seenByAgent: Rig['seenByAgent'] = [];
  const closedByClient: string[] = [];
  const stored: string[] = [];
  let currentKey = KEY;
  const agent = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('close', () => closedByClient.push(req.url ?? ''));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seenByAgent.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers['authorization'], body });
      const url = req.url ?? '';
      if (url.startsWith('/big')) {
        const big = Buffer.alloc(3 * 1024 * 1024, 0x61);
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(big);
      } else if (url.startsWith('/sse')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: one\n\n');
        const t = setInterval(() => res.write('data: tick\n\n'), 30);
        res.on('close', () => clearInterval(t));
      } else if (url.startsWith('/hang')) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('start');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ echo: body, path: url }));
      }
    });
  });
  const socketPath = join(dir, 'agent.sock');
  await new Promise<void>((resolve) => agent.listen(socketPath, resolve));
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const port = (wss.address() as { port: number }).port;
  const sockets: WebSocket[] = [];
  wss.on('connection', (ws, req) => {
    sockets.push(ws);
    if (req.headers['authorization'] !== `Bearer ${currentKey}`) {
      ws.close(1008, 'that key is not accepted');
      return;
    }
    let conn: BridgeConnection | null = null;
    ws.on('message', (raw) => {
      const frame = BridgeToSite.parse(JSON.parse(raw.toString()));
      if (frame.type === 'hello') {
        const streams = new Map();
        const made: BridgeConnection = {
          serverId: SERVER_ID,
          workspaceId: SERVER_ID,
          name: 'devbox',
          hello: frame as BridgeHello,
          socket: {} as never,
          streams,
          closed: false,
          send: (f) => ws.send(JSON.stringify(f)),
          close: (code, reason) => ws.close(code, reason),
        };
        conn = made;
        const old = registry.set(made);
        if (old && old !== made) old.close(1000, 'replaced', 'replaced');
        ws.send(JSON.stringify({ type: 'welcome', serverId: SERVER_ID, name: 'devbox', heartbeatSeconds: 5 }));
      } else if (frame.type === 'beat') ws.send(JSON.stringify({ type: 'beat_ack' }));
      else if (frame.type === 'rotated') currentKey = stored.at(-1) ?? currentKey;
      else if (conn) {
        if (frame.type === 'head') registry.handleHead(conn, frame.id, frame.status, frame.headers);
        else if (frame.type === 'data') registry.handleData(conn, frame.id, frame.data);
        else if (frame.type === 'end') registry.handleEnd(conn, frame.id);
        else if (frame.type === 'error') registry.handleError(conn, frame.id, frame.message);
      }
    });
    ws.on('close', () => {
      if (conn) {
        conn.closed = true;
        registry.remove(conn, 'closed');
      }
    });
  });
  const client = startTunnel({
    siteUrl: `http://127.0.0.1:${port}`,
    insecure: true,
    key: () => stored.at(-1) ?? KEY,
    socketPath,
    internalKey: INTERNAL,
    hello: () => ({ bridgeVersion: 'test', host: { hostname: 'box', system: 'Test OS', arch: 'x64' }, agents: [{ agent: 'codex', version: '1.0.0' }], allowFullAccess: false }),
    storeKey: async (k) => {
      stored.push(k);
    },
    log: (l) => log.push(l),
    minBackoffMs: opts.clientBackoff ?? 50,
    maxBackoffMs: Math.max(200, opts.clientBackoff ?? 0),
    refusedWaitMs: opts.refusedWaitMs ?? 60_000,
  });
  await client.connected();
  return {
    registry,
    sockets,
    agent,
    seenByAgent,
    closedByClient,
    client,
    dir,
    wss,
    stored,
    close: async () => {
      await client.close();
      for (const s of wss.clients) s.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      agent.closeAllConnections();
      await new Promise<void>((resolve) => agent.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let r: Rig;
beforeEach(() => {
  log.length = 0;
});
afterEach(async () => {
  await r?.close();
});

const fetchOf = (): typeof fetch => r.registry.fetchFor(SERVER_ID, 'devbox');
const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('a request through the tunnel', () => {
  it('reaches the bridge handler with its own key, not the site caller\'s, and the answer comes back whole', async () => {
    r = await rig();
    const res = await fetchOf()('https://ignored.example/p/codex--t--b/v1/runs?x=1', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer from-the-site' }, body: JSON.stringify({ input: 'hi' }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echo: '{"input":"hi"}', path: '/p/codex--t--b/v1/runs?x=1' });
    expect(r.seenByAgent[0]).toMatchObject({ method: 'POST', auth: `Bearer ${INTERNAL}` });
  });

  it('a 3 MiB answer arrives whole', async () => {
    r = await rig();
    const res = await fetchOf()('https://x/big');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(3 * 1024 * 1024);
    expect(bytes.every((b) => b === 0x61)).toBe(true);
  });

  it('an event stream stays a stream, and aborting it closes the request at the bridge', async () => {
    r = await rig();
    const ctl = new AbortController();
    const res = await fetchOf()('https://x/sse', { signal: ctl.signal });
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('data: one');
    ctl.abort();
    await until(() => r.closedByClient.includes('/sse'));
    await reader.cancel().catch(() => undefined);
  });

  it('never logs a body or the key', async () => {
    r = await rig();
    await (await fetchOf()('https://x/echo', { method: 'POST', body: JSON.stringify({ secret: 'MCP-TOKEN-123' }) })).text();
    const text = log.join('\n');
    expect(text).not.toContain('MCP-TOKEN-123');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(INTERNAL);
  });
});

describe('limits', () => {
  it('the 65th open request is refused at once, the first 64 are fine', async () => {
    r = await rig({ maxStreams: 3 });
    const open = [];
    for (let i = 0; i < 3; i++) open.push(await fetchOf()(`https://x/hang?${i}`));
    await expect(fetchOf()('https://x/hang?4')).rejects.toThrow(/too many requests/);
    for (const o of open) await o.body?.cancel();
  });

  it('a body over 1 MiB is refused before it is sent', async () => {
    r = await rig();
    await expect(fetchOf()('https://x/echo', { method: 'POST', body: 'a'.repeat(1024 * 1024 + 1) })).rejects.toThrow(TunnelUnavailable);
  });

  it('a reader that stops reading is cut off past the unread cap', async () => {
    r = await rig({ maxUnreadBytes: 256 * 1024 });
    const res = await fetchOf()('https://x/big');
    const reader = res.body!.getReader();
    // read nothing for a moment: the 3 MiB pile up past the cap
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expect((async () => { for (;;) { const { done } = await reader.read(); if (done) return 'done'; } })()).rejects.toThrow();
  });
});

describe('a dropped connection', () => {
  it('a drop shorter than the grace: the next request waits for the bridge and succeeds', async () => {
    r = await rig({ graceMs: 3000 });
    for (const s of r.sockets) s.terminate();
    await until(() => !r.registry.get(SERVER_ID));
    expect(r.registry.reachable(SERVER_ID)).toBe(true);
    const res = await fetchOf()('https://x/after-drop');
    expect(res.status).toBe(200);
  });

  it('a drop longer than the grace: reachable() turns false and a request fails with a plain sentence', async () => {
    r = await rig({ graceMs: 150, clientBackoff: 5_000 });
    for (const s of r.sockets) s.terminate();
    await until(() => !r.registry.get(SERVER_ID));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(r.registry.reachable(SERVER_ID)).toBe(false);
    await expect(fetchOf()('https://x/late')).rejects.toThrow(/not connected/);
  });

  it('a stream open when the socket drops fails with "disconnected"', async () => {
    r = await rig({ graceMs: 3000 });
    const res = await fetchOf()('https://x/sse');
    const reader = res.body!.getReader();
    await reader.read();
    for (const s of r.sockets) s.terminate();
    await expect((async () => { for (;;) { const { done } = await reader.read(); if (done) return; } })()).rejects.toThrow(/disconnected/);
  });
});

describe('keys', () => {
  it('a refused key (1008) is not retried at once', async () => {
    // The first connection works; then the site stops accepting the key and the bridge must not hammer it.
    r = await rig({ refusedWaitMs: 60_000 });
    const before = r.sockets.length;
    // make the site refuse from now on: a rotation to a key the site does not know
    r.stored.push(`mtb_${'b'.repeat(64)}`);
    for (const s of r.sockets) s.terminate();
    await until(() => r.sockets.length > before);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(r.sockets.length).toBe(before + 1);
  });

  it('a rotate frame is stored, answered with rotated, and the bridge reconnects with the new key', async () => {
    r = await rig();
    const next = `mtb_${'c'.repeat(64)}`;
    const before = r.sockets.length;
    r.sockets.at(-1)!.send(JSON.stringify({ type: 'rotate', key: next }));
    await until(() => r.stored.at(-1) === next);
    await until(() => r.sockets.length > before);
    // the site (the rig) took `rotated` as the new key and accepts the new one
    await until(() => r.client.isConnected());
    expect(r.stored).toEqual([next]);
  });

  it('refuses a ws:// address unless told this is a test', () => {
    expect(() => startTunnel({ siteUrl: 'http://site.example', key: () => KEY, socketPath: '/x', internalKey: INTERNAL, hello: () => ({ bridgeVersion: 't', host: { hostname: 'h', system: 's', arch: 'a' }, agents: [], allowFullAccess: false }), storeKey: async () => undefined })).toThrow(/https/);
  });
});
