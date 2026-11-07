import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, apiOn, applyGuarded, noSidewaysScroll, openOn } from '../support/stack-browser.ts';

/*
 * Account > Bots and Personal (PLAN P20-09, D10): which bots may read a person's Personal space. Brain is allowed until the person says no; every other bot
 * needs the `personal.read` capability in its BOT.md AND the person's own yes. A bot that does not ask (`canAsk` false) cannot be allowed at all, on the page
 * or through the API. The answer is the person's own: it survives a reload and is not shared with another person. Own stack, in order.
 */
test.describe.configure({ mode: 'serial' });

let stack: Stack;
test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'repo' });
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    for (const [slug, name, native] of [
      ['consent-asker', 'Asker', 'messages.post, personal.read'],
      ['consent-quiet', 'Quiet', 'messages.post'],
    ] as const) {
      const md = `---\nschema: 1\nname: ${name}\nrole: Tests the consent page\nkind: agent\nruntime: hermes\ntriggers:\n  - type: conversation\ncapabilities:\n  native: [${native}]\n---\n\n# ${name}\n`;
      const res = await applyGuarded(omar, `bots/${slug}/BOT.md`, md, `Add ${name}`);
      expect(res.status, res.text).toBe(201);
    }
  } finally {
    await omar.ctx.dispose();
  }
});
test.afterAll(async () => {
  await stack?.stop();
});

interface ConsentJson {
  botId: string;
  botSlug: string;
  canAsk: boolean;
  allowed: boolean;
  isDefault: boolean;
}

/** The consents of the persona, once the loader has read both new bots. */
async function consentsOf(playwright: Parameters<typeof apiOn>[0], who: 'nadia' | 'rafi' | 'lena'): Promise<ConsentJson[]> {
  const api = await apiOn(playwright, stack, who);
  try {
    let items: ConsentJson[] = [];
    await expect
      .poll(
        async () => {
          items = (await api.get<{ items: ConsentJson[] }>('/api/me/bot-consents')).items;
          return ['consent-asker', 'consent-quiet'].every((s) => items.some((i) => i.botSlug === s));
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    return items;
  } finally {
    await api.ctx.dispose();
  }
}

const rowOf = (page: import('@playwright/test').Page, slug: string) => page.locator(`[data-testid="bot-consent"][data-bot="${slug}"]`);

test('a bot that asks starts as "not allowed"; Nadia allows it, it stays allowed after a reload, and she can turn it off', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'desktop layout; the phone has its own test below');
  await consentsOf(playwright, 'nadia');
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/account/bots');
  try {
    await expect(page.getByRole('heading', { level: 1, name: 'Bots that may read your Personal space' })).toBeVisible();
    await expect(page.getByTestId('bot-consents')).toBeVisible();
    const asker = rowOf(page, 'consent-asker');
    await expect(asker).toHaveAttribute('data-can-ask', 'true');
    await expect(asker).toHaveAttribute('data-allowed', 'false');
    await expect(asker.getByTestId('bot-consent-state')).toHaveText('Not allowed');
    await expect(asker.getByTestId('bot-consent-sentence')).toContainText('Cannot read your Personal space until you allow it');

    await asker.getByTestId('bot-consent-allow').click();
    await expect(asker).toHaveAttribute('data-allowed', 'true');
    await expect(asker.getByTestId('bot-consent-state')).toHaveText('Allowed');
    await expect(asker.getByTestId('bot-consent-turn-off')).toBeVisible();
    await expect(asker.getByTestId('bot-consent-sentence')).toContainText('You changed this');

    // saved on the server, not only drawn
    await page.reload();
    await expect(rowOf(page, 'consent-asker')).toHaveAttribute('data-allowed', 'true');

    await rowOf(page, 'consent-asker').getByTestId('bot-consent-turn-off').click();
    await expect(rowOf(page, 'consent-asker')).toHaveAttribute('data-allowed', 'false');
    await page.reload();
    await expect(rowOf(page, 'consent-asker')).toHaveAttribute('data-allowed', 'false');
    await expect(rowOf(page, 'consent-asker').getByTestId('bot-consent-sentence')).toContainText('You turned it off');
  } finally {
    await context.close();
  }
});

