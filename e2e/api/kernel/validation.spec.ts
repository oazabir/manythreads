import { expect, test } from '@playwright/test';
import { ErrorEnvelope } from '@manythreads/shared';
import { TEST } from '../support/api.ts';

test('a bad body gives 400 validation_failed with the field path, a good one 200', async ({ request }) => {
  const bad = await request.post(`${TEST}/echo`, { data: { message: 42 } });
  expect(bad.status()).toBe(400);
  const env = ErrorEnvelope.parse(await bad.json());
  expect(env.error.code).toBe('validation_failed');
  expect(env.error.path).toEqual(['message']);

  const extra = await request.post(`${TEST}/echo`, { data: { message: 'hi', surprise: true } });
  expect(extra.status()).toBe(400);

  const good = await request.post(`${TEST}/echo`, { data: { message: 'hi', count: 2 } });
  expect(good.status()).toBe(200);
  expect(await good.json()).toEqual({ echoed: 'hi', count: 2 });
});

test('unknown routes use the error envelope', async ({ request }) => {
  const res = await request.get('/nope');
  expect(res.status()).toBe(404);
  expect(ErrorEnvelope.parse(await res.json()).error.code).toBe('not_found');
});
