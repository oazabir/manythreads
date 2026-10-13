import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { channelsOf, postAs } from '../support/stack-browser.ts';
import { addBot, apiOn, brainMd, channelOf, conversationStackEnv, openChat } from './support.ts';

/*
 * Talking to a bot (PLAN P5-16, SPEC §6.2, `[proto §12]`): the conversation view at /t/:team/bots/:botSlug/chat. A person's message goes
 * through the real router; the Hermes runtime is the stand-in of ./fake-hermes.mjs, so a real run is opened for them and the bot's reply is
 * posted into the thread by the platform. The empty state and the send run on both layouts; the rest is a desktop check of who may see what.
 * One stack for the whole file because the conversations build on each other (the person who talked, who may read it, what is shared).
 */
test.describe.configure({ mode: 'serial' });

const PROMPTS = ['What is blocking the release?', 'Where are the 2.4 release notes?'] as const;

let stack: Stack;
let brainId = '';

test.beforeAll(async ({ playwright }) => {
  stack = await startStack(conversationStackEnv());
  const omar = await apiOn(playwright, stack, 'omar');
  brainId = (await addBot(stack, omar, 'brain', brainMd(PROMPTS))).botId;
  await omar.ctx.dispose();
});
test.afterAll(async () => {
  await stack?.stop();
});

/** The thread's replies by anybody but the person, read as the person: a poll that ends when the bot has answered. */
async function waitForReply(who: Parameters<typeof apiOn>[2], playwright: Parameters<typeof apiOn>[0], channelId: string, rootId: string): Promise<void> {
  const api = await apiOn(playwright, stack, who);
  try {
    await expect
      .poll(async () => (await api.get<{ items: unknown[] }>(`/api/channels/${channelId}/messages?threadRootId=${rootId}&limit=20`)).items.length, { timeout: 60_000 })
      .toBeGreaterThan(0);
  } finally {
    await api.ctx.dispose();
  }
}

test('the empty state is the bot, its example questions and the message box; there is no "new conversation" button', async ({ browser, playwright, isMobile }) => {
  const { page, close } = await openChat(browser, playwright, stack, 'priya', '/t/engineering/bots/brain/chat', isMobile);
  try {
    await expect(page.getByTestId('app-frame')).toBeVisible();
    const start = page.getByTestId('conversation-start');
    await expect(start).toBeVisible();
    await expect(page.getByTestId('conversation-bot')).toHaveText('Brain');
    await expect(start).toContainText('Answers from what the team knows');
    // the chips are the bot's own `conversation.prompts`
    await expect(page.getByTestId('prompt-chips')).toHaveAttribute('data-source', 'definition');
    await expect(page.getByTestId('prompt-chip')).toHaveText([...PROMPTS]);
    await expect(page.getByRole('textbox', { name: 'Message Brain' })).toBeVisible();
    await expect(page.getByRole('button', { name: /new conversation/i })).toHaveCount(0);
    await expect(page.getByTestId('conversation-list-empty')).toContainText('Ask Brain something below');
    await expect(page.getByRole('tab', { name: 'Mine' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Shared' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Channel mentions' })).toBeVisible();
  } finally {
    await close();
  }

  // a bot that names no prompts shows the platform's defaults
  const other = await openChat(browser, playwright, stack, 'priya', '/t/engineering/bots/coder/chat', isMobile);
  try {
    await expect(other.page.getByTestId('conversation-bot')).toHaveText('Coder');
    await expect(other.page.getByTestId('prompt-chips')).toHaveAttribute('data-source', 'default');
    expect(await other.page.getByTestId('prompt-chip').count()).toBeGreaterThan(0);
  } finally {
    await other.close();
  }
});

test('the conversation is not in the sidebar: not as a channel, not as a direct message', async ({ playwright }) => {
  const api = await apiOn(playwright, stack, 'priya');
  try {
    const opened = await api.post<{ channelId: string }>('/api/teams/engineering/bots/brain/conversation');
    const directory = JSON.stringify(await api.get('/api/teams/engineering/channels'));
    expect(directory).not.toContain(opened.channelId);
    expect(JSON.stringify(await api.get('/api/dms'))).not.toContain(opened.channelId);
  } finally {
    await api.ctx.dispose();
  }
});

