import type { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STREAM_LIMITS, createStreamHub, type StreamHub, type StreamHubDeps, type StreamLimits } from '../src/streams.ts';

// The event streams a bot's endpoint holds (PLAN P14-22), without a database: a fake store stands in for `app.mcp_bot_tools` and the token table, and two hubs
// stand in for two replicas that share nothing but that store.

const BOT = '00000000-0000-4000-8000-0000000000b1';
const OTHER_BOT = '00000000-0000-4000-8000-0000000000b2';
const FRAME = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Store {
  versions: Map<string, string>;
  validTokens: Set<string>;
  reads: number;
  fail: boolean;
}
const store = (): Store => ({ versions: new Map([[BOT, '1'], [OTHER_BOT, '1']]), validTokens: new Set(['tok-a', 'tok-b', 'tok-c']), reads: 0, fail: false });
const depsOf = (s: Store, warnings: string[] = []): StreamHubDeps => ({
  versions: async (ids) => {
    s.reads += 1;
    if (s.fail) throw new Error('database is down');
    return new Map(ids.flatMap((id) => (s.versions.has(id) ? [[id, s.versions.get(id)!] as const] : [])));
  },
  validTokens: async (hashes) => new Set(hashes.filter((h) => s.validTokens.has(h))),
  warn: (line) => void warnings.push(line),
});

/** Everything the stream has written so far, read without waiting for more. */
function collect(stream: Readable): { text: () => string; ended: () => boolean } {
  let text = '';
  let ended = false;
  stream.on('data', (chunk: Buffer | string) => void (text += chunk.toString()));
  stream.on('end', () => void (ended = true));
  stream.on('close', () => void (ended = true));
  return { text: () => text, ended: () => ended };
}

const FAST: Partial<StreamLimits> = { tickMs: 5, pollMs: 10, validityMs: 20, keepaliveMs: 60, maxAgeMs: 100_000 };

const hubs: StreamHub[] = [];
const makeHub = (s: Store, over: Partial<StreamLimits> = {}, warnings?: string[]): StreamHub => {
  const hub = createStreamHub(depsOf(s, warnings), { ...FAST, ...over });
  hubs.push(hub);
  return hub;
};
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.stop();
});

const openOk = (hub: StreamHub, token = 'tok-a', bot = BOT, baseline = '1'): Readable => {
  const opened = hub.open(bot, token, baseline);
  if (!opened.ok) throw new Error(`refused: ${opened.reason}`);
  return opened.stream;
};

