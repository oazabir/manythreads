import { expect, test } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn } from '../support/stack-browser.ts';
import {
  BOT,
  CHAT_PROMPTS,
  CHAT_URL,
  call,
  listChats,
  openChatScreen,
  openRail,
  rowOf,
  sendChat,
  startChatStack,
  stateOf,
  typeAndSend,
  type ThreadState,
  waitAnswered,
} from './chat-support.ts';

/*
 * The Chat screen (PLAN P20-16, P20-T4): /t/:team/chat?bot=<slug>&c=<threadRootId>, with Brain. A message goes through the real router and the stand-in of
 * ./fake-hermes-chat.mjs answers it (STREAM writes slowly, SLOW never finishes, anything else echoes with a random tag), so the whole path is real except the
 * model. One stack per project and file; every test uses its own persona (or primes its own chats through the API), so the order does not matter. Keyboard
 * shortcuts are a desktop thing (the keyboard of a phone is not driven here); everything else runs on both layouts.
 */
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let botId = '';

test.beforeAll(async ({ playwright }) => {
  ({ stack, botId } = await startChatStack(playwright));
});
test.afterAll(async () => {
  await stack?.stop();
});

const bubbles = (page: import('@playwright/test').Page, role: 'person' | 'bot') => page.locator(`[data-testid="chat-message"][data-role="${role}"]`);

test('a new chat shows the greeting, the bot\'s own example questions and the box; a message streams, shows what is looked at, and the answer stays', async ({ browser, playwright, isMobile }) => {
  const { page, close } = await openChatScreen(browser, playwright, stack, 'nadia', isMobile);
  try {
    await expect(page.getByTestId('chat-screen')).toBeVisible();
    await expect(page.getByTestId('chat-empty')).toBeVisible();
    await expect(page.getByTestId('chat-greeting')).toHaveText(/^(Hello|Good (morning|afternoon|evening)), Nadia$/);
    await expect(page.getByTestId('chat-prompt')).toHaveText([...CHAT_PROMPTS]);
    await expect(page.getByTestId('chat-main').getByRole('textbox', { name: 'Message Brain' })).toBeVisible();
    // the seed's Coder also takes conversations, so the header offers a picker; a team with only Brain would show its name alone
    const botSpot = page.locator('[data-testid="chat-bot"], [data-testid="chat-bot-name"]');
    await expect(botSpot).toContainText('Brain');
    await expect(page.getByTestId('chat-screen')).toHaveAttribute('data-bot', 'brain');
    await expect(page.getByTestId('chat-history-empty')).toContainText('Your chats show here.');
    // the send control is an icon with a name, not the word
    const send = page.getByTestId('chat-main').getByRole('button', { name: 'Send', exact: true });
    await expect(send).toBeVisible();
    await expect(send).toHaveText('');

    await page.getByTestId('chat-main').getByRole('textbox', { name: 'Message Brain' }).fill('STREAM please');
    await send.click();

    await expect(page).toHaveURL(/[?&]c=[0-9a-f-]{36}/);
    await expect(bubbles(page, 'person').first()).toContainText('STREAM please');
    // the answer is written where the person looks: the live part shows the words so far, what the bot looks at (a fixed phrase), and Stop
    await expect(page.getByTestId('chat-streaming')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId('chat-looked-at')).toContainText('Searching memory');
    await expect(page.getByTestId('chat-stop')).toBeVisible();
    // then the live part gives way to the answer itself
    await expect(bubbles(page, 'bot').last()).toContainText('The release is waiting for Monday.', { timeout: 45_000 });
    await expect(page.getByTestId('chat-live')).toHaveCount(0);
    await expect(page.getByTestId('chat-stop')).toHaveCount(0);
    await expect(page.getByTestId('chat-looked-at')).toHaveCount(0);
    await expect(page.getByTestId('chat-reply-actions')).toBeVisible();
    // the chat is in the rail, and the answer is still there after a reload
    await expect(page.getByTestId('chat-row')).toHaveCount(1, { timeout: 15_000 });
    await page.reload();
    await expect(bubbles(page, 'bot').last()).toContainText('The release is waiting for Monday.');
    await expect(bubbles(page, 'person').first()).toContainText('STREAM please');

    // a second message in the same chat goes under the first
    await typeAndSend(page, 'And after that?');
    await expect(bubbles(page, 'bot')).toHaveCount(2, { timeout: 45_000 });
    await expect(bubbles(page, 'bot').last()).toContainText('And after that?');
  } finally {
    await close();
  }
});

