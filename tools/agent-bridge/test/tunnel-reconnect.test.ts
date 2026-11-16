import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { startTunnel, type TunnelClient } from '../src/tunnel.ts';

// The reconnect loop (P26-12): after a deploy the site answers 503 to the upgrade; ws ends nothing when 'unexpected-response' has a listener, so the loop used to stop for good.

const KEY = `mtb_${'a'.repeat(64)}`;
const HELLO = { bridgeVersion: 't', host: { hostname: 'h', system: 'linux', arch: 'x64' }, agents: [], allowFullAccess: false };

interface Fake {
  server: Server;
  url: string;
  /** What the next upgrade gets: a number answers that HTTP status, 'accept' opens the socket (and welcomes), 'silent' opens it and never welcomes. */
  script: Array<number | 'accept' | 'silent'>;
  attempts: number;
  sockets: ServerSocket[];
  hellos: number;
}

const toClose: Array<() => Promise<void>> = [];
const unhandled: unknown[] = [];
const onUnhandled = (e: unknown): void => {
  unhandled.push(e);
};
process.on('unhandledRejection', onUnhandled);

async function fakeSite(script: Fake['script'], fallback: number | 'accept' = 'accept'): Promise<Fake> {
  const wss = new WebSocketServer({ noServer: true });
  const fake: Fake = { server: createServer((_req, res) => res.writeHead(404).end()), url: '', script, attempts: 0, sockets: [], hellos: 0 };
  fake.server.on('upgrade', (req: IncomingMessage, socket, head) => {
    fake.attempts += 1;
    const step = fake.script.shift() ?? fallback;
    if (typeof step === 'number') {
      socket.end(`HTTP/1.1 ${step} Nope\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      fake.sockets.push(ws);
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as { type: string };
        if (frame.type === 'hello') {
          fake.hellos += 1;
          if (step === 'accept') ws.send(JSON.stringify({ type: 'welcome', name: 'srv', heartbeatSeconds: 20 }));
        }
      });
    });
  });
  await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  toClose.push(async () => {
    for (const s of fake.sockets) s.terminate();
    fake.server.closeAllConnections();
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  });
  return fake;
}

function tunnel(fake: Fake, over: Partial<Parameters<typeof startTunnel>[0]> = {}): { client: TunnelClient; logs: string[] } {
  const logs: string[] = [];
  const client = startTunnel({
    siteUrl: fake.url,
    insecure: true,
    key: () => KEY,
    socketPath: '/nonexistent.sock',
    internalKey: 'x',
    hello: () => HELLO,
    storeKey: async () => undefined,
    log: (l) => logs.push(l),
    minBackoffMs: 20,
    maxBackoffMs: 100,
    ...over,
  });
  toClose.push(() => client.close());
  return { client, logs };
}

const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

afterEach(async () => {
  for (const c of toClose.splice(0).reverse()) await c();
  await new Promise((r) => setTimeout(r, 20));
  expect(unhandled).toEqual([]);
});

describe('the tunnel keeps retrying', () => {
  it('reconnects after the site answers 503 twice', async () => {
    const fake = await fakeSite([503, 503]);
    const { client, logs } = tunnel(fake);
    await client.connected();
    expect(client.isConnected()).toBe(true);
    expect(fake.attempts).toBe(3);
    expect(logs.filter((l) => l.includes('answered 503'))).toHaveLength(2);
    expect(logs.filter((l) => /trying again in/.test(l)).length).toBeGreaterThanOrEqual(2);
  });

  it('keeps going on 502, 504 and 500', async () => {
    const fake = await fakeSite([502, 504, 500]);
    const { client } = tunnel(fake);
    await client.connected();
    expect(fake.attempts).toBe(4);
  });

  it('reconnects after the socket drops in the middle of a session', async () => {
    const fake = await fakeSite([]);
    const { client } = tunnel(fake);
    await client.connected();
    fake.sockets[0]!.terminate();
    await until(() => fake.attempts === 2 && fake.hellos === 2);
    await until(() => client.isConnected());
    // and again after a close with a normal code
    fake.sockets[1]!.close(1001, 'restart');
    await until(() => fake.attempts === 3);
    await until(() => client.isConnected());
  });

  it('reconnects when the site is down (connection refused) and comes back', async () => {
    const fake = await fakeSite([]);
    const port = new URL(fake.url).port;
    const { client } = tunnel(fake);
    await client.connected();
    for (const s of fake.sockets) s.terminate();
    fake.server.closeAllConnections();
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    await new Promise((r) => setTimeout(r, 250));
    expect(client.isConnected()).toBe(false);
    const again = await fakeSiteOn(Number(port));
    await until(() => again.hellos === 1, 8000);
    await until(() => client.isConnected());
  });

  it('retries a socket that opens but is never welcomed', async () => {
    const fake = await fakeSite(['silent']);
    const { client, logs } = tunnel(fake, { welcomeWaitMs: 150 });
    await client.connected();
    expect(fake.attempts).toBe(2);
    expect(logs.some((l) => l.includes('did not welcome'))).toBe(true);
  });

  it('waits long after a 401 or 403 and then asks again with the key it has then', async () => {
    const fake = await fakeSite([401, 403]);
    const keys: string[] = [];
    const { client, logs } = tunnel(fake, { refusedWaitMs: 300, minBackoffMs: 10, maxBackoffMs: 20, key: () => (keys.push('k'), KEY) });
    await until(() => fake.attempts === 1);
    await new Promise((r) => setTimeout(r, 150));
    // the short back-off (10-20 ms) did not apply: no second attempt inside the refused wait
    expect(fake.attempts).toBe(1);
    expect(logs.some((l) => l.includes('does not accept this key'))).toBe(true);
    await until(() => fake.attempts === 2);
    await new Promise((r) => setTimeout(r, 150));
    expect(fake.attempts).toBe(2);
    await client.connected();
    expect(fake.attempts).toBe(3);
    expect(keys).toHaveLength(3);
  });

  it('a close with 1008 also waits the long time', async () => {
    const fake = await fakeSite([]);
    const { client } = tunnel(fake, { refusedWaitMs: 300, minBackoffMs: 10, maxBackoffMs: 20 });
    await client.connected();
    fake.sockets[0]!.close(1008, 'revoked');
    await new Promise((r) => setTimeout(r, 150));
    expect(fake.attempts).toBe(1);
    await until(() => fake.attempts === 2);
  });

  it('backs off exponentially, capped, and logs each retry', async () => {
    const fake = await fakeSite([], 503);
    const { logs } = tunnel(fake, { minBackoffMs: 50, maxBackoffMs: 200 });
    const t0 = Date.now();
    await until(() => fake.attempts >= 6, 8000);
    // pauses of 50, 100, 200, 200, 200 ms (plus jitter, never above the cap): not faster than 550 ms, and well under what a flat 50 ms would give
    expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
    expect(logs.filter((l) => /trying again in/.test(l)).length).toBeGreaterThanOrEqual(5);
  });

  it('keeps running when the key cannot be read, and uses it once it can', async () => {
    const fake = await fakeSite([]);
    let ok = false;
    const { client, logs } = tunnel(fake, {
      refusedWaitMs: 100,
      key: () => {
        if (!ok) throw new Error('no key file');
        return KEY;
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.attempts).toBe(0);
    ok = true;
    await client.connected();
    expect(logs.some((l) => l.includes('no key to connect with'))).toBe(true);
  });
});

async function fakeSiteOn(port: number): Promise<Fake> {
  const wss = new WebSocketServer({ noServer: true });
  const fake: Fake = { server: createServer(), url: '', script: [], attempts: 0, sockets: [], hellos: 0 };
  fake.server.on('upgrade', (req, socket, head) => {
    fake.attempts += 1;
    wss.handleUpgrade(req, socket, head, (ws) => {
      fake.sockets.push(ws);
      ws.on('message', (raw) => {
        if ((JSON.parse(raw.toString()) as { type: string }).type === 'hello') {
          fake.hellos += 1;
          ws.send(JSON.stringify({ type: 'welcome', name: 'srv', heartbeatSeconds: 20 }));
        }
      });
    });
  });
  await new Promise<void>((resolve) => fake.server.listen(port, '127.0.0.1', resolve));
  toClose.push(async () => {
    for (const s of fake.sockets) s.terminate();
    fake.server.closeAllConnections();
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  });
  return fake;
}
