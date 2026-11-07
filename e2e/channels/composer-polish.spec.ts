import { expect, test, type Locator, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { addBot, brainMd, conversationStackEnv } from '../conversations/support.ts';
import { PHONE, apiOn, noSidewaysScroll, openOn, type StackApi } from '../support/stack-browser.ts';

/*
 * PLAN P21-04 (what the first batch left): the composer of a channel checked on a desktop and on a 390 px phone. The toolbar keeps its height and its place
 * when the box gets the cursor and text (nothing jumps under the reader's thumb), ":smi" opens the emoji list and Tab takes the first one, "@" lists people with
 * a picture and a handle, a long bot name is cut with an ellipsis on one line and keeps its handle in full, the Send control sleeps until there is text, "#"
 * lists channels, and the Ctrl/Cmd chords format the selection. Starts its own stack with one bot whose name is far longer than a row.
 */
test.use({ actionTimeout: 10_000 });
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let omar: StackApi;
const LONG_NAME = 'Release Manager For The Entire Platform Engineering Organisation';
const LONG_SLUG = 'release-manager';

test.beforeAll(async ({ playwright }) => {
  stack = await startStack(conversationStackEnv());
  omar = await apiOn(playwright, stack, 'omar');
  await addBot(stack, omar, LONG_SLUG, brainMd(['Hello']).replace('name: Brain', `name: ${LONG_NAME}`));
});
test.afterAll(async () => {
  await omar?.ctx.dispose();
  await stack?.stop();
});

const boxOf = (page: Page): Locator => page.getByRole('textbox', { name: 'Message #dev' });

async function open(browser: Parameters<typeof openOn>[0], playwright: Parameters<typeof openOn>[1], who: string, mobile: boolean) {
  const { page, context } = await openOn(browser, playwright, stack, who, '/t/engineering/c/dev', mobile ? { viewport: PHONE, mobile: true } : {});
  await expect(boxOf(page)).toBeVisible();
  return { page, context };
}

const place = async (loc: Locator): Promise<{ y: number; h: number }> => {
  const b = await loc.boundingBox();
  return { y: Math.round(b?.y ?? -1), h: Math.round(b?.height ?? -1) };
};

test('the toolbar keeps its height and its place when the box gets the cursor and a first word', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await open(browser, playwright, 'nadia', isMobile);
  try {
    const bar = page.getByTestId('composer-tools');
    const cbox = page.locator('.composer .cbox');
    await expect(bar).toBeVisible();
    // On the phone the bottom bar steps aside while a text box has the focus (the keyboard is up), so the whole composer slides down by the bar's
    // height once; what must hold is the composer's own shape: its heights and the gap between the toolbar and the box. On a desktop nothing moves at all.
    const shape = async (): Promise<{ bar: { y: number; h: number }; box: { y: number; h: number }; gap: number }> => {
      const [b, x] = [await place(bar), await place(cbox)];
      return { bar: b, box: x, gap: b.y - x.y };
    };
    const own = (s: Awaited<ReturnType<typeof shape>>): unknown => ({ barH: s.bar.h, boxH: s.box.h, gap: s.gap });
    const before = await shape();
    await boxOf(page).click();
    await expect(boxOf(page)).toBeFocused();
    const settled = await shape();
    expect(own(settled), 'focus changes no height and no gap').toEqual(own(before));
    if (!isMobile) expect(settled, 'focus moves nothing on a desktop').toEqual(before);
    await boxOf(page).pressSequentially('first');
    const typed = await shape();
    expect(typed, 'one line of text moves nothing').toEqual(settled);
    await boxOf(page).fill('');
    if (isMobile) expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});

test('":smi" opens the emoji list and Tab takes the first one without sending anything', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await open(browser, playwright, 'nadia', isMobile);
  try {
    const box = boxOf(page);
    const list = page.getByRole('listbox', { name: 'Emoji' });
    await box.fill('so happy :smi');
    await expect(list).toBeVisible();
    const first = await list.getByRole('option').first().getAttribute('data-emoji');
    expect(first).toBeTruthy();
    await box.press('Tab');
    await expect(list).toHaveCount(0);
    await expect(box).toHaveValue(new RegExp(`^so happy ${first ?? ''}`));
    await expect(box).not.toHaveValue(/:smi/);
    await expect(page.locator('[data-testid="message"]').filter({ hasText: 'so happy' })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('"@" lists people with a picture and a handle; a long bot name is cut on one line and keeps its handle', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await open(browser, playwright, 'nadia', isMobile);
  try {
    const box = boxOf(page);
    await box.fill('@');
    const list = page.getByRole('listbox', { name: 'People' });
    await expect(list).toBeVisible();
    // a person: a picture, the name, and the handle after it
    const person = list.getByRole('option').filter({ hasText: 'Omar' }).first();
    await expect(person.locator('.av').first()).toBeVisible();
    await expect(person.locator('.pk-hint')).toHaveText(/^@\S+/);

    // the long-named bot: one line, an ellipsis in the name, the handle whole, the row inside the list
    await box.fill('@rel');
    const row = list.getByRole('option').filter({ hasText: LONG_NAME.slice(0, 20) });
    await expect(row).toHaveCount(1);
    await expect(row.locator('.pk-badge.bot')).toHaveText('Bot');
    const hint = row.locator('.pk-hint');
    await expect(hint).toHaveText(`@${LONG_SLUG}`);
    const name = row.locator('.pk-name');
    const cut = await name.evaluate((el) => ({ over: el.scrollWidth > el.clientWidth, style: getComputedStyle(el).textOverflow, wrap: getComputedStyle(el).whiteSpace }));
    expect(cut).toEqual({ over: true, style: 'ellipsis', wrap: 'nowrap' });
    const [r, h, l, n] = await Promise.all([row.boundingBox(), hint.boundingBox(), list.boundingBox(), name.boundingBox()]);
    expect(n!.height, 'one line, not a wrapped name').toBeLessThan(30);
    expect(r!.height, 'a row is one touch target tall').toBeLessThan(48);
    expect(h!.x + h!.width, 'the handle ends inside the row').toBeLessThanOrEqual(r!.x + r!.width + 0.5);
    expect(await hint.evaluate((el) => el.scrollWidth <= el.clientWidth), 'the handle is not cut').toBe(true);
    expect(n!.x + n!.width, 'the name stops before the handle').toBeLessThanOrEqual(h!.x + 0.5);
    expect(l!.x + l!.width).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 0.5);
    if (isMobile) expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});

test('the Send control is an icon that sleeps until there is text, and "#" lists the channels', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await open(browser, playwright, 'nadia', isMobile);
  try {
    const box = boxOf(page);
    const send = page.getByRole('button', { name: 'Send', exact: true });
    await expect(send).toBeDisabled();
    await expect(send).not.toHaveClass(/ready/);
    await box.fill('hello');
    await expect(send).toBeEnabled();
    await expect(send).toHaveClass(/ready/);
    await box.fill('   ');
    await expect(send).toBeDisabled();
    await box.fill('');

    await box.fill('#');
    await expect(page.getByRole('listbox', { name: 'Channels' })).toBeVisible();
    await expect(page.getByTestId('picker-heading').first()).toHaveText('Channels');
    await expect(page.getByRole('listbox', { name: 'Channels' }).getByRole('option', { name: /#dev/ })).toBeVisible();
    await box.fill('');
  } finally {
    await context.close();
  }
});

test('Ctrl+B, Ctrl+I and Ctrl+K format the selection from the keyboard', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'keyboard chords; the phone formats with the bar');
  const { page, context } = await open(browser, playwright, 'nadia', false);
  try {
    const box = boxOf(page);
    const select = async (from: number, to: number): Promise<void> => {
      await box.evaluate((el: HTMLTextAreaElement, r: [number, number]) => el.setSelectionRange(r[0], r[1]), [from, to] as [number, number]);
    };
    await box.fill('word');
    await select(0, 4);
    await box.press('Control+b');
    await expect(box).toHaveValue('**word**');
    await box.fill('word');
    await select(0, 4);
    await box.press('Control+i');
    await expect(box).toHaveValue('*word*');
    await box.fill('docs');
    await select(0, 4);
    await box.press('Control+k');
    await expect(box).toHaveValue('[docs](https://)');
  } finally {
    await context.close();
  }
});