test('an example question sends at once', async ({ browser, playwright, isMobile }) => {
  const { page, close } = await openChatScreen(browser, playwright, stack, 'rafi', isMobile);
  try {
    await page.getByTestId('chat-prompt').first().click();
    await expect(page).toHaveURL(/[?&]c=[0-9a-f-]{36}/);
    await expect(bubbles(page, 'person').first()).toContainText(CHAT_PROMPTS[0]);
    await expect(bubbles(page, 'bot').last()).toContainText(`Answering:`, { timeout: 45_000 });
    await expect(page.getByTestId('chat-empty')).toHaveCount(0);
  } finally {
    await close();
  }
});

test('Stop ends a run that is writing, keeps what was written and says so; Esc does the same on a desktop', async ({ browser, playwright, isMobile }) => {
  const { page, close } = await openChatScreen(browser, playwright, stack, 'priya', isMobile);
  try {
    await typeAndSend(page, 'SLOW please');
    await expect(page.getByTestId('chat-stop')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId('chat-streaming')).toContainText('Working on it', { timeout: 30_000 });
    await page.getByTestId('chat-stop').click();
    await expect(page.getByTestId('chat-stopped')).toHaveText('You stopped this answer.', { timeout: 30_000 });
    await expect(bubbles(page, 'bot').last()).toContainText('Working on it');
    await expect(page.getByTestId('chat-stop')).toHaveCount(0);
    await expect(page.getByTestId('chat-live')).toHaveCount(0);

    const root = new URL(page.url()).searchParams.get('c') ?? '';
    expect(root).toMatch(/^[0-9a-f-]{36}$/);
    const api = await apiOn(playwright, stack, 'priya');
    try {
      const state = await stateOf(api, root);
      expect(state.turns[0]?.variants[0]?.stopped).toBe(true);
      expect(state.liveRunId).toBeNull();
    } finally {
      await api.ctx.dispose();
    }
    const run = await stack.sql<{ stopped_by_asker: boolean }>('SELECT stopped_by_asker FROM app.bot_runs WHERE turn_message_id = $1', [root]);
    expect(run[0]?.stopped_by_asker).toBe(true);

    if (!isMobile) {
      await typeAndSend(page, 'SLOW again');
      // Esc stops a run the screen knows is live (frames or the state's live run), not one that is only about to start: wait for its first words
      await expect(page.getByTestId('chat-streaming')).toContainText('Working on it', { timeout: 45_000 });
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('chat-stopped')).toHaveCount(2, { timeout: 30_000 });
    }
  } finally {
    await close();
  }
});

