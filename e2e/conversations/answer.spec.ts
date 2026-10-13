import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { channelsOf, noSidewaysScroll, postAs } from '../support/stack-browser.ts';
import { addBot, answerStackEnv, answeringBrainMd, apiOn, openChat } from './support.ts';

/*
 * The Answer in the conversation view (PLAN P5-18, SPEC §12.4, `[proto §12]` plate 2). A person asks a bot; the stand-in Hermes of
 * ./fake-hermes-answer.mjs behaves like a model that finishes with the `answer.post` tool, calling it over the run's real MCP endpoint with the
 * ids it finds in the prompt; the platform re-reads them as the person who asked and posts the message. Only the model is missing. Every flow
 * runs on desktop and mobile-web.
 */
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let devMessage = '';
let leadsMessage = '';
const PUBLIC_TEXT = 'The deploy waits for the Monday change window';
const SECRET_TEXT = 'Layoffs are planned for March';

test.beforeAll(async ({ playwright }) => {
  stack = await startStack(answerStackEnv());
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    await addBot(stack, omar, 'brain', answeringBrainMd());
    // a message in #dev, and one in a private channel that only Omar is in
    const dev = (await channelsOf(omar))['dev']!;
    devMessage = (await postAs(omar, dev, PUBLIC_TEXT)).id;
    const leads = await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name: 'leads', private: true });
    leadsMessage = (await postAs(omar, leads.channel.id, SECRET_TEXT)).id;
  } finally {
    await omar.ctx.dispose();
  }
});
test.afterAll(async () => {
  await stack?.stop();
});

test('a bot finishes with an Answer: the sources the person may open, what was out of scope, and whom it was for', async ({ browser, playwright, isMobile }) => {
  const { page, close } = await openChat(browser, playwright, stack, 'nadia', '/t/engineering/bots/brain/chat', isMobile);
  try {
    const box = page.getByRole('textbox', { name: 'Message Brain' });
    await box.fill(`ANSWER-WITH-SOURCES ${devMessage} ${leadsMessage}`);
    await box.press('Enter');
    await expect(page).toHaveURL(/[?&]thread=[0-9a-f-]{36}/);

    const answer = page.getByTestId('answer');
    await expect(answer).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('answer-text')).toContainText('The deploy is waiting for the Monday window');

    // one source she may open, labelled with the platform's own reading of it — the second is gone, and so is everything of it
    const cites = page.getByTestId('answer-citation');
    await expect(cites).toHaveCount(1);
    await expect(cites.first()).toContainText(PUBLIC_TEXT);
    await expect(cites.first()).toHaveAttribute('data-n', '1');
    await expect(page.getByTestId('answer-lineage-row')).toHaveCount(1);
    await expect(page.getByTestId('answer-lineage')).toContainText(PUBLIC_TEXT);
    await expect(page.getByTestId('answer-outside')).toContainText('1 message · not visible to the person who asked');
    await expect(page.getByText('Layoffs')).toHaveCount(0);
    await expect(page.getByText('a quote that must never be shown')).toHaveCount(0);
    // (the person's own message above shows the ids she typed; the Answer shows nothing of the one she cannot read)
    await expect(answer).not.toContainText(leadsMessage);

    // whom it was for, and the suggestions (data only here)
    await expect(page.getByTestId('answer-for')).toHaveText('Answered for Nadia · scoped · smart');
    await expect(page.getByTestId('answer-chips')).toContainText('@Coder');
    await expect(page.getByTestId('answer-followups')).toContainText('When does it open?');

    // the model's own closing text was not posted as a second reply
    await expect(page.getByTestId('message').filter({ hasText: 'Posted my answer above.' })).toHaveCount(0);
    await expect(page.getByTestId('answer')).toHaveCount(1);

    if (isMobile) expect(await noSidewaysScroll(page)).toBe(true);

    // a citation chip opens the cited item: the message, in its channel
    await cites.first().click();
    await expect(page).toHaveURL(/\/t\/engineering\/c\/dev\?message=/);
  } finally {
    await close();
  }
});

test('the answer is the person’s own: nobody else reads the thread, and the Answer is not in the sidebar or anybody’s lists', async ({ browser, playwright, isMobile }) => {
  const rafi = await openChat(browser, playwright, stack, 'rafi', '/t/engineering/bots/brain/chat', isMobile);
  try {
    await expect(rafi.page.getByTestId('conversation-list-empty')).toBeVisible();
    await expect(rafi.page.getByTestId('answer')).toHaveCount(0);
    await expect(rafi.page.locator('body')).not.toContainText('Monday window');
  } finally {
    await rafi.close();
  }
});

test('one answer per run: a second call is refused and the thread has the first', async ({ browser, playwright, isMobile }) => {
  const { page, close } = await openChat(browser, playwright, stack, 'priya', '/t/engineering/bots/brain/chat', isMobile);
  try {
    const box = page.getByRole('textbox', { name: 'Message Brain' });
    await box.fill('ANSWER-TWICE please');
    await box.press('Enter');
    await expect(page.getByTestId('answer-text')).toContainText('The one and only answer.', { timeout: 60_000 });
    await expect(page.getByTestId('answer')).toHaveCount(1);
    await expect(page.getByText('A second answer, which must not appear.')).toHaveCount(0);
  } finally {
    await close();
  }
});

test('a citation of a kind this client has never seen is a neutral chip and the answer still reads', async ({ browser, playwright, isMobile }) => {
  // arrange what only a newer server would write: a `memory` citation (P5-27) next to the known one, on the first answer's message
  const answered = (
    await stack.sql<{ id: string; meta: { answer: { citations: unknown[] } } }>(
      `SELECT m.id, m.meta FROM app.messages m WHERE m.meta ? 'answer' AND m.body LIKE 'The deploy is waiting%' ORDER BY m.created_at LIMIT 1`,
    )
  )[0]!;
  const withMemory = {
    ...answered.meta,
    answer: {
      ...answered.meta.answer,
      citations: [...answered.meta.answer.citations, { kind: 'memory', n: 2, conceptPath: 'memory/facts/window.md', trustTier: 'human-reviewed', stale: false, deprecated: false }],
    },
  };
  // the row's trigger keeps a message's meta fixed for every caller but the system role: the owner lifts it for this one statement
  await stack.sql(
    `ALTER TABLE app.messages DISABLE TRIGGER messages_before_update;
     UPDATE app.messages SET meta = '${JSON.stringify(withMemory).replaceAll("'", "''")}'::jsonb WHERE id = '${answered.id}';
     ALTER TABLE app.messages ENABLE TRIGGER messages_before_update;`,
  );
  const thread = (
    await stack.sql<{ thread_root_id: string; channel_id: string }>('SELECT thread_root_id, channel_id FROM app.messages WHERE id = $1', [answered.id])
  )[0]!;
  const { page, close } = await openChat(browser, playwright, stack, 'nadia', `/t/engineering/chat/${thread.channel_id}?thread=${thread.thread_root_id}`, isMobile);
  try {
    await expect(page.getByTestId('answer')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('answer-citation')).toHaveCount(2);
    await expect(page.locator('[data-testid="answer-citation"][data-kind="memory"]')).toContainText('Unsupported source');
    await expect(page.getByTestId('answer-text')).toContainText('The deploy is waiting for the Monday window');
  } finally {
    await close();
  }
});
