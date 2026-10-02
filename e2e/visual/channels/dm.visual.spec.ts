import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { apiOn, postAs, type StackApi } from '../../support/stack-browser.ts';
import { DESKTOP, expectWireframe, openPage } from '../support/vt.ts';

/*
 * The direct message screen (PLAN phase 3 section 5, own baseline, class W; wireframe "Direct message"): the Direct messages section of
 * the sidebar, the header with the people in the conversation and its own search box, the messages and the composer. 1440x900: dm.png.
 */
test.skip(({ isMobile }) => isMobile, 'desktop baseline');

let stack: Stack;
const apis: StackApi[] = [];

test.beforeAll(async ({ playwright }) => {
  stack = await startStack();
  const [nadia, rafi] = [await apiOn(playwright, stack, 'nadia'), await apiOn(playwright, stack, 'rafi')];
  apis.push(nadia, rafi);
  const rafiId = (await rafi.get<{ person: { id: string } }>('/api/session')).person.id;
  const dm = await nadia.post<{ dm: { channel: { id: string } } }>('/api/dms', { personIds: [rafiId] });
  await postAs(rafi, dm.dm.channel.id, 'Check rota?');
  await postAs(nadia, dm.dm.channel.id, 'After standup');
});
test.afterAll(async () => {
  await Promise.all(apis.map((a) => a.ctx.dispose()));
  await stack?.stop();
});

test('the direct message screen matches its baseline (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'nadia', DESKTOP);
  try {
    await page.goto('/t/engineering/threads');
    await page.locator('[data-slot="direct-messages"] a.it').first().click();
    await expect(page.locator('[data-testid="message"]')).toHaveCount(2);
    await expectWireframe(page, 'dm', [['search', 'sidebar'], ['header', 'content']]);
  } finally {
    await close();
  }
});
