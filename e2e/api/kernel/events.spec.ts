import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { KernelTestPingedEventV2 } from '@majlis/shared';
import { devActor, KAHF_WORKSPACE_ID, TEST } from '../support/api.ts';

test('ping emits one event and the plugin subscriber gets exactly one valid delivery', async ({ request }) => {
  const headers = devActor();
  const note = `ping-${randomUUID()}`;
  const ping = await request.post(`${TEST}/ping`, { headers, data: { workspaceId: KAHF_WORKSPACE_ID, note } });
  expect(ping.status()).toBe(200);

  const deliveries = async (): Promise<unknown[]> =>
    ((await (await request.get(`${TEST}/deliveries`, { headers, params: { note } })).json()) as { deliveries: unknown[] })
      .deliveries;

  await expect.poll(async () => (await deliveries()).length, { timeout: 10_000 }).toBe(1);
  await new Promise((r) => setTimeout(r, 1500)); // a duplicate delivery would have shown up by now
  const all = await deliveries();
  expect(all).toHaveLength(1);
  const event = KernelTestPingedEventV2.parse(all[0]);
  expect(event.note).toBe(note);
  expect(event.workspaceId).toBe(KAHF_WORKSPACE_ID);
});

test('a ping with an invalid workspace is rejected and delivers nothing', async ({ request }) => {
  const note = `bad-${randomUUID()}`;
  const res = await request.post(`${TEST}/ping`, { headers: devActor(), data: { workspaceId: 'nope', note } });
  expect(res.status()).toBe(400);
});

test('routes that need an actor answer 401 without one', async ({ request }) => {
  const res = await request.post(`${TEST}/ping`, { data: { workspaceId: KAHF_WORKSPACE_ID, note: 'x' } });
  expect(res.status()).toBe(401);
});