test('the history rail groups chats, searches, renames, pins, exports, and deletes with an Undo that lasts 30 seconds (410 after)', async ({ browser, playwright, isMobile }) => {
  const api = await apiOn(playwright, stack, 'omar');
  const roots: Record<string, string> = {};
  for (const name of ['Alpha', 'Bravo', 'Charlie']) {
    const sent = await sendChat(api, `Question ${name}`);
    roots[name] = sent.messageId;
    await waitAnswered(api, sent.messageId);
    const renamed = await call(api, 'PATCH', `${BOT}/conversations/${sent.messageId}`, { title: name });
    expect(renamed.status, renamed.text).toBe(200);
  }
  const { page, close } = await openChatScreen(browser, playwright, stack, 'omar', isMobile);
  try {
    await openRail(page, isMobile);
    // newest first, all of today
    await expect(page.getByTestId('chat-group-today').getByTestId('chat-row')).toHaveCount(3);
    await expect(page.getByTestId('chat-group-pinned')).toHaveCount(0);

    // search narrows, clearing brings them back
    const search = page.getByTestId('chat-search');
    await search.fill('Brav');
    await expect(page.getByTestId('chat-row')).toHaveCount(1);
    await expect(rowOf(page, 'Bravo')).toBeVisible();
    await search.fill('nothing like this');
    await expect(page.getByTestId('chat-history-empty')).toContainText('No chat matches that.');
    await search.fill('');
    await expect(page.getByTestId('chat-row')).toHaveCount(3);

    // rename
    await rowOf(page, 'Bravo').hover();
    await rowOf(page, 'Bravo').getByTestId('chat-row-menu').click();
    await page.getByTestId('chat-menu-rename').click();
    const input = page.getByTestId('chat-rename-input');
    await expect(input).toBeFocused();
    await input.fill('Bravo renamed');
    await input.press('Enter');
    await expect(rowOf(page, 'Bravo renamed')).toBeVisible();
    await expect.poll(async () => (await listChats(api)).find((c) => c.threadRootId === roots['Bravo'])?.title).toBe('Bravo renamed');

    // pin: the chat moves to Pinned and stays there; unpin puts it back
    await rowOf(page, 'Charlie').hover();
    await rowOf(page, 'Charlie').getByTestId('chat-row-menu').click();
    await page.getByTestId('chat-menu-pin').click();
    await expect(page.getByTestId('chat-group-pinned').getByTestId('chat-row')).toHaveCount(1);
    await expect(page.getByTestId('chat-group-pinned').getByTestId('chat-row')).toContainText('Charlie');
    await expect(page.getByTestId('chat-group-pinned').getByTestId('chat-row')).toHaveAttribute('data-pinned', 'true');
    await expect.poll(async () => (await listChats(api)).find((c) => c.threadRootId === roots['Charlie'])?.pinned).toBe(true);
    await rowOf(page, 'Charlie').hover();
    await rowOf(page, 'Charlie').getByTestId('chat-row-menu').click();
    await page.getByTestId('chat-menu-pin').click();
    await expect(page.getByTestId('chat-group-pinned')).toHaveCount(0);
    await expect.poll(async () => (await listChats(api)).find((c) => c.threadRootId === roots['Charlie'])?.pinned).toBe(false);

    // open one: the title shows in the header and the messages come
    await rowOf(page, 'Alpha').getByTestId('chat-row-open').click();
    await expect(page).toHaveURL(new RegExp(`[?&]c=${roots['Alpha']}`));
    await expect(page.getByTestId('chat-title')).toContainText('Alpha');
    await expect(bubbles(page, 'person').first()).toContainText('Question Alpha');
    await openRail(page, isMobile);

    // export: a Markdown file named after the chat
    await rowOf(page, 'Alpha').hover();
    await rowOf(page, 'Alpha').getByTestId('chat-row-menu').click();
    const download = page.waitForEvent('download');
    await page.getByTestId('chat-menu-export').click();
    expect((await download).suggestedFilename()).toMatch(/\.md$/);

    // delete: gone at once with a toast; Undo brings it back
    await openRail(page, isMobile);
    await rowOf(page, 'Alpha').hover();
    await rowOf(page, 'Alpha').getByTestId('chat-row-menu').click();
    await page.getByTestId('chat-menu-delete').click();
    await expect(page.getByTestId('chat-row')).toHaveCount(2);
    await expect(page.getByTestId('chat-deleted')).toHaveText('Chat deleted.');
    await expect(page).not.toHaveURL(new RegExp(`[?&]c=${roots['Alpha']}`));
    await page.getByTestId('toast').filter({ hasText: 'Chat deleted.' }).getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByTestId('chat-row')).toHaveCount(3);
    await expect(rowOf(page, 'Alpha')).toBeVisible();

    // delete again and let the 30 seconds pass (the clock is the database's): it is in no list, and restoring is refused with 410
    await rowOf(page, 'Alpha').hover();
    await rowOf(page, 'Alpha').getByTestId('chat-row-menu').click();
    await page.getByTestId('chat-menu-delete').click();
    await expect(page.getByTestId('chat-row')).toHaveCount(2);
    await expect.poll(async () => (await listChats(api)).some((c) => c.threadRootId === roots['Alpha'])).toBe(false);
    await stack.sql(`UPDATE app.conversations SET deleted_at = now() - interval '31 seconds' WHERE thread_root_id = $1`, [roots['Alpha']]);
    const late = await call(api, 'POST', `${BOT}/conversations/${roots['Alpha']}/restore`);
    expect(late.status, late.text).toBe(410);
    expect((await listChats(api)).some((c) => c.threadRootId === roots['Alpha'])).toBe(false);
    await page.reload();
    await openRail(page, isMobile);
    await expect(page.getByTestId('chat-row')).toHaveCount(2);
  } finally {
    await close();
    await api.ctx.dispose();
  }
});

test('Ask again makes another answer; the arrows move between the answers, and each keeps its text', async ({ browser, playwright, isMobile }) => {
  const api = await apiOn(playwright, stack, 'rafi');
  const sent = await sendChat(api, 'Variant question');
  await waitAnswered(api, sent.messageId);
  const { page, close } = await openChatScreen(browser, playwright, stack, 'rafi', isMobile, `${CHAT_URL}&c=${sent.messageId}`);
  try {
    const answer = bubbles(page, 'bot').last();
    await expect(answer).toContainText('Answering:');
    // one answer: no arrows yet
    await expect(page.getByTestId('chat-variants')).toHaveCount(0);
    const first = (await answer.locator('.ch-text').innerText()).trim();

    await page.getByTestId('chat-regenerate').click();
    await expect(page.getByTestId('chat-variant-pos')).toHaveText('2 / 2', { timeout: 60_000 });
    const second = (await bubbles(page, 'bot').last().locator('.ch-text').innerText()).trim();
    expect(second).toContain('Variant question');
    expect(second).not.toBe(first);
    await expect(page.getByTestId('chat-variant-next')).toBeDisabled();
    expect((await waitAnswered(api, sent.messageId, 2)).turns[0]?.variants.map((v) => v.chosen)).toEqual([false, true]);

    await page.getByTestId('chat-variant-prev').click();
    await expect(page.getByTestId('chat-variant-pos')).toHaveText('1 / 2');
    await expect(bubbles(page, 'bot').last().locator('.ch-text')).toHaveText(first);
    await expect(page.getByTestId('chat-variant-prev')).toBeDisabled();
    // the choice is kept: it is the answer later messages continue from
    await expect.poll(async () => (await stateOf(api, sent.messageId)).turns[0]?.variants.find((v) => v.chosen)?.variantNo).toBe(1);

    await page.getByTestId('chat-variant-next').click();
    await expect(page.getByTestId('chat-variant-pos')).toHaveText('2 / 2');
    await expect(bubbles(page, 'bot').last().locator('.ch-text')).toHaveText(second);

    // the arrows are still there after a reload
    await page.reload();
    await expect(page.getByTestId('chat-variant-pos')).toHaveText('2 / 2');
  } finally {
    await close();
    await api.ctx.dispose();
  }
});

