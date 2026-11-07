import { expect, test, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { channelsOf, noSidewaysScroll, postAs } from '../support/stack-browser.ts';
import { addBot, answerStackEnv, answeringBrainMd, apiOn, openChat } from './support.ts';

/*
 * P21-07: a bot's reply reads as a message. The Bot tag beside the name and the bot badge on the avatar; an answer with no sources is plain text
 * (same data-testid="answer", no card); an answer with sources is a bordered card, its numbered citations stay in view and the lineage, reached
 * and outside-scope parts sit under a "Sources (n)" line that is closed. Same stand-in Hermes as answer.spec.ts; desktop and mobile-web.
 */
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let devMessage = '';
const PUBLIC_TEXT = 'The deploy waits for the Monday change window';

test.beforeAll(async ({ playwright }) => {
  stack = await startStack(answerStackEnv());
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    await addBot(stack, omar, 'helper', answeringBrainMd());
    devMessage = (await postAs(omar, (await channelsOf(omar))['dev']!, PUBLIC_TEXT)).id;
  } finally {
    await omar.ctx.dispose();
  }
});
test.afterAll(async () => {
  await stack?.stop();
});

const send = async (page: Page, text: string): Promise<void> => {
  const box = page.getByRole('textbox', { name: 'Message Brain' });
  await box.fill(text);
  await box.press('Enter');
  await expect(page).toHaveURL(/[?&]thread=[0-9a-f-]{36}/);
};

/** The bot's message row that holds the answer. */
const botRow = (page: Page) => page.getByTestId('message').filter({ has: page.getByTestId('answer') });

test('a reply without sources is plain text with a Bot tag: no card, no Sources line', async ({ browser, playwright, isMobile }) => {
  const { page, close } = await openChat(browser, playwright, stack, 'priya', '/t/engineering/bots/helper/chat', isMobile);
  try {
    await send(page, 'ANSWER-TWICE please');
    const answer = page.getByTestId('answer');
    await expect(answer).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('answer-text')).toContainText('The one and only answer.');
    await expect(answer).toHaveAttribute('data-citations', '0');
    await expect(answer).toHaveClass(/an-plain/);
    await expect(answer).not.toHaveClass(/an-card/);
    // plain: no border and no wash
    expect(await answer.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px');
    await expect(page.getByTestId('answer-citation')).toHaveCount(0);
    await expect(page.getByTestId('answer-sources')).toHaveCount(0);

    // the Bot tag beside the name, the badge on the avatar
    const row = botRow(page);
    await expect(row.locator('.who .wh-mark.bot')).toHaveText('Bot');
    await expect(row.locator('.av-wrap .av-badge.bot')).toHaveCount(1);
    // the footer says it in words, the raw line is the tooltip
    await expect(page.getByTestId('answer-for')).toHaveText(/^Used your private notes/);
    await expect(page.getByTestId('answer-for')).toHaveAttribute('title', /^Answered for Priya · /);
    if (isMobile) expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await close();
  }
});

test('a reply with sources is a bordered card, the citations stay in view and the Sources line is closed until opened', async ({ browser, playwright, isMobile }) => {
  const { page, close } = await openChat(browser, playwright, stack, 'nadia', '/t/engineering/bots/helper/chat', isMobile);
  try {
    await send(page, `ANSWER-WITH-SOURCES ${devMessage}`);
    const answer = page.getByTestId('answer');
    await expect(answer).toBeVisible({ timeout: 60_000 });
    await expect(answer).toHaveClass(/an-card/);
    expect(await answer.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('1px');
    await expect(botRow(page).locator('.who .wh-mark.bot')).toHaveText('Bot');

    // numbered citations are visible without opening anything
    const cites = page.getByTestId('answer-citation');
    await expect(cites).toHaveCount(1);
    await expect(cites.first()).toBeVisible();

    // "Sources (1)" is closed; its parts are hidden until it is opened
    const sources = page.getByTestId('answer-sources');
    await expect(sources.locator('summary')).toHaveText('Sources (1)');
    await expect(sources).not.toHaveAttribute('open', '');
    await expect(page.getByTestId('answer-lineage')).toBeHidden();
    await sources.locator('summary').click();
    await expect(sources).toHaveAttribute('open', '');
    await expect(page.getByTestId('answer-lineage')).toBeVisible();
    await sources.locator('summary').click();
    await expect(page.getByTestId('answer-lineage')).toBeHidden();
    if (isMobile) expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await close();
  }
});
