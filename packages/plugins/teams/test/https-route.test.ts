import { GetWorkspaceHttpsResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, personas, type World } from './world.ts';

const { omar, nadia, lena } = personas;
let w: World;
beforeAll(async () => {
  w = await createWorld();
}, 120_000);
afterAll(async () => {
  await w?.close();
});
const ok = <T>(res: { status: number; body: unknown }): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as T;
};

describe('workspace Domain & HTTPS status', () => {
  it('is 404 for a member and a guest, 401 without an actor; an admin gets the shape (no HTTPS configured in tests)', async () => {
    for (const who of [nadia, lena]) expect((await w.call(who, 'GET', '/api/workspace/https')).status).toBe(404);
    expect((await w.call(null, 'GET', '/api/workspace/https')).status).toBe(401);
    const body = GetWorkspaceHttpsResponse.parse(ok(await w.call(omar, 'GET', '/api/workspace/https')));
    expect(body.mode).toBe('none');
    expect(body.checks.map((c) => c.id)).toEqual(['public-url', 'wildcard', 'client-ip', 'proxy-match']);
  });
});