test('Edit and ask again changes the last message and asks again', async ({ browser, playwright, isMobile }) => {
  const api = await apiOn(playwright, stack, 'nadia');
  const sent = await sendChat(api, 'Edit me');
  await waitAnswered(api, sent.messageId);
  const { page, close } = await openChatScreen(browser, playwright, stack, 'nadia', isMobile, `${CHAT_URL}&c=${sent.messageId}`);
  try {
    await expect(bubbles(page, 'bot').last()).toContainText('Edit me');
    await page.getByTestId('chat-edit').click();
    const box = page.getByTestId('chat-edit-box').getByRole('textbox', { name: 'Edit your message' });
    await box.fill('Edited question');
    await page.getByTestId('chat-edit-save').click();
    await expect(bubbles(page, 'person').first()).toContainText('Edited question');
    await expect(page.getByTestId('chat-edit-box')).toHaveCount(0);
    await waitAnswered(api, sent.messageId, 2);
    await expect(bubbles(page, 'bot').last()).toContainText('Edited question', { timeout: 60_000 });
    await expect(page.getByTestId('chat-variant-pos')).toHaveText('2 / 2');
  } finally {
    await close();
    await api.ctx.dispose();
  }
});

test('thumbs: a vote is saved and kept, "poor" asks why, and pressing again takes it back', async ({ browser, playwright, isMobile }) => {
  const api = await apiOn(playwright, stack, 'priya');
  const sent = await sendChat(api, 'Rate me');
  const done = await waitAnswered(api, sent.messageId);
  const answerId = done.turns[0]?.variants[0]?.messageId ?? '';
  const { page, close } = await openChatScreen(browser, playwright, stack, 'priya', isMobile, `${CHAT_URL}&c=${sent.messageId}`);
  try {
    const up = page.getByTestId('chat-thumb-up');
    const down = page.getByTestId('chat-thumb-down');
    await expect(up).toHaveAttribute('aria-pressed', 'false');
    await up.click();
    await expect(up).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await stateOf(api, sent.messageId) as unknown as { feedback: Array<{ messageId: string; vote: string }> }).feedback.find((f) => f.messageId === answerId)?.vote).toBe('up');

    await down.click();
    await expect(down).toHaveAttribute('aria-pressed', 'true');
    await expect(up).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('chat-reason')).toBeFocused();
    await page.getByTestId('chat-reason').fill('Too long');
    await page.getByTestId('chat-reason-save').click();
    await expect(page.getByTestId('chat-reason')).toHaveCount(0);
    await expect
      .poll(async () => (await stateOf(api, sent.messageId) as unknown as { feedback: Array<{ messageId: string; vote: string; reason: string }> }).feedback.find((f) => f.messageId === answerId))
      .toMatchObject({ vote: 'down', reason: 'Too long' });

    // kept after a reload; nobody else sees it
    await page.reload();
    await expect(page.getByTestId('chat-thumb-down')).toHaveAttribute('aria-pressed', 'true');
    // pressing the pressed one takes the vote back
    await page.getByTestId('chat-thumb-down').click();
    await expect(page.getByTestId('chat-thumb-down')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => (await stateOf(api, sent.messageId) as unknown as { feedback: unknown[] }).feedback.length).toBe(0);
  } finally {
    await close();
    await api.ctx.dispose();
  }
});

test('copy says it was copied', async ({ browser, playwright, isMobile }) => {
  const api = await apiOn(playwright, stack, 'rafi');
  const sent = await sendChat(api, 'Copy me');
  await waitAnswered(api, sent.messageId);
  const { page, close } = await openChatScreen(browser, playwright, stack, 'rafi', isMobile, `${CHAT_URL}&c=${sent.messageId}`);
  try {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.getByTestId('chat-copy').click();
    await expect(page.getByTestId('toast').filter({ hasText: 'Copied.' })).toBeVisible();
  } finally {
    await close();
    await api.ctx.dispose();
  }
});

