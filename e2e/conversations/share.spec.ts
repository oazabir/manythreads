import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { channelsOf, noSidewaysScroll, postAs } from '../support/stack-browser.ts';
import { addBot, answerStackEnv, answeringBrainMd, apiOn, openChat } from './support.ts';

/*
 * Share with masking, Save as page and Hand to a bot (PLAN P5-17, SPEC §6.3 and §6.4; wireframe "Share preview with masking"). Nadia asks Brain
 * something whose answer rests on a source anybody on the team may open (a message in #dev) and one only the people of a private room may
 * (Omar and she are in it). She shares the answer to #dev: the room's message is "not shared" there, with nothing of it in the copy; she removes a
 * claim; she saves it as a page; she hands it to Coder. The model is the stand-in of fake-hermes-answer.mjs. Every flow runs on desktop and
 * mobile-web.
 */
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let devId = '';
let devMessage = '';
let roomMessage = '';
const NADIA_PERSON = '00000000-0000-7000-8000-0000000c0002';
const PUBLIC_TEXT = 'The deploy waits for the Monday change window';
const ROOM_TEXT = 'Release room: the Monday change window moves only if the rollback plan is signed';

test.beforeAll(async ({ playwright }) => {
  stack = await startStack(answerStackEnv());
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    await addBot(stack, omar, 'brain', answeringBrainMd());
    devId = (await channelsOf(omar))['dev']!;
    devMessage = (await postAs(omar, devId, PUBLIC_TEXT)).id;
    const room = await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name: 'release-room', private: true });
    await omar.post(`/api/channels/${room.channel.id}/members`, { personId: NADIA_PERSON });
    roomMessage = (await postAs(omar, room.channel.id, ROOM_TEXT)).id;
  } finally {
    await omar.ctx.dispose();
  }
});
test.afterAll(async () => {
  await stack?.stop();
});

/** Nadia's conversation with Brain, with an answer that rests on both messages, opened. */
async function askedAndAnswered(page: import('@playwright/test').Page): Promise<void> {
  const box = page.getByRole('textbox', { name: 'Message Brain' });
  await box.fill(`ANSWER-WITH-SOURCES ${devMessage} ${roomMessage}`);
  await box.press('Enter');
  await expect(page).toHaveURL(/[?&]thread=[0-9a-f-]{36}/);
  await expect(page.getByTestId('answer')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('answer-citation')).toHaveCount(2);
}

test('share to a channel: the preview says which sources are kept and which are not shared, a claim can be removed, and the copy hides the private source', async ({ browser, playwright, isMobile }) => {
  const { page, close } = await openChat(browser, playwright, stack, 'nadia', '/t/engineering/bots/brain/chat', isMobile);
  try {
    await askedAndAnswered(page);
    // the answer is hers: she is offered to share it, and the chips act
    await page.getByTestId('answer-share-open').click();
    const dialog = page.getByTestId('answer-share-dialog');
    await expect(dialog).toBeVisible();
    // the target list holds the channels she may post in, and nothing is chosen yet
    await expect(page.getByTestId('answer-share-confirm')).toBeDisabled();
    await page.getByTestId('answer-share-target').selectOption({ label: '# dev · Engineering' });
    const items = page.getByTestId('answer-share-item');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toHaveAttribute('data-status', 'kept');
    await expect(items.nth(0)).toContainText(PUBLIC_TEXT);
    await expect(items.nth(1)).toHaveAttribute('data-status', 'masked');
    await expect(items.nth(1)).toContainText('from Nadia’s message · not shared');
    await expect(page.getByTestId('answer-share-counts')).toHaveText('1 kept · 1 not shared · 0 removed');
    if (isMobile) expect(await noSidewaysScroll(page)).toBe(true);

    // removing a claim is a toggle: the preview is read again, and the number goes back when it is kept
    const removeSecond = items.nth(1).getByTestId('answer-share-remove');
    await removeSecond.click();
    await expect(items.nth(1)).toHaveAttribute('data-status', 'removed');
    await expect(page.getByTestId('answer-share-counts')).toHaveText('1 kept · 0 not shared · 1 removed');
    await items.nth(1).getByTestId('answer-share-remove').click();
    await expect(items.nth(1)).toHaveAttribute('data-status', 'masked');

    // Escape closes it without posting anything; opening it again starts from the answer
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.getByTestId('answer-share-open').click();
    await page.getByTestId('answer-share-target').selectOption({ label: '# dev · Engineering' });
    await expect(page.getByTestId('answer-share-item').nth(1)).toHaveAttribute('data-status', 'masked');
    await page.getByTestId('answer-share-confirm').click();
    await expect(page.getByTestId('answer-share-done')).toContainText('Shared to # dev.');
    await expect(dialog).toHaveCount(0);
  } finally {
    await close();
  }

  // Omar reads #dev: the copy is there, the room's message is "not shared" and nothing of it is on the page; the conversation stays Nadia's
  const omar = await openChat(browser, playwright, stack, 'omar', '/t/engineering/c/dev', isMobile);
  try {
    const copy = omar.page.getByTestId('answer').first();
    await expect(copy).toBeVisible({ timeout: 30_000 });
    await expect(copy).toContainText('The deploy is waiting for the Monday window');
    await expect(copy.locator('[data-testid="answer-citation"][data-kind="masked"]')).toContainText('from Nadia’s message · not shared');
    await expect(copy.locator('[data-testid="answer-citation"][data-kind="message"]')).toContainText(PUBLIC_TEXT);
    await expect(copy.getByTestId('answer-share-note')).toContainText('Shared by Nadia · 1 source not shared');
    await expect(omar.page.locator('body')).not.toContainText('rollback plan is signed');
    await expect(omar.page.getByTestId('answer-share-open')).toHaveCount(0);
    if (isMobile) expect(await noSidewaysScroll(omar.page)).toBe(true);
  } finally {
    await omar.close();
  }
});

