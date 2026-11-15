/* eslint-disable @typescript-eslint/no-explicit-any -- these tests read JSON documents of many shapes */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { relaxedRateLimiter } from '@manythreads/test-utils';
import { createWorld, personas, type World } from './world.ts';

// The enrolment lock (not the per-minute limit: that one is switched off here) with a clock the test moves (P26 review T5): ten wrong codes lock an address, a right code is refused while it is locked, and the lock lets go after fifteen
// minutes with no real waiting. The code's own expiry is the database's clock and is not moved by this one.

const { omar } = personas;
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let w: World;
let at = Date.parse('2030-01-01T00:00:00Z');
const HOST = { hostname: 'box-1', system: 'Ubuntu 24.04', arch: 'x64' };

beforeAll(async () => {
  w = await createWorld({ now: () => new Date(at), limiter: relaxedRateLimiter() });
}, 120_000);
afterAll(async () => {
  await w?.close();
});

const enrol = (code: string) => w.call<any>(null, 'POST', '/api/bridge/enrol', { code, host: HOST, agents: [{ agent: 'codex', version: '1' }], bridgeVersion: '1.2.3', allowFullAccess: false });
const wrong = (i: number): string => `mte_${String(i).padStart(40, '3')}`;

describe('the enrolment lock', () => {
  it('locks an address after ten wrong codes, refuses a right code while it holds, and lets go after fifteen minutes', async () => {
    const made = await w.call<any>(omar, 'POST', '/api/admin/bot-servers', { name: 'clock-1', label: 'Clock' });
    expect(made.status).toBe(201);
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await enrol(wrong(i))).status);
    expect(statuses.every((s) => s === 404)).toBe(true);
    expect((await enrol(wrong(11))).status).toBe(429);
    expect((await enrol(made.body.code)).status).toBe(429);
    // fourteen minutes: still locked
    at += 14 * 60_000;
    expect((await enrol(made.body.code)).status).toBe(429);
    // past fifteen: the address is free, and the right code works
    at += 2 * 60_000;
    const done = await enrol(made.body.code);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.key).toMatch(/^mtb_[0-9a-f]{64}$/);
  });

  it('the failures age out: nine wrong codes, a quarter of an hour, nine more is not a lock', async () => {
    // everything the first test left behind is old
    at += 20 * 60_000;
    for (let i = 20; i < 29; i++) expect((await enrol(wrong(i))).status).toBe(404);
    at += 16 * 60_000;
    for (let i = 30; i < 39; i++) expect((await enrol(wrong(i))).status).toBe(404);
  });
});