test('sending starts a thread: the message is its root, the view switches to it and the bot answers in it', async ({ browser, playwright, isMobile }) => {
  const { page, close } = await openChat(browser, playwright, stack, 'nadia', '/t/engineering/bots/brain/chat', isMobile);
  try {
    const box = page.getByRole('textbox', { name: 'Message Brain' });
    await box.fill('What is blocking the schedule migration?');
    await box.press('Enter');

    // the view switches to the new thread (the URL names it), with the person's message as its root
    await expect(page).toHaveURL(/[?&]thread=[0-9a-f-]{36}/);
    const thread = page.getByTestId('thread-view');
    await expect(thread).toBeVisible();
    await expect(thread).toContainText('What is blocking the schedule migration?');
    // the bot's reply arrives in the same thread, live: the stand-in repeats the prompt it was run with (the person and the message)
    await expect(thread).toContainText('Answering: Nadia: What is blocking the schedule migration?', { timeout: 60_000 });

    // a real run, for this person, started by the conversation trigger in their channel
    const run = (
      await stack.sql<{ trigger_type: string; status: string; asker: string }>(
        `SELECT r.trigger_type, r.status, p.primary_email AS asker FROM app.bot_runs r
           JOIN app.actors a ON a.id = r.asker_id JOIN app.people p ON p.id = a.ref_id
          WHERE r.bot_id = $1 ORDER BY r.started_at DESC LIMIT 1`,
        [brainId],
      )
    )[0];
    expect(run).toMatchObject({ trigger_type: 'conversation', asker: 'nadia@kahf.example' });

    // it is the first row of Mine, private to her
    if (isMobile) await page.getByTestId('conversation-back').click();
    const row = page.getByTestId('conversation-row').first();
    await expect(row).toBeVisible();
    await expect(row).toContainText('What is blocking the schedule migration?');
    await expect(row.getByTestId('conversation-label')).toHaveText('Private to you');
    await expect(row).toContainText('Brain: Answering', { timeout: 30_000 });
  } finally {
    await close();
  }
});

test('an example question is sent as written, and starts its own thread', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'desktop layout');
  const { page, close } = await openChat(browser, playwright, stack, 'priya', '/t/engineering/bots/brain/chat', false);
  try {
    await page.getByTestId('prompt-chip').first().click();
    await expect(page).toHaveURL(/[?&]thread=/);
    const thread = page.getByTestId('thread-view');
    await expect(thread).toContainText(PROMPTS[0]);
    await expect(thread).toContainText(`Answering: Priya: ${PROMPTS[0]}`, { timeout: 60_000 });
    // Mine lists hers only: Nadia's conversation is not there
    await expect(page.getByTestId('conversation-row')).toHaveCount(1);
  } finally {
    await close();
  }
});

test('private by default: a second member sees an empty list and cannot open it, nor can an admin', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'desktop layout');
  const nadiaChannel = await channelOf(stack, brainId, 'nadia');
  const root = (
    await stack.sql<{ thread_root_id: string }>(
      `SELECT c.thread_root_id FROM app.conversations c JOIN app.people p ON p.id = c.person_id WHERE c.bot_id = $1 AND p.primary_email = 'nadia@kahf.example'`,
      [brainId],
    )
  )[0]!.thread_root_id;

  const rafi = await openChat(browser, playwright, stack, 'rafi', '/t/engineering/bots/brain/chat', false);
  try {
    // Rafi talked to nobody: his own list is empty, whatever Nadia and Priya asked
    await expect(rafi.page.getByTestId('conversation-list-empty')).toBeVisible();
    await expect(rafi.page.getByTestId('conversation-row')).toHaveCount(0);
    // the thread by its address is refused, not "not found"-then-shown
    await rafi.page.goto(`/t/engineering/chat/${nadiaChannel}?thread=${root}`);
    await expect(rafi.page.getByTestId('no-access')).toBeVisible();
    await expect(rafi.page.getByText('What is blocking the schedule migration?')).toHaveCount(0);
  } finally {
    await rafi.close();
  }

  for (const who of ['rafi', 'omar'] as const) {
    const api = await apiOn(playwright, stack, who);
    try {
      expect(await api.status('GET', `/api/channels/${nadiaChannel}/messages?limit=20`), `${who} messages`).toBe(403);
      expect(await api.status('GET', `/api/channels/${nadiaChannel}`), `${who} channel`).toBe(403);
      expect([403, 404], `${who} thread`).toContain(await api.status('GET', `/api/threads/${root}`));
    } finally {
      await api.ctx.dispose();
    }
  }
});

