import { expect, test } from '@playwright/test';
import { apiOn, openOn } from '../support/stack-browser.ts';
import type { Stack } from '../fixtures/stack.ts';
import { SEED_CONNECTORS, connectorsStack, doorUrl, rows, seededOf, sendWebhook } from './support.ts';

/*
 * A work app calls in (PLAN P16-10, decision D10 and Q10): on seed v16 `#support` has a Zendesk address with a known signing secret and the Ticket watcher bot, whose
 * `webhook` trigger names it. The stand-in sender (tools/fake-saas) signs a `ticket.created` the way Zendesk's documentation says and posts it to our public door.
 * Covered: a good call starts exactly one run of the bot, with no asker; the post lands in `#support` with the "What started this run" card; a repeat is one event,
 * not two runs; people who cannot read the channel get nothing from the origin route; and the card on the page opens and shows the app, the name and the title.
 * The refusals of the door itself (bad signature, old timestamp, unknown address) are in e2e/api/connections/provider-hooks.spec.ts.
 *
 * Written for the integration pass; not run by the coder that wrote it.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout');
test.describe.configure({ mode: 'serial' });

const TITLE = 'Refund not received';
let stack: Stack;
let runId: string;

test.beforeAll(async () => {
  stack = await connectorsStack({ MANYTHREADS_STACK_MEETINGS: '1' });
});
test.afterAll(async () => {
  await stack?.stop();
});

const ticketCreated = (deliveryId?: string) =>
  sendWebhook(stack, {
    provider: 'zendesk',
    url: doorUrl(stack, seededOf(stack).zendeskEndpointId),
    secret: SEED_CONNECTORS.zendesk.secret,
    kind: 'ticket.created',
    title: TITLE,
    ...(deliveryId ? { deliveryId } : {}),
  });

test('a signed ticket.created is accepted, and the Ticket watcher answers once in #support with the run it started', async () => {
  const sent = await ticketCreated('zd-delivery-1');
  expect(sent.responses.map((r) => r.status)).toEqual([200]);

  // the stack's Hermes stand-in answers an arrived event with "Noted a <kind>: <title>."; the post carries the run it belongs to
  const posted = `SELECT meta ->> 'runId' AS run_id FROM app.messages WHERE channel_id = $1 AND meta ->> 'runId' IS NOT NULL AND body LIKE $2`;
  const args = [seededOf(stack).supportChannelId, `%ticket.created: ${TITLE}%`];
  await expect.poll(async () => (await rows(stack, posted, args)).length, { timeout: 150_000, intervals: [1_000, 3_000], message: 'the bot to post in #support' }).toBe(1);
  runId = (await rows<{ run_id: string }>(stack, posted, args))[0]!.run_id;
  // the run was started by the app: it is the one latched run of the delivery, and it has no asker (decision Q10)
  expect(await rows(stack, `SELECT 1 FROM app.webhook_provider_runs WHERE run_id = $1`, [runId])).toHaveLength(1);
  const run = await rows<{ asker_id: string | null }>(stack, `SELECT asker_id FROM app.bot_runs WHERE id = $1`, [runId]);
  expect(run[0]?.asker_id ?? null).toBeNull();
});

test('the same delivery again is one stored event and no second run', async () => {
  const again = await ticketCreated('zd-delivery-1');
  expect(again.responses.map((r) => r.status)).toEqual([200]);
  expect(again.responses[0]?.body ?? '').toContain('duplicate');
  const events = await rows<{ n: string }>(stack, `SELECT count(*)::text AS n FROM app.webhook_provider_events WHERE kind = 'ticket.created' AND delivery_key = 'zd-delivery-1'`);
  expect(events[0]!.n).toBe('1');
  const runs = await rows<{ n: string }>(stack, `SELECT count(*)::text AS n FROM app.webhook_provider_runs`);
  expect(runs[0]!.n).toBe('1');
});

test('the card under the bot’s post says what started the run, opens, closes with Escape, and links only to web addresses', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'sameera', '/t/customer-support/c/support');
  try {
    const card = page.getByTestId('run-origin').first();
    await expect(card).toBeVisible();
    await expect(card).toContainText('What started this run');
    await expect(card).toContainText('Zendesk');
    await expect(card).toContainText(TITLE);
    // closed to begin with
    await expect(page.getByTestId('run-origin-body')).toHaveCount(0);
    await page.getByTestId('run-origin-toggle').first().click();
    const body = page.getByTestId('run-origin-body').first();
    await expect(body).toBeVisible();
    await expect(body).toContainText(SEED_CONNECTORS.zendesk.name);
    const links = body.getByTestId('run-origin-link');
    for (const href of await links.evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''))) expect(href).toMatch(/^https?:\/\//);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('run-origin-body')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('the origin route tells a reader of the channel, and tells nobody else that the run exists', async ({ playwright }) => {
  const sameera = await apiOn(playwright, stack, 'sameera');
  try {
    const origin = await sameera.get<Record<string, unknown>>(`/api/runs/${runId}/origin`);
    const text = JSON.stringify(origin).toLowerCase();
    expect(text).toContain('zendesk');
    expect(text).toContain(TITLE.toLowerCase());
    // the signing secret is in no answer
    expect(JSON.stringify(origin)).not.toContain(SEED_CONNECTORS.zendesk.secret);
  } finally {
    await sameera.ctx.dispose();
  }
  const priya = await apiOn(playwright, stack, 'priya');
  try {
    expect(await priya.status('GET', `/api/runs/${runId}/origin`)).toBe(404);
  } finally {
    await priya.ctx.dispose();
  }
});

test('the signing secret is sealed: it is in no stored event, no message, no event of the log and no page of the channel', async ({ browser, playwright }) => {
  const secret = SEED_CONNECTORS.zendesk.secret;
  expect(await rows(stack, `SELECT 1 FROM app.webhook_provider_events WHERE payload::text LIKE '%' || $1 || '%'`, [secret])).toHaveLength(0);
  expect(await rows(stack, `SELECT 1 FROM app.messages WHERE body LIKE '%' || $1 || '%'`, [secret])).toHaveLength(0);
  expect(await rows(stack, `SELECT 1 FROM app.events WHERE payload::text LIKE '%' || $1 || '%'`, [secret])).toHaveLength(0);
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/customer-support/c/support');
  try {
    await expect(page.getByTestId('run-origin').first()).toBeVisible();
    expect(await page.content()).not.toContain(secret);
  } finally {
    await context.close();
  }
});
