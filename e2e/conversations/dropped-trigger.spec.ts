import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { applyGuarded, postAs } from '../support/stack-browser.ts';
import { addBot, apiOn, channelOf, conversationStackEnv, openChat } from './support.ts';

/*
 * Two things the first review round of the conversation view asked to be pinned end to end (PLAN P5-16):
 *
 *   * a bot that DROPS its `conversation` trigger after people have talked to it: `open` answers 409, and the view keeps the lists (the past
 *     conversations are theirs) while the message box and the reply box give way to the reason;
 *   * a list longer than one page: the first page is 30 rows, "Show older" asks for the rest and goes away when there is none.
 *
 * Both run on the desktop and the mobile-web project. One stack for the file (serial), because the second builds on the first's channel.
 */
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let driftId = '';
let channelId = '';

const FIRST = 'What changed in the schedule migration?';

/** A BOT.md of the bot that is talked to now (`talk`) or has given that up (mention only). */
const driftMd = (talk: boolean): string =>
  [
    '---',
    'schema: 1',
    'name: Drift',
    'role: A bot that stops taking conversations',
    'kind: agent',
    'runtime: hermes',
    'model:',
    '  aliases: [smart]',
    'triggers:',
    ...(talk ? ['  - { type: conversation }'] : []),
    '  - { type: mention }',
    'capabilities:',
    '  native: [messages.post]',
    '---',
    '',
    '# Drift',
    '',
    'Answers questions, until it does not.',
    '',
  ].join('\n');

test.beforeAll(async ({ playwright }) => {
  stack = await startStack(conversationStackEnv());
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    driftId = (await addBot(stack, omar, 'drift', driftMd(true))).botId;

    // Nadia talks to it once while it still answers, and waits for the answer
    const nadia = await apiOn(playwright, stack, 'nadia');
    try {
      const opened = await nadia.post<{ channelId: string }>('/api/teams/engineering/bots/drift/conversation');
      channelId = opened.channelId;
      const root = await postAs(nadia, channelId, FIRST);
      await expect
        .poll(async () => (await nadia.get<{ items: unknown[] }>(`/api/channels/${channelId}/messages?threadRootId=${root.id}&limit=20`)).items.length, { timeout: 60_000 })
        .toBeGreaterThan(0);
    } finally {
      await nadia.ctx.dispose();
    }

    // its definition drops the trigger; the loader makes the roster say so
    const res = await applyGuarded(omar, 'bots/drift/BOT.md', driftMd(false), 'Drift stops taking conversations');
    expect(res.status, res.text).toBe(201);
    await expect
      .poll(
        async () => (await omar.get<{ bots: Array<{ slug: string; conversational: boolean }> }>('/api/teams/engineering/bots')).bots.find((b) => b.slug === 'drift')?.conversational,
        { timeout: 30_000 },
      )
      .toBe(false);
  } finally {
    await omar.ctx.dispose();
  }
});

test.afterAll(async () => {
  await stack?.stop();
});

test('a bot that dropped its conversation trigger keeps the lists; the message box and the reply box give way to the reason', async ({ browser, playwright, isMobile }) => {
  expect(await channelOf(stack, driftId, 'nadia')).toBe(channelId);
  const { page, close } = await openChat(browser, playwright, stack, 'nadia', '/t/engineering/bots/drift/chat', isMobile);
  try {
    // a bot with no conversation trigger has no 1:1 chat to offer: the roster and the bot's page draw no Talk control at all (not a disabled one)
    await page.goto('/t/engineering/bots');
    await expect(page.locator('[data-testid="bot-row"][data-bot="drift"]')).toBeVisible();
    await expect(page.locator('[data-testid="bot-row"][data-bot="drift"]').getByTestId('bot-talk')).toHaveCount(0);
    await expect(page.locator('[data-testid="bot-row"][data-bot="drift"]').getByTestId('bot-configure')).toBeVisible();
    await page.goto('/t/engineering/bots/drift');
    await expect(page.getByTestId('bot-title')).toContainText('Drift');
    await expect(page.getByTestId('open-conversation')).toHaveCount(0);
    await expect(page.getByTestId('talk-why')).toHaveCount(0);
    await page.goto('/t/engineering/bots/drift/chat');

    // the earlier conversation is still listed under Mine
    const row = page.getByTestId('conversation-row');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(FIRST);

    // the empty state says why nobody answers, and draws no message box
    const blocked = page.getByTestId('conversation-blocked');
    await expect(blocked).toBeVisible();
    await expect(blocked).toContainText('conversation trigger');
    await expect(page.getByRole('textbox', { name: 'Message Drift' })).toHaveCount(0);
    await expect(page.getByTestId('prompt-chip')).toHaveCount(0);

    // the old conversation opens and can be read, with the reason where the reply box would be
    await row.click();
    const thread = page.getByTestId('thread-view');
    await expect(thread).toContainText(FIRST);
    await expect(thread.getByTestId('reply-blocked')).toContainText('conversation trigger');
    await expect(page.getByRole('textbox', { name: 'Reply in thread' })).toHaveCount(0);
  } finally {
    await close();
  }
});

test('a list longer than a page: the first page, then "Show older" until nothing is left', async ({ browser, playwright, isMobile }) => {
  // the channel is hers and nothing answers in it now, so thirty-two more conversations are cheap to make: roots only
  const nadia = await apiOn(playwright, stack, 'nadia');
  try {
    for (let i = 1; i <= 32; i += 1) await postAs(nadia, channelId, `Question number ${i} about the migration`);
    await expect
      .poll(async () => (await nadia.get<{ items: unknown[] }>('/api/teams/engineering/bots/drift/conversations?scope=mine&limit=100')).items.length, { timeout: 60_000 })
      .toBe(33);
  } finally {
    await nadia.ctx.dispose();
  }

  const { page, close } = await openChat(browser, playwright, stack, 'nadia', '/t/engineering/bots/drift/chat', isMobile);
  try {
    const rows = page.getByTestId('conversation-row');
    await expect(rows).toHaveCount(30);
    const older = page.getByTestId('conversation-older');
    await expect(older).toBeVisible();
    await expect(older).toHaveText('Show older');
    await older.click();
    // the rest of the list arrives after the first page, once, and the control goes with the last page
    await expect(rows).toHaveCount(33);
    await expect(older).toHaveCount(0);
    await expect(page.getByTestId('conversation-row').filter({ hasText: FIRST })).toHaveCount(1);
  } finally {
    await close();
  }
});