test('a bot that does not ask cannot be allowed: the button is off and the server refuses', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'desktop layout');
  const items = await consentsOf(playwright, 'nadia');
  const quiet = items.find((i) => i.botSlug === 'consent-quiet')!;
  expect(quiet).toMatchObject({ canAsk: false, allowed: false });
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/account/bots');
  const api = await apiOn(playwright, stack, 'nadia');
  try {
    const row = rowOf(page, 'consent-quiet');
    await expect(row).toHaveAttribute('data-can-ask', 'false');
    await expect(row.getByTestId('bot-consent-allow')).toBeDisabled();
    await expect(row.getByTestId('bot-consent-sentence')).toContainText('not set up to ask for your Personal space');

    const res = await api.ctx.put(`/api/me/bot-consents/${quiet.botId}`, { data: { allowed: true }, headers: await api.headers() });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
    const after = (await api.get<{ items: ConsentJson[] }>('/api/me/bot-consents')).items.find((i) => i.botSlug === 'consent-quiet');
    expect(after?.allowed).toBe(false);
  } finally {
    await context.close();
    await api.ctx.dispose();
  }
});

test('one person’s answer is not another’s', async ({ playwright }) => {
  const nadia = await apiOn(playwright, stack, 'nadia');
  const rafi = await apiOn(playwright, stack, 'rafi');
  try {
    const asker = (await consentsOf(playwright, 'rafi')).find((i) => i.botSlug === 'consent-asker')!;
    const set = await nadia.ctx.put(`/api/me/bot-consents/${asker.botId}`, { data: { allowed: true }, headers: await nadia.headers() });
    expect(set.status()).toBe(200);
    const seen = (await rafi.get<{ items: ConsentJson[] }>('/api/me/bot-consents')).items.find((i) => i.botSlug === 'consent-asker');
    expect(seen).toMatchObject({ allowed: false, isDefault: true });
  } finally {
    await nadia.ctx.dispose();
    await rafi.ctx.dispose();
  }
});

test('Brain is allowed until the person says no, and the answer survives a reload', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'desktop layout');
  const items = await consentsOf(playwright, 'nadia');
  const brain = items.find((i) => i.botSlug === 'brain');
  test.skip(!brain, 'the workspace Brain bot is not in this build yet (bots 0027), so there is no default-on row to test');
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/account/bots');
  try {
    const row = rowOf(page, 'brain');
    await expect(row).toHaveAttribute('data-allowed', 'true');
    await expect(row.getByTestId('bot-consent-sentence')).toContainText('default for Brain');
    await row.getByTestId('bot-consent-turn-off').click();
    await expect(row).toHaveAttribute('data-allowed', 'false');
    await page.reload();
    await expect(rowOf(page, 'brain')).toHaveAttribute('data-allowed', 'false');
    await rowOf(page, 'brain').getByTestId('bot-consent-allow').click();
    await expect(rowOf(page, 'brain')).toHaveAttribute('data-allowed', 'true');
    await page.reload();
    await expect(rowOf(page, 'brain')).toHaveAttribute('data-allowed', 'true');
  } finally {
    await context.close();
  }
});

test('Lena, a guest, has no list and the page says so once', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'desktop layout');
  const api = await apiOn(playwright, stack, 'lena');
  const { page, context } = await openOn(browser, playwright, stack, 'lena', '/account/bots');
  try {
    expect(await api.status('GET', '/api/me/bot-consents')).toBe(403);
    await expect(page.getByTestId('bot-consent')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  } finally {
    await context.close();
    await api.ctx.dispose();
  }
});

test('on a phone the rows fit the width and the buttons are reachable', async ({ browser, playwright }) => {
  await consentsOf(playwright, 'nadia');
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/account/bots', { viewport: PHONE, mobile: true });
  try {
    await expect(rowOf(page, 'consent-asker')).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
    await expect(rowOf(page, 'consent-asker').locator('button')).toBeInViewport();
    // the settings select lists the page
    const values = await page.locator('#settings-section option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(values).toContain('/account/bots');
  } finally {
    await context.close();
  }
});
