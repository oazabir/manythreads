import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { noSidewaysScroll, openOn, PHONE } from '../support/stack-browser.ts';
import { addBot, apiOn, conversationStackEnv } from '../conversations/support.ts';

/*
 * Opening a bot from the sidebar (PLAN P29-13): a bot that allows chatting opens its chat; one that does not says "No chat is available" with the way to its settings only for a
 * person who may change them; the customization is under "Bot settings" (a button in the chat header for the same people); an old `?tab=` address goes there.
 * Omar is a workspace admin; Nadia is a member of Engineering who does not lead it. Pictures go to temp/screenshots/p29 (git-ignored).
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout; the 390 px picture is taken inside the test');
test.describe.configure({ mode: 'serial' });

const SHOTS = join(import.meta.dirname, '..', '..', 'temp', 'screenshots', 'p29');
let stack: Stack;

/** A bot with a mention trigger and no conversation trigger: nobody can chat with it. */
const quietMd = [
  '---',
  'schema: 1',
  'name: Quiet',
  'role: Answers when it is mentioned',
  'kind: agent',
  'runtime: hermes',
  'model:',
  '  aliases: [smart]',
  'triggers:',
  '  - { type: mention }',
  'capabilities:',
  '  native: [messages.post]',
  '---',
  '',
  '# Quiet',
  '',
  'Works on mentions only.',
  '',
].join('\n');

const talkingMd = quietMd.replace('name: Quiet', 'name: Talker').replace('# Quiet', '# Talker').replace('  - { type: mention }', '  - { type: conversation }\n  - { type: mention }');

test.beforeAll(async ({ playwright }) => {
  mkdirSync(SHOTS, { recursive: true });
  stack = await startStack(conversationStackEnv());
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    await addBot(stack, omar, 'quiet', quietMd);
    await addBot(stack, omar, 'talker', talkingMd);
  } finally {
    await omar.ctx.dispose();
  }
});
test.afterAll(async () => {
  await stack?.stop();
});

test('clicking a bot that allows chatting in the sidebar opens its chat, and the header has Bot settings for an admin only', async ({ browser, playwright }) => {
  const omar = await openOn(browser, playwright, stack, 'omar', '/t/engineering');
  try {
    await omar.page.locator('[data-landmark="sidebar"]').locator('[data-testid="sidebar-bot"][data-bot="talker"]').click();
    await expect(omar.page).toHaveURL(/\/t\/engineering\/bots\/talker\/chat$/);
    await expect(omar.page.getByTestId('conversation-view')).toBeVisible();
    // the row stays marked while its chat is open
    await expect(omar.page.locator('[data-testid="sidebar-bot"][data-bot="talker"]')).toHaveClass(/on/);
    await omar.page.getByTestId('bot-settings-link').click();
    await expect(omar.page).toHaveURL(/\/t\/engineering\/bots\/talker\/settings$/);
    await expect(omar.page.getByTestId('bot-page')).toBeVisible();
    // and the way back
    await omar.page.getByTestId('open-conversation').click();
    await expect(omar.page).toHaveURL(/\/bots\/talker\/chat$/);
  } finally {
    await omar.context.close();
  }
  const nadia = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/bots/talker/chat');
  try {
    await expect(nadia.page.getByTestId('conversation-view')).toBeVisible();
    await expect(nadia.page.getByTestId('bot-settings-link')).toHaveCount(0);
  } finally {
    await nadia.context.close();
  }
});

test('a bot with no chat says so, and an admin gets a Bot settings button that opens the settings', async ({ browser, playwright }) => {
  const omar = await openOn(browser, playwright, stack, 'omar', '/t/engineering');
  try {
    await omar.page.locator('[data-landmark="sidebar"]').locator('[data-testid="sidebar-bot"][data-bot="quiet"]').click();
    await expect(omar.page).toHaveURL(/\/t\/engineering\/bots\/quiet$/);
    await expect(omar.page.getByTestId('bot-no-chat-title')).toHaveText('No chat is available with Quiet.');
    await expect(omar.page.getByTestId('bot-no-chat-why')).toContainText('no one-to-one chat');
    await omar.page.screenshot({ path: join(SHOTS, 'bot-no-chat.admin.1440.png') });
    await omar.page.getByTestId('bot-settings-button').click();
    await expect(omar.page).toHaveURL(/\/t\/engineering\/bots\/quiet\/settings$/);
    await expect(omar.page.getByTestId('bot-title')).toContainText('Quiet');
  } finally {
    await omar.context.close();
  }
});

test('a member without the right sees the reason and no button', async ({ browser, playwright }) => {
  const nadia = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/bots/quiet');
  try {
    await expect(nadia.page.getByTestId('bot-no-chat-title')).toHaveText('No chat is available with Quiet.');
    await expect(nadia.page.getByTestId('bot-settings-button')).toHaveCount(0);
    await expect(nadia.page.getByTestId('bot-no-chat-who')).toContainText('team lead');
    await nadia.page.screenshot({ path: join(SHOTS, 'bot-no-chat.member.1440.png') });
  } finally {
    await nadia.context.close();
  }
});

test('at 390 px the empty state is one column and the button is 44 px high and as wide as the screen allows', async ({ browser, playwright }) => {
  const omar = await openOn(browser, playwright, stack, 'omar', '/t/engineering/bots/quiet', { viewport: PHONE, mobile: true });
  try {
    const button = omar.page.getByTestId('bot-settings-button');
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(await noSidewaysScroll(omar.page)).toBe(true);
    await omar.page.screenshot({ path: join(SHOTS, 'bot-no-chat.admin.390.png') });
  } finally {
    await omar.context.close();
  }
});

test('an old address with ?tab= goes to the settings, keeping the tab', async ({ browser, playwright }) => {
  const omar = await openOn(browser, playwright, stack, 'omar', '/t/engineering/bots/talker?tab=safety');
  try {
    await expect(omar.page).toHaveURL(/\/t\/engineering\/bots\/talker\/settings\?tab=safety$/);
    await expect(omar.page.getByTestId('bot-page')).toBeVisible();
  } finally {
    await omar.context.close();
  }
});
