import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { ListLinksResponse } from '@manythreads/shared';
import { PERSONA_EMAILS, TEST_AUTH_TOKEN } from '../support/api.ts';

// P3-04 over HTTP: the route, its validation and its sign-in rule. Resolvers are registered by the owning plugins
// (messages, tasks, pages), so an entity nobody can summarise yet lists as empty; the plugin tests cover resolved summaries and RLS.

test('GET /api/links answers 401 without a session', async ({ request }) => {
  expect((await request.get(`/api/links?type=message&id=${randomUUID()}`)).status()).toBe(401);
});

test('an entity with no links lists as empty; bad input is a 400 with the standard envelope', async ({ playwright, baseURL }) => {
  const ctx = await playwright.request.newContext({ baseURL: baseURL ?? '' });
  const signIn = await ctx.post('/api/test/session', { data: { email: PERSONA_EMAILS.nadia }, headers: { 'x-test-auth': TEST_AUTH_TOKEN } });
  expect(signIn.status()).toBe(200);
  const res = await ctx.get(`/api/links?type=message&id=${randomUUID()}&direction=both`);
  expect(res.status()).toBe(200);
  expect(ListLinksResponse.parse(await res.json())).toEqual({ links: [] });
  for (const q of ['type=event&id=' + randomUUID(), 'type=message&id=not-a-uuid', 'type=message', `type=message&id=${randomUUID()}&direction=up`, `type=message&id=${randomUUID()}&extra=1`]) {
    const bad = await ctx.get(`/api/links?${q}`);
    expect(bad.status(), q).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('validation_failed');
  }
  await ctx.dispose();
});
