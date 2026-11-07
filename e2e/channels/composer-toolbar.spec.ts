import { expect, test, type Locator, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { addBot, brainMd, conversationStackEnv } from '../conversations/support.ts';
import { PHONE, apiOn, channelsOf, noSidewaysScroll, openOn, type StackApi } from '../support/stack-browser.ts';

/*
 * PLAN P21-04, the composer of a channel: the toolbar is always drawn (a bar of buttons whose tooltips name their shortcut), Ctrl/Cmd+B, I, K and Ctrl+Shift+X
 * run the tools from inside the box, ":" and two letters offers emoji (and a time or an address does not), "@" lists People under headings (Everyone, People,
 * Bots, Groups) with Everyone left out for a guest, and on a phone the rarer tools sit behind one "Aa" button. The send control is an icon with a name.
 * Starts its own stack (a guest gets a post grant, a bot is added). Groups are covered by role-mention-picker.spec; the Chat screen's own box by
 * conversations/chat.spec.
 */
test.use({ actionTimeout: 10_000 });
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let omar: StackApi;
let channels: Record<string, string> = {};

test.beforeAll(async ({ playwright }) => {
  stack = await startStack(conversationStackEnv());
  omar = await apiOn(playwright, stack, 'omar');
  channels = await channelsOf(omar);
  await addBot(stack, omar, 'brain', brainMd(['What is blocking the release?']));
  // Lena is a guest with a read grant on #releases (seed); this spec gives her the right to post there, which is what puts a message box in front of her
  await stack.sql(
    `UPDATE app.acl_entries SET permission = 'post'
      WHERE resource_type = 'channel' AND resource_id = $1 AND subject_type = 'person'
        AND subject_id = (SELECT id FROM app.people WHERE primary_email = 'lena@kahf.example')`,
    [channels['releases']],
  );
});
test.afterAll(async () => {
  await omar?.ctx.dispose();
  await stack?.stop();
});

const boxOf = (page: Page, channel: string): Locator => page.getByRole('textbox', { name: `Message #${channel}` });

async function open(browser: Parameters<typeof openOn>[0], playwright: Parameters<typeof openOn>[1], who: string, channel: string, mobile: boolean) {
  const { page, context } = await openOn(browser, playwright, stack, who, `/t/engineering/c/${channel}`, mobile ? { viewport: PHONE, mobile: true } : {});
  await expect(boxOf(page, channel)).toBeVisible();
  return { page, context };
}

const headings = (page: Page): Locator => page.getByTestId('picker-heading');

test('the toolbar is drawn before the box is touched; tooltips carry the shortcut; Send is an icon with a name', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await open(browser, playwright, 'nadia', 'dev', isMobile);
  try {
    const bar = page.getByRole('toolbar', { name: 'Formatting' });
    await expect(bar).toBeVisible();
    await expect(page.getByTestId('composer-tools')).toHaveAttribute('data-layout', isMobile ? 'aa' : 'full');
    if (!isMobile) {
      await expect(bar.getByRole('button', { name: 'Bold' })).toHaveAttribute('title', 'Bold (Ctrl+B)');
      await expect(bar.getByRole('button', { name: 'Italic' })).toHaveAttribute('title', 'Italic (Ctrl+I)');
      await expect(bar.getByRole('button', { name: 'Strikethrough' })).toHaveAttribute('title', 'Strikethrough (Ctrl+Shift+X)');
      await expect(bar.getByRole('button', { name: 'Link', exact: true })).toHaveAttribute('title', 'Link (Ctrl+K)');
      await expect(bar.getByRole('button', { name: 'Quote' })).toBeVisible();
      await expect(bar.getByRole('button', { name: 'Mention' })).toBeVisible();
    }
    // the send control: an icon, named "Send", asleep until there is something to send
    const send = page.getByRole('button', { name: 'Send', exact: true });
    await expect(send).toBeVisible();
    await expect(send).toHaveText('');
    await expect(send).toBeDisabled();
    await boxOf(page, 'dev').fill('hello');
    await expect(send).toBeEnabled();
    const size = await send.boundingBox();
    expect(size?.height ?? 0).toBeGreaterThanOrEqual(isMobile ? 43.5 : 24);
  } finally {
    await context.close();
  }
});

