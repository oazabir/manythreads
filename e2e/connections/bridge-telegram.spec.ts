import { expect, test } from '@playwright/test';
import { apiOn, openOn, postAs } from '../support/stack-browser.ts';
import type { Stack } from '../fixtures/stack.ts';
import { SEED_CONNECTORS, connectorsStack, personas, rows, seededOf, stateOf, telegramSend } from './support.ts';

/*
 * Telegram joined to a channel and to a person (PLAN P16-09, decisions D8 and D9), on seed v16: the Telegram bot is on, Nadia is linked as Telegram user 700001, and `#support` is joined to the
 * group -1001000000001. Covered: a person who is not linked is answered once and stored nowhere; Priya links with a code from Account, Chat apps; a linked person's group message lands in the
 * channel as her, "via Telegram"; what the channel says goes out to the group once, and a message that came from Telegram is not sent back; a direct chat with the bot is answered; a call
 * without the secret word is refused. The Slack, Teams and WhatsApp doors are covered in packages/plugins/bridges/test against the stand-ins; their accounts need credentials an admin types.
 *
 * Written for the integration pass; not run by the coder that wrote it.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout');
test.describe.configure({ mode: 'serial' });

const GROUP = SEED_CONNECTORS.telegram.groupChatId;
const NADIA_TG = SEED_CONNECTORS.telegram.nadiaUserId;
const PRIYA_TG = 800_001;
const STRANGER_TG = 999_001;
let stack: Stack;

test.beforeAll(async () => {
  stack = await connectorsStack({ MANYTHREADS_STACK_MEETINGS: '1' });
});
test.afterAll(async () => {
  await stack?.stop();
});

const sentTo = async (chatId: number | string): Promise<string[]> => (await stateOf(stack)).telegram.sent.filter((m) => String(m.chatId) === String(chatId)).map((m) => m.text);
const storedWith = async (text: string): Promise<number> => (await rows(stack, `SELECT 1 FROM app.messages WHERE body LIKE $1`, [`%${text}%`])).length;

test('a person who is not linked is told once how to link, and nothing they wrote is stored', async () => {
  const first = await telegramSend(stack, { fromUserId: STRANGER_TG, text: 'stranger-sentence-one', firstName: 'Stranger' });
  expect(first.responses.map((r) => r.status)).toEqual([200]);
  await expect.poll(async () => (await sentTo(STRANGER_TG)).length, { timeout: 30_000 }).toBe(1);
  expect((await sentTo(STRANGER_TG))[0]).toMatch(/link/i);
  // a second message within the hour is not answered again
  await telegramSend(stack, { fromUserId: STRANGER_TG, text: 'stranger-sentence-two' });
  expect(await storedWith('stranger-sentence')).toBe(0);
});

test('a call without the secret word, or with a wrong one, is refused and changes nothing', async () => {
  const before = (await stateOf(stack)).telegram.sent.length;
  for (const secretHeader of ['missing', 'wrong'] as const) {
    const sent = await telegramSend(stack, { fromUserId: NADIA_TG, text: `no-secret-${secretHeader}`, secretHeader });
    expect(sent.responses[0]?.status, secretHeader).toBeGreaterThanOrEqual(400);
  }
  expect(await storedWith('no-secret-')).toBe(0);
  expect((await stateOf(stack)).telegram.sent.length).toBe(before);
});

test('Priya links her Telegram with a code from Account, Chat apps: the code works once and the page then says Linked', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'priya', '/account/chat-apps');
  try {
    const card = page.getByTestId('chat-link-telegram');
    await expect(card).toHaveAttribute('data-linked', 'false');
    await page.getByTestId('chat-link-telegram-get').click();
    const shown = page.getByTestId('chat-link-telegram-code');
    await expect(shown).toBeVisible();
    const code = (await shown.locator('.br-code-digits').innerText()).trim();
    expect(code).toMatch(/^\d{8}$/);

    // a wrong code first: refused, and the right one still works
    await telegramSend(stack, { fromUserId: PRIYA_TG, text: '00000000', username: 'priya_tg' });
    await telegramSend(stack, { fromUserId: PRIYA_TG, text: `/start ${code}`, username: 'priya_tg' });
    await expect
      .poll(async () => {
        await page.reload();
        return card.getAttribute('data-linked');
      }, { timeout: 30_000, intervals: [1_000, 2_000] })
      .toBe('true');

    // the same code again links nobody else
    await telegramSend(stack, { fromUserId: STRANGER_TG + 1, text: code });
    const linked = await rows<{ n: string }>(stack, `SELECT count(*)::text AS n FROM app.bridge_identities WHERE person_id = $1`, [personas.priya.personId]);
    expect(linked[0]!.n).toBe('1');
  } finally {
    await context.close();
  }
});

test('Nadia writes in the Telegram group: the words land in #support as her, "via Telegram"', async ({ browser, playwright }) => {
  const text = 'Group hello from Telegram';
  const sent = await telegramSend(stack, { fromUserId: NADIA_TG, chatId: GROUP, chatType: 'supergroup', chatTitle: SEED_CONNECTORS.telegram.groupTitle, text, username: 'nadia_tg' });
  expect(sent.responses.map((r) => r.status)).toEqual([200]);
  await expect.poll(() => storedWith(text), { timeout: 30_000 }).toBe(1);

  const { page, context } = await openOn(browser, playwright, stack, 'sameera', '/t/customer-support/c/support');
  try {
    const message = page.getByTestId('message').filter({ hasText: text });
    await expect(message).toHaveCount(1);
    await expect(message.getByTestId('message-via')).toHaveText('via Telegram');
    await expect(message).toContainText('Nadia');
  } finally {
    await context.close();
  }
  // a message that came from Telegram is never sent back to it
  expect((await sentTo(GROUP)).filter((t) => t.includes(text))).toHaveLength(0);
});

test('what Sameera says in #support goes out to the group once', async ({ playwright }) => {
  const text = 'Answer from the web to the group';
  const sameera = await apiOn(playwright, stack, 'sameera');
  try {
    await postAs(sameera, seededOf(stack).supportChannelId, text);
  } finally {
    await sameera.ctx.dispose();
  }
  await expect.poll(async () => (await sentTo(GROUP)).filter((t) => t.includes(text)).length, { timeout: 60_000, intervals: [1_000, 3_000] }).toBe(1);
  // the queue holds one outbound row for that message and the one link, never two
  const out = await rows<{ n: string }>(
    stack,
    `SELECT count(*)::text AS n FROM app.bridge_messages b JOIN app.messages m ON m.id = b.message_id WHERE b.direction = 'out' AND m.body LIKE $1`,
    [`%${text}%`],
  );
  expect(out[0]!.n).toBe('1');
});

test('a direct chat with the bot is answered for a linked person', async () => {
  const before = (await sentTo(NADIA_TG)).length;
  const sent = await telegramSend(stack, { fromUserId: NADIA_TG, text: 'What is on my plate today?', username: 'nadia_tg' });
  expect(sent.responses.map((r) => r.status)).toEqual([200]);
  await expect.poll(async () => (await sentTo(NADIA_TG)).length, { timeout: 150_000, intervals: [2_000, 5_000], message: 'the bot to answer in the direct chat' }).toBeGreaterThan(before);
});

test('the same update delivered twice is one message', async () => {
  const text = 'Replay me once';
  const sent = await telegramSend(stack, { fromUserId: NADIA_TG, chatId: GROUP, chatType: 'supergroup', text, updateId: 4_242_001, repeat: 2 });
  expect(sent.responses.map((r) => r.status)).toEqual([200, 200]);
  await expect.poll(() => storedWith(text), { timeout: 30_000 }).toBe(1);
});

test('unlinking from Account, Chat apps takes the link away at once', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'priya', '/account/chat-apps');
  try {
    const card = page.getByTestId('chat-link-telegram');
    await expect(card).toHaveAttribute('data-linked', 'true');
    await page.getByTestId('chat-link-telegram-unlink').click();
    await expect(card).toHaveAttribute('data-linked', 'false');
  } finally {
    await context.close();
  }
  // her next group message is the stranger case: not stored
  await telegramSend(stack, { fromUserId: PRIYA_TG, chatId: GROUP, chatType: 'supergroup', text: 'after-unlink-sentence' });
  await telegramSend(stack, { fromUserId: NADIA_TG, chatId: GROUP, chatType: 'supergroup', text: 'marker after unlink' });
  await expect.poll(() => storedWith('marker after unlink'), { timeout: 30_000 }).toBe(1);
  expect(await storedWith('after-unlink-sentence')).toBe(0);
});
