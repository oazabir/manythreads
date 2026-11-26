import { expect, test, type Locator, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { addBot, brainMd, conversationStackEnv } from '../conversations/support.ts';
import { PHONE, apiOn, noSidewaysScroll, openOn, type StackApi } from '../support/stack-browser.ts';

/*
 * PLAN P21-04 (what the first batch left): the composer of a channel checked on a desktop and on a 390 px phone. The text line and the Attach button keep their
 * height and their place when the box gets the cursor (the formatting bar is added above them, P37-01) and a first word (nothing jumps under the reader's thumb),
 * ":smi" opens the emoji list and Tab takes the first one, "@" lists people with a picture and a handle, a long bot name is cut with an ellipsis on one line and
 * keeps its handle in full, the Send control sleeps until there is text, "#" lists channels, and the Ctrl/Cmd chords format the selection. Starts its own stack
 * with one bot whose name is far longer than a row.
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

test('the box and its Attach button keep their height and place when the box gets the cursor and a first word; the formatting bar is a row above them', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await open(browser, playwright, 'nadia', isMobile);
  try {
    // At rest the composer is the text line with Attach beside it. Since P37-01 the formatting bar shows while focus is inside the composer: it is a row added at the top of
    // the box, so the box grows upward by that row and everything under it (the text line, the Attach button) keeps its own height and its distance from the box's bottom.
    const attach = page.getByTestId('composer-attach');
    const cbox = page.locator('.composer .cbox');
    const tools = page.getByTestId('composer-tools');
    await expect(attach).toBeVisible();
    await expect(tools, 'no formatting bar at rest').toHaveCount(0);
    // On the phone the bottom bar steps aside while a text box has the focus (the keyboard is up), so the whole composer slides down by the bar's height once; what must
    // hold is the composer's own shape. On a desktop the composer's bottom edge stays where it is, so the text line and Attach do not move at all.
    type Shape = { box: { y: number; h: number }; attach: { y: number; h: number }; text: { y: number; h: number }; attachFromBottom: number; textFromBottom: number };
    const shape = async (): Promise<Shape> => {
      const [x, a, t] = [await place(cbox), await place(attach), await place(boxOf(page))];
      return { box: x, attach: a, text: t, attachFromBottom: x.y + x.h - (a.y + a.h), textFromBottom: x.y + x.h - (t.y + t.h) };
    };
    const own = (s: Shape): unknown => ({ attachH: s.attach.h, textH: s.text.h, attachFromBottom: s.attachFromBottom, textFromBottom: s.textFromBottom });
    const before = await shape();
    await boxOf(page).click();
    await expect(boxOf(page)).toBeFocused();
    await expect(tools, 'the formatting bar shows with the cursor in the box').toBeVisible();
    const settled = await shape();
    expect(own(settled), 'the text line and Attach keep their height and their place in the box').toEqual(own(before));
    // the bar is one row above the text, and it is the whole of what the box grew by
    const bar = await place(tools);
    expect(bar.y + bar.h, 'the bar sits above the text line').toBeLessThanOrEqual(settled.text.y);
    expect(Math.abs(settled.box.h - before.box.h - bar.h), 'the box grew by the bar and nothing else').toBeLessThanOrEqual(2);
    if (!isMobile) {
      expect(settled.attach, 'Attach does not move on a desktop').toEqual(before.attach);
      expect(settled.text, 'the text line does not move on a desktop').toEqual(before.text);
      expect(settled.box.y + settled.box.h, 'the box grows upward: its bottom edge stays').toEqual(before.box.y + before.box.h);
    }
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
    // @channel and @here read as names, whole and in the same font as the sentence beside them, like the people rows (P34-03)
    const everyone = list.getByRole('option').filter({ hasText: '@channel' });
    const everyoneName = everyone.locator('.pk-name');
    await expect(everyoneName).toHaveText('@channel');
    expect(await everyoneName.evaluate((el) => el.scrollWidth <= el.clientWidth), '@channel is not cut').toBe(true);
    const fonts = await everyone.evaluate((el) => [el.querySelector('.pk-name'), el.querySelector('.pk-hint')].map((n) => (n ? getComputedStyle(n).fontFamily : '')));
    expect(fonts[0]).toBe(fonts[1]);

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

test('the Send control is one square that is quiet until there is text, and "#" lists the channels', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await open(browser, playwright, 'nadia', isMobile);
  try {
    const box = boxOf(page);
    const send = page.getByRole('button', { name: 'Send', exact: true });
    await expect(send).toBeDisabled();
    await expect(send).not.toHaveClass(/ready/);
    const empty = (await send.boundingBox())!;
    await box.fill('hello');
    await expect(send).toBeEnabled();
    await expect(send).toHaveClass(/ready/);
    // one size with or without text: only the colour changes (P34-03)
    const ready = (await send.boundingBox())!;
    expect([ready.width, ready.height]).toEqual([empty.width, empty.height]);
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
