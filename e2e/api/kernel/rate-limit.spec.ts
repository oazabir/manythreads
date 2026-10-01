import { expect, test } from '@playwright/test';
import { ErrorEnvelope } from '@majlis/shared';
import { devActor, TEST } from '../support/api.ts';

test('100 calls on a 60/min route: exactly 60 pass, 40 are 429 rate_limited', async ({ request }) => {
  const headers = devActor(); // a fresh actor, so the counter starts at zero
  const statuses: number[] = [];
  let lastLimited: unknown;
  for (let i = 0; i < 100; i++) {
    const res = await request.get(`${TEST}/limited`, { headers });
    statuses.push(res.status());
    if (res.status() === 429) lastLimited = await res.json();
  }
  expect(statuses.filter((s) => s === 200)).toHaveLength(60);
  expect(statuses.filter((s) => s === 429)).toHaveLength(40);
  expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
  expect(ErrorEnvelope.parse(lastLimited).error.code).toBe('rate_limited');
});

test('another caller has its own counter', async ({ request }) => {
  const a = devActor();
  for (let i = 0; i < 61; i++) await request.get(`${TEST}/limited`, { headers: a });
  expect((await request.get(`${TEST}/limited`, { headers: a })).status()).toBe(429);
  expect((await request.get(`${TEST}/limited`, { headers: devActor() })).status()).toBe(200);
});
