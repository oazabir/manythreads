import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { addBot, answerStackEnv, answeringBrainMd } from '../conversations/support.ts';
import { apiOn, channelsOf, noSidewaysScroll } from '../support/stack-browser.ts';
import { openBot } from './support.ts';

/*
 * The bot page's Test action (PLAN P7-11) end to end. A workspace admin presses Test on Brain, types one question and reads the bot's answer in the panel;
 * the stand-in Hermes of conversations/fake-hermes-answer.mjs tries to post a message into #dev and to write a page before it answers, and the real MCP
 * gateway holds both back: the panel lists them as "not done — rehearsal", #dev gets nothing, no page is written and no approval is filed. A bot with no
 * knowledge base says so. A plain member is not offered the button and the API refuses them too. Desktop and phone width.
 */
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let dev = '';
const SAID = 'I would post that message and write that page, but nothing was done.';
const WRITTEN = 'Written by the rehearsal bot: never visible';

test.beforeAll(async ({ playwright }) => {
  stack = await startStack(answerStackEnv());
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    // Brain may read, post, write pages and finish with an Answer: everything the stand-in tries is something it is allowed to do on a normal run
    await addBot(stack, omar, 'brain', answeringBrainMd().replace('answer.post]', 'answer.post, pages.write]'));
    dev = (await channelsOf(omar))['dev']!;
  } finally {
    await omar.ctx.dispose();
  }
});
test.afterAll(async () => {
  await stack?.stop();
});

test('a lead presses Test, asks one question, reads the answer, and every write the bot tried is listed as not done', async ({ browser, playwright, isMobile }) => {
  const { page, close } = await openBot(browser, playwright, stack, 'omar', 'brain');
  try {
    await page.getByTestId('open-test').click();
    const panel = page.getByTestId('test-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('nothing it tries to change is done');

    // an empty question is not sent
    await page.getByTestId('test-run').click();
    await expect(page.getByTestId('test-problem')).toContainText('Type a question first');

    await page.getByTestId('test-question').fill(`REHEARSE-WRITE ${dev}`);
    await page.getByTestId('test-run').click();

    const result = page.getByTestId('test-result');
    await expect(result).toBeVisible({ timeout: 90_000 });
    await expect(result).toHaveAttribute('data-status', 'answered');
    await expect(page.getByTestId('test-answer')).toContainText(SAID);

    // both writes were held back, each badged, with what it aimed at and never what it would have written
    const held = page.getByTestId('test-intercepted');
    await expect(held).toHaveCount(2);
    await expect(held.nth(0)).toContainText('not done — rehearsal');
    await expect(held.nth(0)).toContainText('Post a message');
    await expect(held.nth(0)).toContainText(dev);
    await expect(held.nth(1)).toContainText('Write a page');
    await expect(held.nth(1)).toContainText('pages/rehearsal-probe.md');
    await expect(page.getByTestId('test-held')).not.toContainText(WRITTEN);

    // the bot has no knowledge base: it says so rather than leave the answer to look sourced
    await expect(page.getByTestId('test-knowledge')).toContainText('no knowledge base');
    if (isMobile) expect(await noSidewaysScroll(page)).toBe(true);

    // the question stays in the lead's own conversation, which the link opens
    await page.getByTestId('test-open-conversation').click();
    await expect(page).toHaveURL(/\/t\/engineering\/bots\/brain\/chat/);
  } finally {
    await close();
  }

  // nothing was done: #dev has no message from the bot, no page was written, no approval waits, and the question is in no channel but the private one
  expect(await stack.sql('SELECT 1 FROM app.messages WHERE body = $1', [WRITTEN])).toHaveLength(0);
  expect(await stack.sql('SELECT 1 FROM app.messages WHERE channel_id = $1 AND body LIKE $2', [dev, 'REHEARSE-WRITE%'])).toHaveLength(0);
  expect(await stack.sql("SELECT 1 FROM app.approvals WHERE tool = 'pages.write'")).toHaveLength(0);
  const lines = await stack.sql<{ capability: string }>('SELECT capability FROM app.rehearsal_intercepts ORDER BY seq');
  expect(lines.map((l) => l.capability)).toEqual(['messages.post', 'pages.write']);
});

test('a plain member is not offered Test, and the API refuses them', async ({ browser, playwright }) => {
  const { page, close } = await openBot(browser, playwright, stack, 'nadia', 'brain');
  try {
    await expect(page.getByTestId('bot-title')).toContainText('Brain');
    await expect(page.getByTestId('open-test')).toHaveCount(0);
  } finally {
    await close();
  }
  const nadia = await apiOn(playwright, stack, 'nadia');
  try {
    expect(await nadia.status('POST', '/api/teams/engineering/bots/brain/test', { question: 'Let me in?' })).toBe(403);
  } finally {
    await nadia.ctx.dispose();
  }
});

test('the client cannot make a run a rehearsal or a normal message one: the body takes the question and nothing else', async ({ playwright }) => {
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    expect(await omar.status('POST', '/api/teams/engineering/bots/brain/test', { question: 'Hi', rehearsal: false })).toBe(400);
    expect(await omar.status('POST', '/api/teams/engineering/bots/brain/test', { question: '' })).toBe(400);
    expect(await omar.status('POST', '/api/teams/engineering/bots/no-such-bot/test', { question: 'Hi' })).toBe(404);
  } finally {
    await omar.ctx.dispose();
  }
});
