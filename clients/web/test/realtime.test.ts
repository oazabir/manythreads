import { describe, expect, it, vi } from 'vitest';
import { BACKOFF_MAX_MS, PING_EVERY_MS, RealtimeClient, SILENCE_MS, backoffDelay, defaultSocketUrl, type SocketLike } from '../src/realtime/socket';

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closed: Array<number | undefined> = [];
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  send(d: string): void {
    this.sent.push(d);
  }
  close(code?: number): void {
    this.closed.push(code);
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(obj: unknown): void {
    this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) });
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let now = 0;
  let nextId = 1;
  const client = new RealtimeClient({
    url: () => 'ws://x/ws',
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    setTimeout: (fn, ms) => {
      const t = { at: now + ms, fn, id: nextId++ };
      timers.push(t);
      return t.id;
    },
    clearTimeout: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    random: () => 0.5,
  });
  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      const next = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers.splice(timers.indexOf(next), 1);
      now = next.at;
      next.fn();
    }
    now = end;
  };
  return { client, sockets, advance };
}

describe('realtime client', () => {
  it('backs off 0.5 s, 1 s, 2 s ... to a cap, with jitter of a quarter either way', () => {
    expect([0, 1, 2, 3].map((n) => backoffDelay(n, 0.5))).toEqual([500, 1000, 2000, 4000]);
    expect(backoffDelay(20, 0.5)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelay(0, 0)).toBe(375);
    expect(backoffDelay(0, 1)).toBe(625);
  });

  it('delivers valid push envelopes, ignores junk and pongs', () => {
    const { client, sockets } = setup();
    const seen: string[] = [];
    client.onPush((p) => seen.push(p.type));
    client.start();
    sockets[0]?.open();
    sockets[0]?.push({ type: 'message.posted', id: 'a', payload: { x: 1 } });
    sockets[0]?.push({ type: 'pong', id: 'p1', payload: {} });
    sockets[0]?.push('not json');
    sockets[0]?.push({ type: 'x', id: 'a', payload: {}, extra: true });
    sockets[0]?.push({ type: 'reaction.changed', id: 'b', payload: {} });
    expect(seen).toEqual(['message.posted', 'reaction.changed']);
    expect(client.status).toBe('open');
  });

  it('reconnects after a drop with growing waits, and says "reconnected" only after the first open', () => {
    const { client, sockets, advance } = setup();
    const reopened = vi.fn();
    client.onReconnected(reopened);
    client.start();
    sockets[0]?.open();
    expect(reopened).not.toHaveBeenCalled();
    sockets[0]?.drop();
    expect(client.status).toBe('waiting');
    advance(499);
    expect(sockets).toHaveLength(1);
    advance(2);
    expect(sockets).toHaveLength(2);
    sockets[1]?.drop(); // never opened: the next wait is longer
    advance(999);
    expect(sockets).toHaveLength(2);
    advance(2);
    expect(sockets).toHaveLength(3);
    sockets[2]?.open();
    expect(reopened).toHaveBeenCalledTimes(1);
    expect(client.status).toBe('open');
  });

  it('pings every 25 s and replaces a connection that goes silent', () => {
    const { client, sockets, advance } = setup();
    client.start();
    sockets[0]?.open();
    advance(PING_EVERY_MS + 1);
    expect(sockets[0]?.sent.map((s) => JSON.parse(s).type)).toEqual(['ping']);
    sockets[0]?.push({ type: 'pong', id: 'p1', payload: {} }); // any frame counts as life
    advance(SILENCE_MS - 1_000);
    expect(sockets).toHaveLength(1);
    advance(SILENCE_MS);
    expect(sockets[0]?.closed).toEqual([4000]);
    advance(1_000);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
  });

  it('stop closes the socket and nothing reconnects; nudge skips the wait', () => {
    const { client, sockets, advance } = setup();
    client.start();
    sockets[0]?.open();
    sockets[0]?.drop();
    client.nudge();
    expect(sockets).toHaveLength(2);
    client.stop();
    expect(client.status).toBe('idle');
    advance(60_000);
    expect(sockets).toHaveLength(2);
  });

  it('the address is the page origin with ws or wss', () => {
    expect(defaultSocketUrl({ protocol: 'http:', host: 'localhost:4173' })).toBe('ws://localhost:4173/ws');
    expect(defaultSocketUrl({ protocol: 'https:', host: 'manythreads.kahf.to' })).toBe('wss://manythreads.kahf.to/ws');
  });
});