test('the model menu lists the bot\'s models, greys the one with no model behind it, and keeps the pick with the chat and in the run', async ({ browser, playwright, isMobile }) => {
  const { page, close } = await openChatScreen(browser, playwright, stack, 'rafi', isMobile, CHAT_URL);
  try {
    const menu = page.getByTestId('chat-model');
    await expect(menu).toContainText('Smart');
    await menu.click();
    const items = page.getByTestId('chat-model-item');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText('Smart');
    await expect(items.nth(0)).toHaveAttribute('aria-checked', 'true');
    await expect(items.nth(1)).toContainText('Fast');
    await expect(items.nth(1)).not.toHaveAttribute('aria-disabled', 'true');
    // a model nobody has set up is greyed and says why; pressing it changes nothing
    await expect(items.nth(2)).toContainText('Code');
    await expect(items.nth(2)).toHaveAttribute('aria-disabled', 'true');
    await expect(items.nth(2)).toContainText('has no model yet');
    await items.nth(2).click({ force: true });
    await expect(menu).toContainText('Smart');
    await page.keyboard.press('Escape');

    // pick Fast before the first message: the run is answered by it
    if ((await page.getByTestId('chat-model-menu').count()) === 0) await menu.click();
    await page.getByTestId('chat-model-item').nth(1).click();
    await expect(menu).toContainText('Fast');
    await typeAndSend(page, 'Which model?');
    await expect(page).toHaveURL(/[?&]c=[0-9a-f-]{36}/);
    const root = new URL(page.url()).searchParams.get('c') ?? '';
    await expect(bubbles(page, 'bot').last()).toContainText('Which model?', { timeout: 45_000 });
    const api = await apiOn(playwright, stack, 'rafi');
    try {
      const state = await waitAnswered(api, root);
      expect(state.modelAlias).toBe('fast');
      expect(state.turns[0]?.variants[0]?.modelAlias).toBe('fast');
    } finally {
      await api.ctx.dispose();
    }
    const run = await stack.sql<{ model_alias: string | null }>('SELECT model_alias FROM app.bot_runs WHERE turn_message_id = $1', [root]);
    expect(run[0]?.model_alias).toBe('fast');

    // the chat remembers it, and a message that names no model uses the one the chat was last given (after a reload nothing is picked in the screen, only the
    // chat has it). Fast is not the bot's first model, so the run can only have it from the chat.
    await page.reload();
    await expect(page.getByTestId('chat-model')).toContainText('Fast');
    await typeAndSend(page, 'And now?');
    await expect(bubbles(page, 'bot')).toHaveCount(2, { timeout: 45_000 });
    await expect(bubbles(page, 'bot').last()).toContainText('And now?');
    await expect
      .poll(async () => (await stack.sql<{ model_alias: string | null }>(`SELECT model_alias FROM app.bot_runs WHERE reply_root_id = $1 ORDER BY started_at`, [root])).map((r) => r.model_alias))
      .toEqual(['fast', 'fast']);

    // changing it in the chat is kept too
    await page.getByTestId('chat-model').click();
    await page.getByTestId('chat-model-item').nth(0).click();
    await expect(page.getByTestId('chat-model')).toContainText('Smart');
    const again = await apiOn(playwright, stack, 'rafi');
    try {
      await expect.poll(async () => (await stateOf(again, root)).modelAlias).toBe('smart');
      // a model the bot's definition does not list, and one with no model behind it, are refused with a sentence (422), and nothing changes
      const other = await call(again, 'PATCH', `${BOT}/conversations/${root}`, { modelAlias: 'vision' });
      expect(other.status, other.text).toBe(422);
      const unbound = await call(again, 'PATCH', `${BOT}/conversations/${root}`, { modelAlias: 'code' });
      expect(unbound.status, unbound.text).toBe(422);
      expect((await stateOf(again, root)).modelAlias).toBe('smart');
    } finally {
      await again.ctx.dispose();
    }
  } finally {
    await close();
  }
});