describe('the stream hub', () => {
  it('limits are the ones the row names', () => {
    expect(STREAM_LIMITS).toMatchObject({ perBot: 4, keepaliveMs: 25_000, maxAgeMs: 30 * 60_000 });
  });

  it('sends one list_changed the moment a stream opens, and nothing else until something changes', async () => {
    const hub = makeHub(store());
    const seen = collect(openOk(hub));
    await sleep(30);
    expect(seen.text()).toBe(FRAME);
  });

  it('sends a keepalive comment when a stream has been quiet', async () => {
    const hub = makeHub(store());
    const seen = collect(openOk(hub));
    await sleep(200);
    expect(seen.text().startsWith(FRAME)).toBe(true);
    expect(seen.text()).toContain(': keepalive\n\n');
    expect(seen.text().split('data:').length - 1).toBe(1);
  });

  it('pushes list_changed to every open stream of a bot when its counter moves, and to no other bot’s', async () => {
    const s = store();
    const hub = makeHub(s);
    const a = collect(openOk(hub, 'tok-a'));
    const b = collect(openOk(hub, 'tok-b'));
    const other = collect(openOk(hub, 'tok-c', OTHER_BOT));
    await sleep(30);
    s.versions.set(BOT, '2');
    await sleep(60);
    expect(a.text().split(FRAME).length - 1).toBe(2);
    expect(b.text().split(FRAME).length - 1).toBe(2);
    expect(other.text().split(FRAME).length - 1).toBe(1);
    // the same counter again is not another push
    await sleep(60);
    expect(a.text().split(FRAME).length - 1).toBe(2);
  });

  it('a change written by another replica reaches a stream this one holds, through the store alone', async () => {
    const s = store();
    const first = makeHub(s);
    const second = makeHub(s);
    const held = collect(openOk(first));
    openOk(second, 'tok-b');
    await sleep(30);
    // the second replica's event subscriber is the one that wrote the change; the first has no part in it but the shared store
    s.versions.set(BOT, '2');
    await sleep(60);
    expect(held.text().split(FRAME).length - 1).toBe(2);
  });

  it('wake() looks at once instead of at the next poll', async () => {
    const s = store();
    const hub = makeHub(s, { pollMs: 60_000 });
    const seen = collect(openOk(hub));
    await sleep(20);
    s.versions.set(BOT, '2');
    hub.wake();
    await sleep(30);
    expect(seen.text().split(FRAME).length - 1).toBe(2);
  });

  it('ends at once when its token stops resolving, and leaves the others', async () => {
    const s = store();
    const hub = makeHub(s);
    const revoked = collect(openOk(hub, 'tok-a'));
    const kept = collect(openOk(hub, 'tok-b'));
    await sleep(30);
    s.validTokens.delete('tok-a');
    await sleep(80);
    expect(revoked.ended()).toBe(true);
    expect(kept.ended()).toBe(false);
    expect(hub.count(BOT)).toBe(1);
  });

  it('ends a stream after its maximum age (the client reconnects)', async () => {
    const hub = makeHub(store(), { maxAgeMs: 50 });
    const seen = collect(openOk(hub));
    await sleep(120);
    expect(seen.ended()).toBe(true);
    expect(hub.count()).toBe(0);
  });

  it('refuses the fifth stream of a bot and the stream past the global cap, and gives the room back when one closes', async () => {
    const hub = makeHub(store(), { perBot: 4, global: 5 });
    const open = Array.from({ length: 4 }, () => openOk(hub));
    expect(hub.refusal(BOT)).toBe('bot_cap');
    expect(hub.open(BOT, 'tok-a', '1')).toEqual({ ok: false, reason: 'bot_cap' });
    openOk(hub, 'tok-c', OTHER_BOT);
    expect(hub.refusal(OTHER_BOT)).toBe('global_cap');
    open[0]!.destroy();
    await sleep(5);
    expect(hub.refusal(BOT)).toBeNull();
    expect(hub.count()).toBe(4);
  });

  it('drops a reader that cannot keep up instead of buffering without limit', async () => {
    const hub = makeHub(store(), { keepaliveMs: 1, tickMs: 2, maxBufferedBytes: 200 });
    // paused and never read: every keepalive piles up in the stream's buffer
    const stream = openOk(hub);
    await sleep(150);
    expect(stream.destroyed).toBe(true);
    expect(hub.count()).toBe(0);
    expect(stream.readableLength).toBeLessThan(1000);
  });

  it('drops a client that reads nothing at the real timings: a frame is tiny, so it is two unread keepalive times in a row, not the byte limit (fake timers)', async () => {
    vi.useFakeTimers();
    try {
      const s = store();
      const hub = createStreamHub(depsOf(s), { pollMs: 2_000, validityMs: 10_000 }); // the real keepalive (25 s), tick (1 s) and byte limit (16 KB)
      hubs.push(hub);
      const stuck = openOk(hub, 'tok-a'); // never read: the proxy took the connection and stopped reading
      const reading = openOk(hub, 'tok-b');
      const seen = collect(reading);
      await vi.advanceTimersByTimeAsync(24_000);
      expect(stuck.destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000); // 26 s: the first keepalive time; the open frame is still unread, one stall
      expect(stuck.destroyed).toBe(false);
      expect(stuck.readableLength).toBeLessThan(200);
      await vi.advanceTimersByTimeAsync(26_000); // 52 s: the second one, still nothing read
      expect(stuck.destroyed).toBe(true);
      expect(hub.count(BOT)).toBe(1);
      // the reader that reads is never dropped, however long it lives
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(seen.ended()).toBe(false);
      expect(seen.text()).toContain(': keepalive');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a client that was slow once but reads again is not dropped (the count is of keepalive times in a row)', async () => {
    vi.useFakeTimers();
    try {
      const hub = createStreamHub(depsOf(store()), {});
      hubs.push(hub);
      const stream = openOk(hub);
      await vi.advanceTimersByTimeAsync(26_000); // one stall
      const seen = collect(stream); // starts reading now
      await vi.advanceTimersByTimeAsync(60_000);
      expect(stream.destroyed).toBe(false);
      expect(seen.text()).toContain(': keepalive');
    } finally {
      vi.useRealTimers();
    }
  });

  it('wake({ tokens: true }) checks the tokens at once instead of at the next ten-second look', async () => {
    const s = store();
    const hub = makeHub(s, { validityMs: 60_000, pollMs: 60_000 });
    const gone = collect(openOk(hub, 'tok-a'));
    await sleep(20);
    s.validTokens.delete('tok-a');
    hub.wake(); // a plain wake looks at the counters only
    await sleep(30);
    expect(gone.ended()).toBe(false);
    hub.wake({ tokens: true });
    await sleep(30);
    expect(gone.ended()).toBe(true);
  });

  it('1,000 opens and closes leave nothing held and no timer running', async () => {
    const s = store();
    const hub = makeHub(s, { perBot: 1000, global: 5000 });
    for (let i = 0; i < 1000; i += 1) {
      const stream = openOk(hub, 'tok-a');
      if (i % 2 === 0) stream.destroy();
      else {
        stream.on('data', () => undefined);
        stream.push(null);
        stream.resume();
      }
    }
    await sleep(40);
    // half were destroyed, half ended by their reader: both must be released
    for (let i = 0; i < 1000 && hub.count() > 0; i += 1) await sleep(5);
    expect(hub.count()).toBe(0);
    const reads = s.reads;
    await sleep(60);
    expect(s.reads).toBe(reads);
  });

  it('a database that is down is logged and the streams stay open', async () => {
    const s = store();
    s.fail = true;
    const warnings: string[] = [];
    const hub = makeHub(s, {}, warnings);
    const seen = collect(openOk(hub));
    await sleep(60);
    expect(seen.ended()).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.join('\n')).not.toContain('tok-a');
  });

  it('never puts a token, a bot id or a counter in a frame', async () => {
    const s = store();
    const hub = makeHub(s);
    const seen = collect(openOk(hub, 'tok-a'));
    await sleep(20);
    s.versions.set(BOT, '99');
    await sleep(80);
    expect(seen.text()).not.toMatch(/tok-a|99|b1/);
    expect(seen.text().replaceAll(FRAME, '').replaceAll(': keepalive\n\n', '')).toBe('');
  });
});
