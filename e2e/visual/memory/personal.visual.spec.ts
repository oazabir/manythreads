import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { apiOn, channelsOf, postAs } from '../../support/stack-browser.ts';
import { dropFile, fact, putMemory, settled } from '../../knowledge/personal-support.ts';
import { DESKTOP, MOBILE, expectWireframe, openPage } from '../support/vt.ts';

/*
 * Personal memory, knowledge and the ways in (PLAN P20-04; own baselines, class W, 1440x900 and 390x844). Baselines are made by the runner on first
 * run and are not committed with this spec. Times carry data-vt-mask (the Time component), so only the layout is compared.
 *   memory-concepts.png / -390      /memory, the files of Nadia's memory with one open (stale chip, trust chips)
 *   memory-file-history.png / -390  the same file with Earlier versions open
 *   memory-inbox.png / -390         /memory?tab=inbox with a filed note and a held bundle
 *   knowledge-empty.png / -390      /knowledge, no base yet (Rafi)
 *   knowledge-base.png / -390       /knowledge with one base, one document and hits for a search
 *   team-knowledge.png / -390       /t/engineering/knowledge
 *   send-to-memory.png / -390       the Send to memory dialog with "My own memory" chosen
 *   account-menu.png                the account menu with Your memory and Your knowledge (desktop; on a phone the drawer holds it: account-menu-390.png)
 *   (the settings navigation with Bots and Personal is in ../settings/bot-consents.visual.spec.ts: bot-consents.png and -390)
 */
const PAGE = [['page-header', 'title']];
const SHELL = [['team-switch', 'search', 'sidebar', 'content'], ...PAGE];
const PHONE_ORDER = [['content'], ...PAGE];
const BODY = 'Nadia drinks green tea, no sugar, in the morning.';
const DOC = '# Roaster notes\n\nThe espresso beans are roasted on Elm Street every Tuesday.\n';

let stack: Stack;
test.skip(({ isMobile }) => isMobile, 'desktop project: the viewport is set by the spec');
test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'repo', MANYTHREADS_CLOCK: 'fixed' });
  const nadia = await apiOn(playwright, stack, 'nadia');
  try {
    const v1 = await putMemory(nadia, 'memory/facts/tea.md', fact('Tea order', BODY));
    await putMemory(nadia, 'memory/facts/tea.md', fact('Tea order', `${BODY} Oolong on Fridays.`), v1.file.versionNo);
    await putMemory(nadia, 'memory/facts/plan.md', fact('Release plan', 'Ship on Friday.'));
    const note = await nadia.ctx.post('/api/me/inbox/notes', { data: { title: 'Standup, Monday', text: 'The release moves to Friday.' }, headers: await nadia.headers() });
    const noteId = ((await note.json()) as { item: { id: string } }).item.id;
    await settled(nadia, noteId, ['filed']);
    const bundle = await dropFile(nadia, 'someones-memory.zip', 'PK\u0003\u0004 not really a zip', 'application/zip');
    await settled(nadia, bundle.id, ['held']);
    await nadia.post('/api/me/knowledge', { slug: 'roaster', name: 'Roaster' });
    const up = await nadia.ctx.post('/api/me/knowledge/roaster/documents?name=roaster.md', {
      headers: { ...(await nadia.headers()), 'content-type': 'text/markdown', 'x-file-name': 'roaster.md' },
      data: Buffer.from(DOC),
    });
    expect(up.status(), await up.text()).toBeLessThan(300);
    await postAs(nadia, (await channelsOf(nadia))['general']!, 'Decision: the release moves to Friday.');
  } finally {
    await nadia.ctx.dispose();
  }
});
test.afterAll(async () => {
  await stack?.stop();
});