test('the message box commands: /new starts a new chat, /model names the models, /export downloads the chat', async ({ browser, playwright, isMobile }) => {
  const api = await apiOn(playwright, stack, 'priya');
  const sent = await sendChat(api, 'Commands chat');
  await waitAnswered(api, sent.messageId);
  const { page, close } = await openChatScreen(browser, playwright, stack, 'priya', isMobile, `${CHAT_URL}&c=${sent.messageId}`);
  try {
    const box = page.getByTestId('chat-main').getByRole('textbox', { name: 'Message Brain' });
    await expect(bubbles(page, 'person').first()).toContainText('Commands chat');

    await box.fill('/export');
    const download = page.waitForEvent('download');
    await box.press('Enter');
    expect((await download).suggestedFilename()).toMatch(/\.md$/);

    await box.fill('/model fast');
    await box.press('Enter');
    await expect(page.getByTestId('chat-model')).toContainText('Fast');

    await box.fill('/new');
    await box.press('Enter');
    await expect(page.getByTestId('chat-empty')).toBeVisible();
    await expect(page).not.toHaveURL(/[?&]c=/);
    // the command was not sent as a message
    const chats = await listChats(api);
    expect(chats.filter((c) => c.threadRootId === sent.messageId)).toHaveLength(1);
    const state = await stateOf(api, sent.messageId);
    expect(state.turns).toHaveLength(1);
  } finally {
    await close();
    await api.ctx.dispose();
  }
});

test('keyboard: ? lists the shortcuts, Ctrl+K searches, Ctrl+Shift+O starts a new chat, J and K move through the history', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'shortcuts are a keyboard thing; the phone has the drawer');
  const api = await apiOn(playwright, stack, 'nadia');
  const older = await sendChat(api, 'Keys one');
  await waitAnswered(api, older.messageId);
  await call(api, 'PATCH', `${BOT}/conversations/${older.messageId}`, { title: 'Keys one' });
  const newer = await sendChat(api, 'Keys two');
  await waitAnswered(api, newer.messageId);
  await call(api, 'PATCH', `${BOT}/conversations/${newer.messageId}`, { title: 'Keys two' });
  const { page, close } = await openChatScreen(browser, playwright, stack, 'nadia', false, `${CHAT_URL}&c=${newer.messageId}`);
  try {
    await expect(page.getByTestId('chat-title')).toContainText('Keys two');
    await page.getByTestId('chat-title').click();

    await page.keyboard.press('Shift+?');
    const dialog = page.getByTestId('chat-shortcuts-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Start a new chat');
    await expect(dialog).toContainText('Ctrl+Shift+O');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.getByTestId('chat-shortcuts').click();
    await expect(page.getByTestId('chat-shortcuts-dialog')).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByTestId('chat-title').click();
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('chat-search')).toBeFocused();
    await page.getByTestId('chat-search').fill('Keys');
    await expect(page.getByTestId('chat-row')).toHaveCount(2);
    await page.getByTestId('chat-search').fill('');

    // J goes down the history (newest first), K goes back up
    await page.getByTestId('chat-title').click();
    await page.keyboard.press('j');
    await expect(page).toHaveURL(new RegExp(`[?&]c=${older.messageId}`));
    await page.keyboard.press('k');
    await expect(page).toHaveURL(new RegExp(`[?&]c=${newer.messageId}`));

    await page.keyboard.press('Control+Shift+O');
    await expect(page.getByTestId('chat-empty')).toBeVisible();
    await expect(page).not.toHaveURL(/[?&]c=/);
    // the box has the focus, ready to type
    await expect(page.getByTestId('chat-main').getByRole('textbox', { name: 'Message Brain' })).toBeFocused();
    // letters typed in the box are letters, not shortcuts
    await page.keyboard.type('jk?');
    await expect(page.getByTestId('chat-main').getByRole('textbox', { name: 'Message Brain' })).toHaveValue('jk?');
    await expect(page.getByTestId('chat-shortcuts-dialog')).toHaveCount(0);
  } finally {
    await close();
    await api.ctx.dispose();
  }
});