test('Ctrl+B, Ctrl+I, Ctrl+K and Ctrl+Shift+X format the selection from the keyboard, and a second press takes it off', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'keyboard chords; the phone formats with the bar');
  const { page, context } = await open(browser, playwright, 'nadia', 'dev', false);
  try {
    const box = boxOf(page, 'dev');
    const select = async (from: number, to: number): Promise<void> => {
      await box.evaluate((el: HTMLTextAreaElement, r: [number, number]) => el.setSelectionRange(r[0], r[1]), [from, to] as [number, number]);
    };
    await box.fill('word');
    await select(0, 4);
    await box.press('Control+b');
    await expect(box).toHaveValue('**word**');
    await select(2, 6);
    await box.press('Control+b');
    await expect(box).toHaveValue('word');

    await select(0, 4);
    await box.press('Control+i');
    await expect(box).toHaveValue('*word*');
    await select(1, 5);
    await box.press('Control+i');
    await expect(box).toHaveValue('word');

    await select(0, 4);
    await box.press('Control+Shift+X');
    await expect(box).toHaveValue('~~word~~');

    await box.fill('docs');
    await select(0, 4);
    await box.press('Control+k');
    await expect(box).toHaveValue('[docs](https://)');
    // the chord is the box's: nothing was sent, nothing was left open
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('[data-testid="message"]').filter({ hasText: '[docs]' })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('":" and two letters offers emoji; a time or an address does not', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await open(browser, playwright, 'rafi', 'dev', isMobile);
  try {
    const box = boxOf(page, 'dev');
    const list = page.getByRole('listbox', { name: 'Emoji' });

    for (const text of ['10:30', 'meet at 10:30', 'https://x', 'see https://example.com/a:b', 'a:sm', ':s']) {
      await box.fill(text);
      await expect(list, `"${text}" is not an emoji search`).toHaveCount(0);
    }

    await box.fill(':smi');
    await expect(list).toBeVisible();
    await expect(list.getByRole('option').first()).toHaveAttribute('data-emoji', /.+/);
    // mid-sentence works, and Escape closes it without touching the text
    await box.fill('so happy :smi');
    await expect(list).toBeVisible();
    await box.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(box).toHaveValue('so happy :smi');

    // Enter takes the first one: the colon word becomes the character
    await box.fill('so happy :smi');
    await expect(list).toBeVisible();
    const first = await list.getByRole('option').first().getAttribute('data-emoji');
    await box.press('Enter');
    await expect(box).toHaveValue(new RegExp(`^so happy ${first ?? ''}`));
    await expect(box).not.toHaveValue(/:smi/);
    // and nothing was sent by that Enter
    await expect(page.locator('[data-testid="message"]').filter({ hasText: 'so happy' })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('"@" lists the people under headings: Everyone, People, Bots; "#" lists channels', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await open(browser, playwright, 'nadia', 'dev', isMobile);
  try {
    const box = boxOf(page, 'dev');
    await box.fill('@');
    const list = page.getByRole('listbox', { name: 'People' });
    await expect(list).toBeVisible();
    const seen = await headings(page).allTextContents();
    expect(seen.slice(0, 2)).toEqual(['Everyone', 'People']);
    await expect(list.getByRole('option', { name: /@channel/ })).toBeVisible();
    await expect(list.getByRole('option', { name: /@here/ })).toBeVisible();
    await expect(page.getByRole('listbox', { name: 'People' })).toBeInViewport();
    if (isMobile) expect(await noSidewaysScroll(page)).toBe(true);

    // a word narrows it: @ch is the broadcast word only
    await box.fill('@ch');
    await expect(headings(page)).toHaveText(['Everyone']);
    await expect(list.getByRole('option', { name: /@channel/ })).toBeVisible();

    // a bot is under Bots
    await box.fill('@bra');
    await expect(headings(page)).toHaveText(['Bots']);
    await expect(list.getByRole('option', { name: /Brain/ })).toBeVisible();
    await box.press('Enter');
    await expect(box).toHaveValue('@brain ');

    await box.fill('#');
    await expect(page.getByRole('listbox', { name: 'Channels' })).toBeVisible();
    await expect(headings(page).first()).toHaveText('Channels');
  } finally {
    await context.close();
  }
});

test('a guest cannot @channel or @here: the words are not offered and sending them asks nothing', async ({ browser, playwright, isMobile }) => {
  // the member's side of it, in the same channel: the words are there
  const member = await open(browser, playwright, 'nadia', 'releases', isMobile);
  try {
    await boxOf(member.page, 'releases').fill('@');
    await expect(member.page.getByRole('option', { name: /@channel/ })).toBeVisible();
  } finally {
    await member.context.close();
  }

  const { page, context } = await open(browser, playwright, 'lena', 'releases', isMobile);
  try {
    const box = boxOf(page, 'releases');
    await box.fill('@');
    await expect(page.getByRole('option', { name: /@channel/ })).toHaveCount(0);
    await expect(page.getByRole('option', { name: /@here/ })).toHaveCount(0);
    await expect(page.getByTestId('picker-heading').filter({ hasText: 'Everyone' })).toHaveCount(0);
    await box.fill('@ch');
    await expect(page.getByRole('option', { name: /@channel/ })).toHaveCount(0);
    // typed out by hand it is a plain word: no "send to everyone?" question, the message goes
    await box.fill('@channel hello from a guest');
    await box.press('Enter');
    await expect(page.getByTestId('broadcast-confirm')).toHaveCount(0);
    await expect(page.locator('[data-testid="message"]').filter({ hasText: 'hello from a guest' })).toBeVisible();
    const mine = await omar.get<{ items: Array<{ body: string; meta: { mentions?: unknown } }> }>(`/api/channels/${channels['releases']}/messages?limit=5`);
    const posted = mine.items.find((m) => m.body.includes('hello from a guest'));
    expect(posted, 'the guest message').toBeTruthy();
    expect(JSON.stringify(posted?.meta ?? {})).not.toMatch(/channel|here|broadcast/i);
  } finally {
    await context.close();
  }
});

test('on a phone the bar is "Aa", Mention and Emoji; Formatting options opens the rest and Bold works from it', async ({ browser, playwright, isMobile }) => {
  test.skip(!isMobile, 'a 390 px window');
  const { page, context } = await open(browser, playwright, 'priya', 'dev', true);
  try {
    const bar = page.getByRole('toolbar', { name: 'Formatting' });
    await expect(page.getByTestId('composer-tools')).toHaveAttribute('data-layout', 'aa');
    await expect(bar.getByRole('button', { name: 'Bold' })).toHaveCount(0);
    await expect(bar.getByRole('button', { name: 'Mention' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Emoji' })).toBeVisible();
    const box = boxOf(page, 'dev');
    await box.fill('make this bold');
    await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(5, 9));
    await page.getByRole('button', { name: 'Formatting options' }).click();
    await expect(page.getByTestId('composer-format-toggle')).toHaveAttribute('aria-pressed', 'true');
    const bold = bar.getByRole('button', { name: 'Bold' });
    await expect(bold).toBeVisible();
    const size = await bold.boundingBox();
    expect(size?.width ?? 0).toBeGreaterThanOrEqual(43.5);
    expect(size?.height ?? 0).toBeGreaterThanOrEqual(43.5);
    await bold.click();
    await expect(box).toHaveValue('make **this** bold');
    expect(await noSidewaysScroll(page)).toBe(true);
    await page.getByRole('button', { name: 'Formatting options' }).click();
    await expect(bar.getByRole('button', { name: 'Bold' })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