for (const [suffix, viewport, mobile] of [
  ['', DESKTOP, false],
  ['-390', MOBILE, true],
] as const) {
  const order = mobile ? PHONE_ORDER : SHELL;

  test(`/memory keeps its layout${suffix || ' at 1440'} (W)`, async ({ browser }) => {
    const { page, close } = await openPage(browser, stack, 'nadia', viewport, mobile);
    try {
      await page.goto('/memory');
      await expect(page.getByTestId('personal-concept-row')).toHaveCount(2);
      await page.getByTestId('personal-concept-row').filter({ hasText: 'Tea order' }).click();
      await expect(page.getByTestId('personal-file-text')).toContainText('Oolong');
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await expectWireframe(page, `memory-concepts${suffix}`, order);
      await page.getByTestId('personal-file-history').click();
      await expect(page.getByTestId('personal-file-version-row')).toHaveCount(2);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await expectWireframe(page, `memory-file-history${suffix}`, order);
    } finally {
      await close();
    }
  });

  test(`/memory?tab=inbox keeps its layout${suffix || ' at 1440'} (W)`, async ({ browser }) => {
    const { page, close } = await openPage(browser, stack, 'nadia', viewport, mobile);
    try {
      await page.goto('/memory?tab=inbox');
      await expect(page.getByTestId('personal-inbox-item')).toHaveCount(2);
      await expect(page.getByTestId('personal-inbox-item').filter({ hasText: 'someones-memory.zip' })).toHaveAttribute('data-state', 'held');
      await expectWireframe(page, `memory-inbox${suffix}`, order);
    } finally {
      await close();
    }
  });

  test(`/knowledge keeps its layout empty and with a base${suffix || ' at 1440'} (W)`, async ({ browser }) => {
    const rafi = await openPage(browser, stack, 'rafi', viewport, mobile);
    try {
      await rafi.page.goto('/knowledge');
      await expect(rafi.page.getByTestId('personal-knowledge-empty')).toBeVisible();
      await expectWireframe(rafi.page, `knowledge-empty${suffix}`, order);
    } finally {
      await rafi.close();
    }
    const { page, close } = await openPage(browser, stack, 'nadia', viewport, mobile);
    try {
      await page.goto('/knowledge?base=roaster');
      await expect(page.getByTestId('personal-base-doc')).toHaveCount(1);
      await page.getByTestId('personal-base-question').fill('when are the espresso beans roasted?');
      await page.getByTestId('personal-base-search').click();
      await expect(page.getByTestId('personal-base-hit').first()).toBeVisible();
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await expectWireframe(page, `knowledge-base${suffix}`, order);
    } finally {
      await close();
    }
  });

  test(`/t/engineering/knowledge keeps its layout${suffix || ' at 1440'} (W)`, async ({ browser }) => {
    const { page, close } = await openPage(browser, stack, 'nadia', viewport, mobile);
    try {
      await page.goto('/t/engineering/knowledge');
      await expect(page.getByTestId('team-knowledge').or(page.getByTestId('team-knowledge-empty'))).toBeVisible();
      await expectWireframe(page, `team-knowledge${suffix}`, order);
    } finally {
      await close();
    }
  });

  test(`the Send to memory dialog keeps its layout${suffix || ' at 1440'} (W)`, async ({ browser }) => {
    const { page, close } = await openPage(browser, stack, 'nadia', viewport, mobile);
    try {
      await page.goto('/t/engineering/c/general');
      const message = page.getByTestId('message').filter({ hasText: 'the release moves to Friday' }).first();
      await message.hover();
      await message.getByRole('button', { name: 'More actions' }).click();
      await page.getByTestId('send-to-memory').click();
      await expect(page.getByTestId('send-to-memory-dialog')).toBeVisible();
      await page.getByTestId('send-to-memory-target-personal').check();
      await expect(page.getByTestId('send-to-memory-help-personal')).toBeVisible();
      await expectWireframe(page, `send-to-memory${suffix}`, mobile ? [['content']] : [['team-switch', 'content']]);
    } finally {
      await close();
    }
  });
}

test('the account menu with Your memory and Your knowledge keeps its layout at 1440 (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'nadia', DESKTOP);
  try {
    await page.goto('/memory');
    await page.getByRole('button', { name: 'Account menu' }).click();
    await expect(page.getByTestId('menu-my-memory')).toBeVisible();
    await expectWireframe(page, 'account-menu', [['team-switch', 'search', 'sidebar', 'content']]);
  } finally {
    await close();
  }
});

test('the account menu keeps its layout on a phone, in the drawer (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'nadia', MOBILE, true);
  try {
    await page.goto('/memory');
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('button', { name: 'Account menu' }).click();
    await expect(page.getByTestId('menu-my-memory')).toBeInViewport();
    await expectWireframe(page, 'account-menu-390', [['content']]);
  } finally {
    await close();
  }
});
