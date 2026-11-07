import { expect, test, type Page } from '@playwright/test';
import type { Stack } from '../../fixtures/stack.ts';
import { apiOn } from '../../support/stack-browser.ts';
import { BOT, CHAT_URL, call, sendChat, startChatStack, stateOf, waitAnswered } from '../../conversations/chat-support.ts';
import { DESKTOP, MOBILE, W_OPTIONS, expectWireframe, openPage, settle } from '../support/vt.ts';

/*
 * The Chat screen (PLAN P20-16, P20-T4; own baselines, class W): an empty chat (greeting, example questions, the box), a conversation with an answer that has a
 * second variant and the thumbs, the history rail with a pinned chat, the same at 390x844, and the phone's drawer open. 1440x900 and 390x844:
 * chat-empty-1440.png, chat-conversation-1440.png, chat-rail-1440.png, chat-empty-390.png, chat-conversation-390.png, chat-drawer-390.png.
 * The greeting (it follows the hour of the day) is masked; the answers are the stand-in's fixed sentence ("FIXED" in the question), so no text is volatile.
 * No baseline is committed with this spec: the runner creates them after looking at every picture.
 */
test.skip(({ isMobile }) => isMobile, 'the spec sets its own viewports');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let rootId = '';

test.beforeAll(async ({ playwright }) => {
  ({ stack } = await startChatStack(playwright));
  const nadia = await apiOn(playwright, stack, 'nadia');
  try {
    // one chat with two answers (the second is the chosen one) and a thumb, pinned; one plain chat beside it
    const first = await sendChat(nadia, 'What is blocking the release? FIXED');
    await waitAnswered(nadia, first.messageId);
    expect((await call(nadia, 'PATCH', `${BOT}/conversations/${first.messageId}`, { title: 'Release blockers', pinned: true })).status).toBe(200);
    const turn = (await stateOf(nadia, first.messageId)).turns[0]?.turnMessageId ?? '';
    expect((await call(nadia, 'POST', `${BOT}/conversations/${first.messageId}/turns/${turn}/regenerate`, {})).status).toBeLessThan(300);
    const done = await waitAnswered(nadia, first.messageId, 2);
    const answerId = done.turns[0]?.variants.find((v) => v.chosen)?.messageId ?? '';
    expect((await call(nadia, 'PUT', `${BOT}/conversations/messages/${answerId}/feedback`, { vote: 'up' })).status).toBe(200);
    rootId = first.messageId;

    const second = await sendChat(nadia, 'Where are the notes for Monday? FIXED');
    await waitAnswered(nadia, second.messageId);
    expect((await call(nadia, 'PATCH', `${BOT}/conversations/${second.messageId}`, { title: 'Notes for Monday' })).status).toBe(200);
  } finally {
    await nadia.ctx.dispose();
  }
});
test.afterAll(async () => {
  await stack?.stop();
});

/** The greeting follows the hour of the reader's clock: its box is kept, its words are not compared. */
async function maskGreeting(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelectorAll('[data-testid="chat-greeting"]').forEach((el) => el.setAttribute('data-vt-mask', '')));
}

for (const [size, viewport, mobile] of [
  ['1440', DESKTOP, false],
  ['390', MOBILE, true],
] as const) {
  test(`chat-empty-${size} matches its baseline (W)`, async ({ browser }) => {
    const { page, close } = await openPage(browser, stack, 'rafi', viewport, mobile);
    try {
      await page.goto(CHAT_URL);
      await expect(page.getByTestId('chat-empty')).toBeVisible();
      await expect(page.getByTestId('chat-prompt')).toHaveCount(2);
      await maskGreeting(page);
      await expectWireframe(page, `chat-empty-${size}`, mobile ? ['chat-main'] : [['chat-history', 'chat-main']]);
    } finally {
      await close();
    }
  });

  test(`chat-conversation-${size} matches its baseline (W)`, async ({ browser }) => {
    const { page, close } = await openPage(browser, stack, 'nadia', viewport, mobile);
    try {
      await page.goto(`${CHAT_URL}&c=${rootId}`);
      await expect(page.getByTestId('chat-variant-pos')).toHaveText('2 / 2');
      await expect(page.getByTestId('chat-thumb-up')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('chat-title')).toContainText('Release blockers');
      await expectWireframe(page, `chat-conversation-${size}`, mobile ? ['chat-main'] : [['chat-history', 'chat-main']]);
    } finally {
      await close();
    }
  });
}

test('chat-rail-1440 matches its baseline (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'nadia', DESKTOP, false);
  try {
    await page.goto(`${CHAT_URL}&c=${rootId}`);
    await expect(page.getByTestId('chat-group-pinned').getByTestId('chat-row')).toHaveCount(1);
    await expect(page.getByTestId('chat-group-today').getByTestId('chat-row')).toHaveCount(1);
    await settle(page);
    await expect(page.getByTestId('chat-rail')).toHaveScreenshot('chat-rail-1440.png', { ...W_OPTIONS, mask: [page.locator('[data-vt-mask]')] });
  } finally {
    await close();
  }
});

test('chat-drawer-390 matches its baseline (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'nadia', MOBILE, true);
  try {
    await page.goto(`${CHAT_URL}&c=${rootId}`);
    await expect(page.getByTestId('chat-title')).toContainText('Release blockers');
    await page.getByTestId('chat-rail-toggle').click();
    await expect(page.getByTestId('chat-rail')).toBeInViewport();
    await expect(page.getByTestId('chat-group-pinned').getByTestId('chat-row')).toHaveCount(1);
    await expectWireframe(page, 'chat-drawer-390', ['chat-main']);
  } finally {
    await close();
  }
});