test('share with a claim removed: the copy has the answer with that claim taken out, and only that', async ({ browser, playwright, isMobile }) => {
  const { page, close } = await openChat(browser, playwright, stack, 'nadia', '/t/engineering/bots/brain/chat', isMobile);
  try {
    await page.getByTestId('conversation-row').first().click();
    await expect(page.getByTestId('answer')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('answer-share-open').click();
    await page.getByTestId('answer-share-target').selectOption({ label: '# dev · Engineering' });
    await page.getByTestId('answer-share-item').nth(1).getByTestId('answer-share-remove').click();
    await expect(page.getByTestId('answer-share-item').nth(1)).toHaveAttribute('data-status', 'removed');
    await page.getByTestId('answer-share-confirm').click();
    await expect(page.getByTestId('answer-share-done')).toBeVisible();
  } finally {
    await close();
  }
  const rows = await stack.sql<{ body: string; meta: { answer: { citations: Array<{ kind: string }>; share: { masked: number; removed: number } } } }>(
    `SELECT m.body, m.meta FROM app.messages m JOIN app.channels c ON c.id = m.channel_id
      WHERE c.name = 'dev' AND c.team_id = (SELECT id FROM app.teams WHERE slug = 'engineering') AND m.meta ? 'answer' AND m.deleted_at IS NULL ORDER BY m.id`,
  );
  expect(rows).toHaveLength(2);
  const cut = rows[1]!;
  expect(cut.body).toBe('The deploy is waiting for the Monday window [1].');
  expect(cut.meta.answer.share).toEqual({ masked: 0, removed: 1 });
  expect(cut.meta.answer.citations.map((c) => c.kind)).toEqual(['message']);
  expect(JSON.stringify(cut.meta)).not.toContain('rollback plan');
});

test('save as page: the team’s page holds the masked copy', async ({ browser, playwright, isMobile }) => {
  const { page, close } = await openChat(browser, playwright, stack, 'nadia', '/t/engineering/bots/brain/chat', isMobile);
  let path = '';
  try {
    await page.getByTestId('conversation-row').first().click();
    await page.getByTestId('answer-save-open').click();
    await expect(page.getByTestId('answer-save-where')).toContainText('pages/answers/');
    await expect(page.getByTestId('answer-share-item').nth(1)).toHaveAttribute('data-status', 'masked');
    path = (await page.getByTestId('answer-save-where').locator('code').textContent()) ?? '';
    await page.getByTestId('answer-share-confirm').click();
    await expect(page.getByTestId('answer-share-done')).toContainText('Saved as a page.');
    await page.getByRole('link', { name: 'Open page' }).click();
    await expect(page).toHaveURL(/\/t\/engineering\/files\?open=pages%2Fanswers%2F/);
  } finally {
    await close();
  }
  // the page, as another member of the team reads it
  const rafi = await apiOn(playwright, stack, 'rafi');
  try {
    const blob = await rafi.get<{ content: string }>(`/api/teams/engineering/repo/blob?path=${encodeURIComponent(path)}`);
    expect(blob.content).toContain('The deploy is waiting for the Monday window [1].');
    expect(blob.content).toContain("from Nadia's message · not shared");
    expect(blob.content).not.toContain('rollback plan');
    expect(blob.content).not.toContain('Release room');
  } finally {
    await rafi.ctx.dispose();
  }
});

test('hand to a bot: the chip opens a thread with that bot, in the asker’s own conversation, carrying the answer', async ({ browser, playwright, isMobile }) => {
  const { page, close } = await openChat(browser, playwright, stack, 'nadia', '/t/engineering/bots/brain/chat', isMobile);
  try {
    await page.getByTestId('conversation-row').first().click();
    await expect(page.getByTestId('answer-chips')).toContainText('@Coder');
    await page.getByTestId('answer-chips').getByRole('button', { name: '@Coder' }).click();
    await expect(page).toHaveURL(/\/t\/engineering\/bots\/coder\/chat\?thread=[0-9a-f-]{36}/);
    const root = page.getByTestId('message').first();
    await expect(root).toContainText('Handed over from Brain.', { timeout: 30_000 });
    await expect(root).toContainText('The deploy is waiting for the Monday window');
    if (isMobile) expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await close();
  }
});

test('a follow-up chip asks the question in the same thread', async ({ browser, playwright, isMobile }) => {
  const { page, close } = await openChat(browser, playwright, stack, 'nadia', '/t/engineering/bots/brain/chat', isMobile);
  try {
    await page.getByTestId('conversation-row').first().click();
    await page.getByTestId('answer-followups').getByRole('button', { name: 'When does it open?' }).click();
    await expect(page.getByTestId('message').filter({ hasText: 'When does the window open?' }).first()).toBeVisible({ timeout: 30_000 });
  } finally {
    await close();
  }
});