test('another person cannot open, rename, stop, delete, restore or write into the first person\'s chat', async ({ browser, playwright, isMobile }) => {
  const nadia = await apiOn(playwright, stack, 'nadia');
  const priya = await apiOn(playwright, stack, 'priya');
  const sent = await sendChat(nadia, 'SECRET-PLANS for the move');
  const state = await waitAnswered(nadia, sent.messageId);
  const runId = state.turns[0]?.variants[0]?.runId ?? '';
  expect(runId).not.toBe('');
  const root = sent.messageId;
  const refused = (status: number): boolean => status === 403 || status === 404;
  try {
    // a run is bound to the bot that made it
    expect((await stack.sql<{ bot_id: string }>('SELECT bot_id FROM app.bot_runs WHERE id = $1', [runId]))[0]?.bot_id).toBe(botId);

    expect(refused((await call(priya, 'GET', `${BOT}/conversations/${root}/state`)).status)).toBe(true);
    expect(refused((await call(priya, 'PATCH', `${BOT}/conversations/${root}`, { title: 'Mine now' })).status)).toBe(true);
    expect(refused((await call(priya, 'PATCH', `${BOT}/conversations/${root}`, { pinned: true })).status)).toBe(true);
    expect(refused((await call(priya, 'DELETE', `${BOT}/conversations/${root}`)).status)).toBe(true);
    expect(refused((await call(priya, 'POST', `/api/runs/${runId}/stop`)).status)).toBe(true);
    expect(refused((await call(priya, 'POST', `${BOT}/conversations/send`, { body: 'let me in', threadRootId: root, attachments: [] })).status)).toBe(true);
    const turn = state.turns[0]?.turnMessageId ?? '';
    const answer = state.turns[0]?.variants[0]?.messageId ?? '';
    expect(refused((await call(priya, 'POST', `${BOT}/conversations/${root}/turns/${turn}/regenerate`, {})).status)).toBe(true);
    expect(refused((await call(priya, 'PUT', `${BOT}/conversations/${root}/turns/${turn}/variant`, { messageId: answer })).status)).toBe(true);
    expect(refused((await call(priya, 'PUT', `${BOT}/conversations/messages/${answer}/feedback`, { vote: 'up' })).status)).toBe(true);
    expect(refused((await call(priya, 'GET', `/api/channels/${sent.channelId}/messages?threadRootId=${root}&limit=20`)).status)).toBe(true);
    expect((await listChats(priya)).some((c) => c.threadRootId === root)).toBe(false);

    // the screen does not show it either
    const { page, close } = await openChatScreen(browser, playwright, stack, 'priya', isMobile, `${CHAT_URL}&c=${root}`);
    try {
      await expect(page.getByTestId('chat-screen')).toBeVisible();
      await expect(page.getByTestId('chat-main').getByRole('textbox', { name: 'Message Brain' })).toBeVisible({ timeout: 20_000 });
      await page.waitForLoadState('networkidle');
      await expect(page.getByText('SECRET-PLANS')).toHaveCount(0);
      await expect(page.getByTestId('chat-message')).toHaveCount(0);
    } finally {
      await close();
    }

    // nothing of it changed
    const still = await stateOf(nadia, root);
    expect(still.title).not.toBe('Mine now');
    expect(still.pinned).toBe(false);
    expect((await listChats(nadia)).some((c) => c.threadRootId === root)).toBe(true);
    expect(still.turns[0]?.variants[0]?.stopped).toBe(false);
    expect(((await stateOf(nadia, root)) as unknown as { feedback: unknown[] }).feedback).toHaveLength(0);

    // Undo is the owner's alone: after Nadia deletes her chat, Priya's restore is refused (410, the same answer a late one gets) and the chat stays deleted
    expect((await call(nadia, 'DELETE', `${BOT}/conversations/${root}`)).status).toBe(200);
    const stolen = await call(priya, 'POST', `${BOT}/conversations/${root}/restore`);
    expect(stolen.status, stolen.text).toBeGreaterThanOrEqual(400);
    expect((await listChats(nadia)).some((c) => c.threadRootId === root)).toBe(false);
    expect((await call(nadia, 'POST', `${BOT}/conversations/${root}/restore`)).status).toBe(200);
    expect((await listChats(nadia)).some((c) => c.threadRootId === root)).toBe(true);
  } finally {
    await Promise.all([nadia.ctx.dispose(), priya.ctx.dispose()]);
  }
});

test('Stop is the asker\'s alone: another person cannot end a run that is writing, and the asker still can', async ({ playwright }) => {
  const nadia = await apiOn(playwright, stack, 'nadia');
  const priya = await apiOn(playwright, stack, 'priya');
  try {
    const sent = await sendChat(nadia, 'SLOW and private');
    let runId: string | null = null;
    await expect
      .poll(async () => {
        const res = await nadia.ctx.get(`${BOT}/conversations/${sent.messageId}/state`);
        runId = res.status() === 200 ? ((await res.json()) as ThreadState).liveRunId : null;
        return runId;
      }, { timeout: 45_000, message: 'the run to be live' })
      .not.toBeNull();
    const live = runId as unknown as string;

    const denied = await call(priya, 'POST', `/api/runs/${live}/stop`);
    expect(denied.status, denied.text).toBe(404);
    // it is still running after the refusal
    expect((await stateOf(nadia, sent.messageId)).liveRunId).toBe(live);

    // a run that is still starting answers { stopped: false } until the process holds it, so ask until it says it stopped it
    await expect
      .poll(async () => {
        const own = await call(nadia, 'POST', `/api/runs/${live}/stop`);
        return own.status === 200 ? (JSON.parse(own.text) as { stopped: boolean }).stopped : null;
      }, { timeout: 30_000, message: 'the asker\'s Stop to take hold' })
      .toBe(true);
    const done = await waitAnswered(nadia, sent.messageId);
    expect(done.turns[0]?.variants[0]?.stopped).toBe(true);
  } finally {
    await Promise.all([nadia.ctx.dispose(), priya.ctx.dispose()]);
  }
});

