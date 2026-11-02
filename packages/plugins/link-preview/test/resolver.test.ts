import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LookupRefused, createBoundedResolver, type DnsBackend } from '../src/resolver.ts';

// The name lookup must never be able to stall the server: two lookups at a time, one short try, a short memory of failed names, and a caller that gives
// up leaves the line. No network: a fake backend whose answers the test releases by hand.

type Release = { ok: (addresses: string[]) => void; fail: () => void };

/** A backend whose lookups stay open until the test answers them. */
function manual() {
  const calls: string[] = [];
  const open = new Map<string, Release[]>();
  const ask = (kind: '4' | '6', name: string): Promise<string[]> =>
    new Promise((resolve, reject) => {
      calls.push(`${kind}:${name}`);
      const list = open.get(`${kind}:${name}`) ?? [];
      list.push({ ok: resolve, fail: () => reject(new Error('ENODATA')) });
      open.set(`${kind}:${name}`, list);
    });
  const backend: DnsBackend = { resolve4: (n) => ask('4', n), resolve6: (n) => ask('6', n) };
  const answer = (name: string, v4: string[] | null, v6: string[] | null = null): void => {
    for (const r of open.get(`4:${name}`) ?? []) {
      if (v4) r.ok(v4);
      else r.fail();
    }
    for (const r of open.get(`6:${name}`) ?? []) {
      if (v6) r.ok(v6);
      else r.fail();
    }
    open.delete(`4:${name}`);
    open.delete(`6:${name}`);
  };
  return { backend, calls, answer };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('createBoundedResolver', () => {
  it('merges the IPv4 and IPv6 answers, and one family failing is not a failure', async () => {
    const m = manual();
    const resolve = createBoundedResolver({ backend: m.backend });
    const p = resolve('a.test');
    m.answer('a.test', ['93.184.216.34'], ['2606:4700::1111']);
    expect(await p).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700::1111', family: 6 },
    ]);
    const q = resolve('b.test');
    m.answer('b.test', null, ['2606:4700::1111']);
    expect(await q).toEqual([{ address: '2606:4700::1111', family: 6 }]);
  });

  it('fails when neither family answers, and does not ask the same name again for a while', async () => {
    const m = manual();
    let t = 1000;
    const resolve = createBoundedResolver({ backend: m.backend, negativeTtlMs: 30_000, now: () => t });
    const p = resolve('dead.test');
    m.answer('dead.test', null, null);
    await expect(p).rejects.toMatchObject({ reason: 'failed' });
    expect(m.calls).toHaveLength(2);

    await expect(resolve('dead.test')).rejects.toMatchObject({ reason: 'cooling' });
    await expect(resolve('DEAD.test')).rejects.toMatchObject({ reason: 'cooling' }); // names are case-blind
    expect(m.calls).toHaveLength(2); // nothing was asked

    t += 30_001;
    const again = resolve('dead.test');
    await tick();
    expect(m.calls).toHaveLength(4);
    m.answer('dead.test', ['93.184.216.34']);
    await expect(again).resolves.toHaveLength(1);
  });

  it('remembers at most negativeMax failed names, the oldest forgotten first', async () => {
    const m = manual();
    const resolve = createBoundedResolver({ backend: m.backend, negativeMax: 2, maxInFlight: 10 });
    for (const n of ['a.test', 'b.test', 'c.test']) {
      const p = resolve(n);
      m.answer(n, null, null);
      await p.catch(() => undefined);
    }
    expect(resolve.stats().remembered).toBe(2);
    await expect(resolve('c.test')).rejects.toMatchObject({ reason: 'cooling' });
    const a = resolve('a.test'); // forgotten: asked again
    await tick();
    expect(m.calls.filter((c) => c === '4:a.test')).toHaveLength(2);
    m.answer('a.test', ['8.8.8.8']);
    await a;
  });

  it('runs at most maxInFlight lookups at once; the others take their turn in order', async () => {
    const m = manual();
    const resolve = createBoundedResolver({ backend: m.backend, maxInFlight: 2 });
    const first = resolve('one.test');
    const second = resolve('two.test');
    const third = resolve('three.test');
    const fourth = resolve('four.test');
    await tick();
    expect(resolve.stats()).toEqual({ inFlight: 2, waiting: 2, remembered: 0 });
    expect(m.calls.filter((c) => c.startsWith('4:'))).toEqual(['4:one.test', '4:two.test']);

    m.answer('one.test', ['8.8.8.8']);
    await first;
    await tick();
    expect(m.calls.filter((c) => c.startsWith('4:'))).toEqual(['4:one.test', '4:two.test', '4:three.test']);
    expect(resolve.stats()).toMatchObject({ inFlight: 2, waiting: 1 });

    m.answer('two.test', ['8.8.8.8']);
    m.answer('three.test', ['8.8.8.8']);
    await tick();
    m.answer('four.test', ['8.8.8.8']);
    await Promise.all([second, third, fourth]);
    expect(resolve.stats()).toEqual({ inFlight: 0, waiting: 0, remembered: 0 });
  });

  it('refuses at once when too many lookups already wait (busy), without asking anybody', async () => {
    const m = manual();
    const resolve = createBoundedResolver({ backend: m.backend, maxInFlight: 1, maxWaiting: 2 });
    const held = [resolve('a.test'), resolve('b.test'), resolve('c.test')];
    await tick();
    await expect(resolve('d.test')).rejects.toMatchObject({ reason: 'busy' });
    expect(m.calls.filter((c) => c === '4:d.test')).toHaveLength(0);
    for (const n of ['a.test', 'b.test', 'c.test']) {
      m.answer(n, ['8.8.8.8']);
      await tick();
    }
    await Promise.all(held);
  });

  it('shares one lookup between callers of the same name', async () => {
    const m = manual();
    const resolve = createBoundedResolver({ backend: m.backend });
    const a = resolve('same.test');
    const b = resolve('same.test');
    await tick();
    expect(m.calls.filter((c) => c === '4:same.test')).toHaveLength(1);
    m.answer('same.test', ['8.8.8.8']);
    expect(await a).toEqual(await b);
  });

  it('takes a waiting lookup out of the line when its only caller gives up, and never asks for it', async () => {
    const m = manual();
    const resolve = createBoundedResolver({ backend: m.backend, maxInFlight: 1 });
    const busy = resolve('busy.test');
    const gone = new AbortController();
    const waiter = resolve('gone.test', gone.signal);
    await tick();
    expect(resolve.stats().waiting).toBe(1);
    gone.abort();
    await expect(waiter).rejects.toMatchObject({ reason: 'aborted' });
    expect(resolve.stats().waiting).toBe(0);
    m.answer('busy.test', ['8.8.8.8']);
    await busy;
    await tick();
    expect(m.calls.some((c) => c.endsWith(':gone.test'))).toBe(false);
    // and a refusal like that is not remembered as a dead name
    expect(resolve.stats().remembered).toBe(0);
  });

  it('keeps a waiting lookup when one of two callers gives up, and answers the other', async () => {
    const m = manual();
    const resolve = createBoundedResolver({ backend: m.backend, maxInFlight: 1 });
    const busy = resolve('busy.test');
    const quits = new AbortController();
    const quitter = resolve('shared.test', quits.signal);
    const stays = resolve('shared.test');
    await tick();
    quits.abort();
    await expect(quitter).rejects.toBeInstanceOf(LookupRefused);
    m.answer('busy.test', ['8.8.8.8']);
    await busy;
    await tick();
    m.answer('shared.test', ['9.9.9.9']);
    expect(await stays).toEqual([{ address: '9.9.9.9', family: 4 }]);
  });

  it('lets a caller stop waiting on a running lookup without cancelling it for others', async () => {
    const m = manual();
    const resolve = createBoundedResolver({ backend: m.backend });
    const quits = new AbortController();
    const quitter = resolve('slow.test', quits.signal);
    const stays = resolve('slow.test');
    await tick();
    quits.abort();
    await expect(quitter).rejects.toMatchObject({ reason: 'aborted' });
    m.answer('slow.test', ['8.8.8.8']);
    expect(await stays).toHaveLength(1);
  });
});

describe('the fetcher does not use the thread pool for names', () => {
  const read = (file: string): string => readFileSync(fileURLToPath(new URL(`../../../sdk/src/safe-fetch/${file}`, import.meta.url)), 'utf8');

  it('safe-fetch.ts never calls dns.lookup', () => {
    const src = read('safe-fetch.ts');
    expect(src).not.toMatch(/from 'node:dns'/);
    expect(src).not.toMatch(/\bdnsLookup\b|\.lookup\(/);
  });

  it('resolver.ts uses the c-ares resolver with one try and a short timeout', () => {
    const src = read('resolver.ts');
    expect(src).toMatch(/from 'node:dns\/promises'/);
    expect(src).toMatch(/new DnsResolver\(\{ timeout: timeoutMs, tries: 1 \}\)/);
    expect(src).not.toMatch(/\blookup\(/);
  });
});