test('Shared lists what the team may open; somebody else’s opens through the shared copy, and a person of another team has no way in', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'desktop layout');
  // P5-17 builds the sharing itself (masking, preview, the access event); the data model is what this checks, so the row is arranged
  const nadia = await apiOn(playwright, stack, 'nadia');
  const dev = (await channelsOf(nadia))['dev']!;
  const copyText = 'Shared with the team: what is blocking the schedule migration';
  const copy = await postAs(nadia, dev, copyText);
  await nadia.ctx.dispose();
  await stack.sql(
    `UPDATE app.conversations c SET visibility = 'shared', shared_to = $2, shared_root_id = $3, shared_by = a.id, shared_at = now()
       FROM app.people p JOIN app.actors a ON a.kind = 'person' AND a.ref_id = p.id
      WHERE c.person_id = p.id AND p.primary_email = 'nadia@kahf.example' AND c.bot_id = $1`,
    [brainId, dev, copy.id],
  );

  const rafi = await openChat(browser, playwright, stack, 'rafi', '/t/engineering/bots/brain/chat?tab=shared', false);
  try {
    const row = rafi.page.getByTestId('conversation-row');
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('conversation-label')).toHaveText('Shared by Nadia');
    await expect(row).toContainText(copyText);
    await row.click();
    await expect(rafi.page.getByTestId('thread-view')).toContainText(copyText);
    // Mine is still empty for him
    await rafi.page.getByTestId('conversation-tab-mine').click();
    await expect(rafi.page.getByTestId('conversation-list-empty')).toBeVisible();
  } finally {
    await rafi.close();
  }

  const mine = await openChat(browser, playwright, stack, 'nadia', '/t/engineering/bots/brain/chat?tab=shared', false);
  try {
    await expect(mine.page.getByTestId('conversation-row').getByTestId('conversation-label')).toHaveText('Shared with the team');
  } finally {
    await mine.close();
  }

  // Sameera is on another team: the bot is not hers to talk to, and its conversations are not hers to list
  const sameera = await openChat(browser, playwright, stack, 'sameera', '/t/engineering/bots/brain/chat?tab=shared', false);
  try {
    await expect(sameera.page.getByText('You do not have access')).toBeVisible();
    await expect(sameera.page.getByTestId('conversation-row')).toHaveCount(0);
  } finally {
    await sameera.close();
  }
});

test('Channel mentions lists the threads where the person named the bot — theirs only', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'desktop layout');
  const nadia = await apiOn(playwright, stack, 'nadia');
  const dev = (await channelsOf(nadia))['dev']!;
  const text = '@brain do we have the QA batch 7 numbers?';
  const mention = await postAs(nadia, dev, text);
  await nadia.ctx.dispose();
  await waitForReply('nadia', playwright, dev, mention.id);

  const mine = await openChat(browser, playwright, stack, 'nadia', '/t/engineering/bots/brain/chat?tab=mentions', false);
  try {
    const row = mine.page.getByTestId('conversation-row');
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('data-source', 'mention');
    await expect(row.getByTestId('conversation-label')).toHaveText('Channel mention · # dev');
    await expect(row).toContainText(text);
    // the thread is the channel's own: opening it shows the question and the bot's answer, and the way to the channel
    await row.click();
    await expect(mine.page.getByTestId('thread-view')).toContainText('Answering: Nadia in #dev:');
  } finally {
    await mine.close();
  }

  const rafi = await openChat(browser, playwright, stack, 'rafi', '/t/engineering/bots/brain/chat?tab=mentions', false);
  try {
    await expect(rafi.page.getByTestId('conversation-list-empty')).toContainText('No mentions yet');
  } finally {
    await rafi.close();
  }
});
