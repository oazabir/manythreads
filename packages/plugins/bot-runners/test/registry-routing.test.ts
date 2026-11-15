import { describe, expect, it } from 'vitest';
import type { BridgeHello, SiteToBridge } from '@manythreads/shared';
import { TunnelRegistry, TunnelUnavailable, type BridgeConnection, type TunnelStream } from '../src/tunnel/registry.ts';

// Who a request reaches (P26 review T2, T3): the registry is keyed by the server's id, never by its name, so two servers of one name in two workspaces are two connections; a
// second socket for one server replaces the first and fails what was waiting on it; a frame is only ever read on the connection that holds the stream it names.

const HELLO = { type: 'hello', protocol: 1, bridgeVersion: '1', host: { hostname: 'h', system: 's', arch: 'x64' }, agents: [], allowFullAccess: false } as unknown as BridgeHello;

interface Fake extends BridgeConnection {
  sent: SiteToBridge[];
  closedWith: string[];
}

function fake(serverId: string, workspaceId: string, name = 'devbox'): Fake {
  const sent: SiteToBridge[] = [];
  const closedWith: string[] = [];
  const conn: Fake = {
    serverId,
    workspaceId,
    name,
    hello: HELLO,
    socket: {} as never,
    streams: new Map<string, TunnelStream>(),
    closed: false,
    sent,
    closedWith,
    send: (f) => void sent.push(f),
    close: (_code, _reason, why) => {
      conn.closed = true;
      closedWith.push(why);
    },
  };
  return conn;
}

const requestOf = (c: Fake): Extract<SiteToBridge, { type: 'request' }> => c.sent.find((f) => f.type === 'request') as never;
const answer = (reg: TunnelRegistry, c: Fake, id: string, body: string): void => {
  reg.handleHead(c, id, 200, { 'content-type': 'text/plain' });
  reg.handleData(c, id, Buffer.from(body).toString('base64'));
  reg.handleEnd(c, id);
};

describe('who a request reaches', () => {
  it('two servers of one name in two workspaces are two connections: a request for one is sent on that socket only, and its answer is not read from the other', async () => {
    const reg = new TunnelRegistry();
    const a = fake('00000000-0000-4000-8000-00000000000a', 'ws-a');
    const b = fake('00000000-0000-4000-8000-00000000000b', 'ws-b');
    reg.set(a);
    reg.set(b);
    expect(reg.connectedIds().sort()).toEqual([a.serverId, b.serverId].sort());
    const pending = reg.fetchFor(a.serverId, 'devbox')('https://x/v1/where');
    await expect.poll(() => a.sent.length).toBe(1);
    expect(b.sent).toEqual([]);
    const id = requestOf(a).id;
    // the other server's socket claiming to answer is ignored: it holds no such stream
    answer(reg, b, id, 'from the wrong server');
    let settled = false;
    void pending.then(() => (settled = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    answer(reg, a, id, 'from the right one');
    const res = await pending;
    expect(await res.text()).toBe('from the right one');
    expect(b.sent).toEqual([]);
  });

  it('a request for a server id that is not connected does not fall back to a server of the same name', async () => {
    const reg = new TunnelRegistry({ graceMs: 1 });
    const other = fake('00000000-0000-4000-8000-00000000000b', 'ws-b');
    reg.set(other);
    await expect(reg.fetchFor('00000000-0000-4000-8000-00000000000a', 'devbox')('https://x/v1/where')).rejects.toThrow(TunnelUnavailable);
    expect(other.sent).toEqual([]);
  });
});

describe('a second socket for one server', () => {
  it('replaces the first: set() hands the old one back, closing it fails what waited on it, and the new socket serves from then on', async () => {
    const reg = new TunnelRegistry();
    const first = fake('00000000-0000-4000-8000-00000000000a', 'ws-a');
    reg.set(first);
    const waiting = reg.fetchFor(first.serverId, 'devbox')('https://x/slow');
    await expect.poll(() => first.sent.length).toBe(1);
    const failure = expect(waiting).rejects.toThrow(/disconnected/);
    const second = fake(first.serverId, 'ws-a');
    const old = reg.set(second);
    expect(old).toBe(first);
    // what the site does with the answer: close it, and the close handler removes it
    old!.close(1000, 'replaced', 'replaced');
    expect(first.closedWith).toEqual(['replaced']);
    expect(reg.remove(first, 'replaced')).toBe(false);
    await failure;
    // the registered connection is still the new one
    expect(reg.get(first.serverId)).toBe(second);
    const next = reg.fetchFor(first.serverId, 'devbox')('https://x/after');
    await expect.poll(() => second.sent.length).toBe(1);
    expect(first.sent).toHaveLength(1);
    answer(reg, second, requestOf(second).id, 'ok');
    expect(await (await next).text()).toBe('ok');
  });
});