test('Brain\'s old address lands in Chat: /bots/brain/chat keeps a thread, other bots keep their own conversation view', async ({ browser, playwright, isMobile }) => {
  const api = await apiOn(playwright, stack, 'rafi');
  const sent = await sendChat(api, 'Old link');
  await waitAnswered(api, sent.messageId);
  const { page, close } = await openChatScreen(browser, playwright, stack, 'rafi', isMobile, '/t/engineering/bots/brain/chat');
  try {
    await expect(page).toHaveURL(/\/t\/engineering\/chat\?bot=brain$/);
    await expect(page.getByTestId('chat-screen')).toBeVisible();
    await expect(page.getByTestId('conversation-view')).toHaveCount(0);

    await page.goto(`/t/engineering/bots/brain/chat?thread=${sent.messageId}`);
    await expect(page).toHaveURL(new RegExp(`/t/engineering/chat\\?bot=brain&c=${sent.messageId}$`));
    await expect(bubbles(page, 'person').first()).toContainText('Old link');

    // the Workshop tab of Brain and any other bot stay on the bot's own page
    await page.goto('/t/engineering/bots/brain/chat?view=workshop');
    await expect(page).toHaveURL(/\/bots\/brain\/chat\?view=workshop/);
    await expect(page.getByTestId('workshop-tab')).toBeVisible();
    await expect(page.getByTestId('chat-screen')).toHaveCount(0);
    await page.goto('/t/engineering/bots/coder/chat');
    await expect(page.getByTestId('conversation-view').or(page.getByTestId('conversation-blocked')).or(page.getByTestId('conversation-unavailable')).first()).toBeVisible();
    await expect(page).toHaveURL(/\/bots\/coder\/chat/);
    await expect(page.getByTestId('chat-screen')).toHaveCount(0);
  } finally {
    await close();
    await api.ctx.dispose();
  }
});

test('the history: a drawer on a phone (toggle, scrim, close, choosing a chat or New chat shuts it), a column on a desktop', async ({ browser, playwright, isMobile }) => {
  const api = await apiOn(playwright, stack, 'rafi');
  const one = await sendChat(api, 'Drawer one');
  await waitAnswered(api, one.messageId);
  await call(api, 'PATCH', `${BOT}/conversations/${one.messageId}`, { title: 'Drawer one' });
  const { page, close } = await openChatScreen(browser, playwright, stack, 'rafi', isMobile, `${CHAT_URL}&c=${one.messageId}`);
  try {
    await expect(page.getByTestId('chat-screen')).toBeVisible();
    const rail = page.getByTestId('chat-rail');
    if (!isMobile) {
      await expect(page.getByTestId('chat-rail-toggle')).toHaveCount(0);
      await expect(rail).toBeInViewport();
      await expect(rowOf(page, 'Drawer one')).toBeVisible();
      return;
    }
    const toggle = page.getByTestId('chat-rail-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const size = await toggle.boundingBox();
    expect(size?.width ?? 0).toBeGreaterThanOrEqual(43.5);
    expect(size?.height ?? 0).toBeGreaterThanOrEqual(43.5);
    await expect(rail).not.toBeInViewport();

    await toggle.click();
    await expect(rail).toBeInViewport();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const box = await rail.boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(0.86 * 390 + 1);
    await expect(page.locator('.ch-scrim')).toBeVisible();
    // the scrim shuts it
    await page.locator('.ch-scrim').click({ position: { x: 385, y: 400 } });
    await expect(rail).not.toBeInViewport();

    // the close button shuts it
    await toggle.click();
    await expect(rail).toBeInViewport();
    await page.getByTestId('chat-rail-close').click();
    await expect(rail).not.toBeInViewport();

    // choosing a chat opens it and shuts the drawer
    const two = await sendChat(api, 'Drawer two');
    await waitAnswered(api, two.messageId);
    await call(api, 'PATCH', `${BOT}/conversations/${two.messageId}`, { title: 'Drawer two' });
    await page.reload();
    await toggle.click();
    await rowOf(page, 'Drawer two').getByTestId('chat-row-open').click();
    await expect(page).toHaveURL(new RegExp(`[?&]c=${two.messageId}`));
    await expect(rail).not.toBeInViewport();
    await expect(bubbles(page, 'person').first()).toContainText('Drawer two');

    // New chat shuts it too and leaves an empty chat
    await toggle.click();
    await page.getByTestId('chat-new').click();
    await expect(page.getByTestId('chat-empty')).toBeVisible();
    await expect(rail).not.toBeInViewport();
    // no sideways scroll
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await close();
    await api.ctx.dispose();
  }
});
