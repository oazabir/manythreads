import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { apiOn, applyGuarded } from '../../support/stack-browser.ts';
import { DESKTOP, MOBILE, expectWireframe, openPage } from '../support/vt.ts';

/*
 * Account > Bots and Personal and the settings navigation that lists it (PLAN P20-09; own baselines, class W, 1440x900 and 390x844). Baselines are made by
 * the runner on first run and are not committed with this spec. bot-consents.png and bot-consents-390.png. The settings navigation that lists Bots and
 * Personal is part of these frames (the left navigation at 1440 with the page current, the section select on a phone), so it has no plate of its own.
 */
const BOT = (name: string, native: string): string =>
  `---\nschema: 1\nname: ${name}\nrole: Reads what you let it read\nkind: agent\nruntime: hermes\ntriggers:\n  - type: conversation\ncapabilities:\n  native: [${native}]\n---\n\n# ${name}\n`;

let stack: Stack;
test.skip(({ isMobile }) => isMobile, 'desktop project: the viewport is set by the spec');
test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'repo', MANYTHREADS_CLOCK: 'fixed' });
  const omar = await apiOn(playwright, stack, 'omar');
  const nadia = await apiOn(playwright, stack, 'nadia');
  try {
    for (const [slug, name, native] of [
      ['consent-asker', 'Asker', 'messages.post, personal.read'],
      ['consent-quiet', 'Quiet', 'messages.post'],
    ] as const) expect((await applyGuarded(omar, `bots/${slug}/BOT.md`, BOT(name, native), `Add ${name}`)).status).toBe(201);
    await expect
      .poll(async () => (await nadia.get<{ items: Array<{ botSlug: string }> }>('/api/me/bot-consents')).items.filter((i) => i.botSlug.startsWith('consent-')).length, { timeout: 60_000 })
      .toBe(2);
    // one answered (Allowed, with "You changed this <time>"), one left at the default, one that does not ask
    const asker = (await nadia.get<{ items: Array<{ botSlug: string; botId: string }> }>('/api/me/bot-consents')).items.find((i) => i.botSlug === 'consent-asker')!;
    const set = await nadia.ctx.put(`/api/me/bot-consents/${asker.botId}`, { data: { allowed: true }, headers: await nadia.headers() });
    expect(set.status()).toBe(200);
  } finally {
    await omar.ctx.dispose();
    await nadia.ctx.dispose();
  }
});
test.afterAll(async () => {
  await stack?.stop();
});

test('Bots and Personal keeps its layout at 1440 (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'nadia', DESKTOP);
  try {
    await page.goto('/account/bots');
    await expect(page.getByTestId('bot-consent').filter({ hasText: 'Asker' })).toHaveAttribute('data-allowed', 'true');
    await expect(page.getByTestId('bot-consent').filter({ hasText: 'Quiet' })).toHaveAttribute('data-can-ask', 'false');
    await expectWireframe(page, 'bot-consents', [['nav', 'content'], ['page-header', 'title']]);
  } finally {
    await close();
  }
});

test('Bots and Personal keeps its layout on a phone (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'nadia', MOBILE, true);
  try {
    await page.goto('/account/bots');
    await expect(page.getByTestId('bot-consent').filter({ hasText: 'Asker' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expectWireframe(page, 'bot-consents-390', [['nav-select', 'content'], ['page-header', 'title']]);
    await expect(page.getByLabel('Settings section')).toHaveValue('/account/bots');
  } finally {
    await close();
  }
});
