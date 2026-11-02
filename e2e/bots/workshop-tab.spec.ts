import { expect, test } from '@playwright/test';
import { startFakeLlm, type FakeLlm } from '../../tools/fake-llm/src/server.ts';
import { addBot, brainMd, conversationStackEnv } from '../conversations/support.ts';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, apiOn, noSidewaysScroll, openOn } from '../support/stack-browser.ts';

/*
 * The Workshop tab of a bot in the browser (PLAN P7-05, P7-06): Build, Rehearse, Live. The model is a stand-in that answers with what this spec scripts; everything else is the real server: the
 * Rehearse sandbox (the platform holds back every write and badges it "not really done"), the proposals a correction becomes (a lesson, a test case, a rule) and the permission checks. Both
 * layouts. Runs on a stack of its own because it adds a bot and files proposals.
 */
test.describe.configure({ mode: 'serial' });

type Step = { text: string } | { calls: Array<{ name: string; args: unknown }> };
type Kind = 'build' | 'live' | 'rehearse' | 'other';
const scripts: Record<Kind, Step[]> = { build: [], live: [], rehearse: [], other: [] };
let counter = 0;
let fake: FakeLlm;
let stack: Stack;

const kindOf = (messages: Array<{ role: string; content: string }>): Kind => {
  const system = messages[0]?.content ?? '';
  if (system.includes('You are the Workshop helper') && system.includes('You help a person improve a bot')) return 'build';
  if (system.includes('You are the Workshop helper') && system.includes('records of its runs')) return 'live';
  if (system.includes('RELEASE-HELPER-BODY')) return 'rehearse';
  return 'other';
};

const BOT_MD = [
  '---',
  'schema: 1',
  'name: Releaser',
  'role: Answers questions about the release checklist.',
  'kind: agent',
  'runtime: hermes',
  'model:',
  '  aliases: [smart]',
  'triggers:',
  '  - { type: mention }',
  'capabilities:',
  '  native: [messages.post, messages.search, answer.post, pages.write]',
  '---',
  '',
  'RELEASE-HELPER-BODY: you answer questions about the release checklist. If you do not know, say so and ask a person.',
  '',
].join('\n');

test.beforeAll(async ({ playwright }) => {
  fake = await startFakeLlm({
    masterKey: 'sk-fake',
    completion: ({ messages }) => {
      const next = scripts[kindOf(messages)].shift();
      if (!next) return 'Nothing more to do.';
      if ('text' in next) return next.text;
      counter += 1;
      return {
        status: 200,
        body: {
          id: `chatcmpl-e2e-${String(counter)}`,
          model: 'smart',
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: next.calls.map((c, i) => ({ id: `call_${String(counter)}_${String(i)}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 },
        },
      };
    },
  });
  stack = await startStack({ ...conversationStackEnv(), MANYTHREADS_LITELLM_URL: fake.url, MANYTHREADS_LITELLM_MASTER_KEY: 'sk-fake' });
  const api = await apiOn(playwright, stack, 'omar');
  try {
    const headers = await api.headers();
    const created = await api.ctx.post('/api/workspace/llm/providers', { data: { name: 'OpenAI', kind: 'openai', apiKey: ['sk-e2e', 'workshop-key-0001'].join('') }, headers });
    expect(created.status(), await created.text()).toBeLessThan(300);
    const providerId = ((await created.json()) as { provider: { id: string } }).provider.id;
    const bound = await api.ctx.put('/api/workspace/llm/aliases/smart', { data: { providerId, model: 'gpt-4o', fallbacks: [] }, headers });
    expect(bound.status(), await bound.text()).toBe(200);
    // a save reaches the proxy a moment later: move it into the past instead of waiting
    await stack.sql(`UPDATE app.llm_aliases SET updated_at = updated_at - interval '1 minute'`);
    await stack.sql(`UPDATE app.llm_providers SET updated_at = updated_at - interval '1 minute'`);
    await addBot(stack, api, 'releaser', BOT_MD);
  } finally {
    await api.ctx.dispose();
  }
});

test.afterAll(async () => {
  await stack?.stop();
  await fake?.close();
});

test('an admin rehearses the bot (every write is held back and badged), carries a wrong answer into Build as a correction, and gets a lesson, a test case and a rule as proposals; then asks Live', async ({ browser, playwright, isMobile }) => {
  test.setTimeout(300_000);
  const api = await apiOn(playwright, stack, 'omar');
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/bots/releaser/chat', isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    // ---- the way in: a Chat | Workshop pair of tabs on the bot's conversation page
    await expect(page.getByTestId('ws-view-chat')).toHaveAttribute('aria-selected', 'true');
    // by keyboard: the arrow key chooses the other side, and focus lands on the tab that was chosen (the row on the other side is a new one)
    await page.getByTestId('ws-view-chat').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('workshop-tab')).toBeVisible();
    await expect(page.getByTestId('ws-view-workshop')).toBeFocused();
    // the page of each side is the tab panel its tab controls, labelled by that tab
    const panel = page.locator('#ws-view-panel');
    await expect(panel).toHaveAttribute('role', 'tabpanel');
    await expect(panel).toHaveAttribute('aria-labelledby', 'ws-view-tab-workshop');
    await expect(page.getByTestId('ws-view-workshop')).toHaveAttribute('aria-controls', 'ws-view-panel');
    await expect(page.getByTestId('ws-view-chat')).not.toHaveAttribute('aria-controls', /.+/);
    await expect(page).toHaveURL(/view=workshop/);
    await expect(page.getByTestId('ws-mode-build')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('ws-lead')).toContainText('proposal');
    expect(await noSidewaysScroll(page)).toBe(true);

    // ---- the modes by keyboard: the arrow key moves focus and chooses
    await page.getByTestId('ws-mode-build').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('ws-mode-rehearse')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('ws-mode-rehearse')).toBeFocused();
    await expect(page).toHaveURL(/mode=rehearse/);
    await expect(page.getByTestId('ws-lead')).toContainText('held back');

    // ---- the list of earlier conversations never goes back to "Loading…" while it is read again
    await expect(page.getByTestId('ws-earlier-empty')).toBeVisible();
    await page.evaluate(() => {
      const w = window as unknown as { __sawLoading: boolean };
      w.__sawLoading = false;
      const side = document.querySelector('aside[aria-label="Earlier conversations"]');
      new MutationObserver(() => {
        if (side?.textContent?.includes('Loading…')) w.__sawLoading = true;
      }).observe(side as Node, { childList: true, subtree: true, characterData: true });
    });

    // ---- Rehearse: the model tries a message and a stub write; both are held back; nothing is posted
    const messagesBefore = (await stack.sql<{ n: string }>(`SELECT count(*) AS n FROM app.messages`))[0]!.n;
    scripts.rehearse = [
      { calls: [{ name: 'messages_post', args: { channelId: '00000000-0000-4000-8000-000000000001', body: 'HOSTILE-MESSAGE' } }, { name: 'test_write', args: { target: 'sandbox' } }] },
      { text: 'I would tell the channel where the steps are.' },
    ];
    await page.getByTestId('ws-text').fill('RHS where are the release steps?');
    await page.getByTestId('ws-text').press('Control+Enter');
    await expect(page.getByTestId('ws-reply')).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId('ws-reply')).toContainText('I would tell the channel');
    await expect(page.getByTestId('ws-reply')).toHaveAttribute('data-rehearsal', 'true');
    await expect(page.getByTestId('ws-badge')).toHaveCount(2);
    await expect(page.getByTestId('ws-badge').first()).toHaveText('not really done');
    await expect(page.getByTestId('ws-announce')).toContainText('held back');
    await expect(page.getByTestId('ws-usage')).toHaveAttribute('data-label', 'rehearsal');
    await expect(page.getByTestId('ws-usage')).toContainText('Rehearsal spend');
    expect((await stack.sql<{ n: string }>(`SELECT count(*) AS n FROM app.messages`))[0]!.n).toBe(messagesBefore);
    expect(await noSidewaysScroll(page)).toBe(true);
    await expect(page.getByTestId('ws-earlier')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __sawLoading: boolean }).__sawLoading)).toBe(false);
    // the working row is not a second live region: the one polite announcement above says it
    await expect(page.locator('[data-testid="ws-working"][role="status"]')).toHaveCount(0);

    // ---- Correct this reply: it goes to Build with the reply attached
    await page.getByTestId('ws-correct').click();
    await expect(page.getByTestId('ws-mode-build')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('ws-about-chip')).toContainText('I would tell the channel');
    const lesson = 'Always give the link to the release checklist page when someone asks where the steps are.';
    scripts.build = [
      { calls: [{ name: 'record_correction', args: { corrections: [{ lesson, question: 'Where are the release steps?', mustMention: ['checklist'], rule: lesson }] } }] },
      { text: 'Filed.' },
    ];
    await page.getByTestId('ws-text').fill('That answer was wrong, it should give the link. Make that a rule.');
    await page.getByTestId('ws-send').click();
    await expect(page.locator('[data-testid="ws-proposal"][data-role="lessons"]')).toBeVisible({ timeout: 90_000 });
    await expect(page.locator('[data-testid="ws-proposal"][data-role="eval"]')).toBeVisible();
    await expect(page.locator('[data-testid="ws-proposal"][data-role="rule"]')).toBeVisible();
    await expect(page.getByTestId('ws-announce')).toContainText('proposals are waiting for approval');
    expect(await noSidewaysScroll(page)).toBe(true);
    // nothing was applied: the lessons file does not exist until a person approves
    expect((await api.ctx.get('/api/teams/engineering/repo/blob?path=bots%2Freleaser%2Flessons.md')).status()).toBe(404);
    await page.getByTestId('ws-proposal-link').first().focus();
    await expect(page.getByTestId('ws-proposal-link').first()).toBeFocused();

    // ---- Live: a question about the real runs; read only
    await page.getByTestId('ws-mode-live').click();
    scripts.live = [{ text: 'It has not run for anyone yet.' }];
    await page.getByTestId('ws-text').fill('How has it been doing this week?');
    await page.getByTestId('ws-send').click();
    await expect(page.getByTestId('ws-reply')).toContainText('It has not run for anyone yet.', { timeout: 90_000 });
    await expect(page.getByTestId('ws-badge')).toHaveCount(0);

    // ---- end it; a finished conversation takes no more messages
    await page.getByTestId('ws-end').click();
    await expect(page.getByTestId('ws-ended')).toBeVisible();
    await expect(page.getByTestId('ws-text')).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);

    // ---- back to the chat, by keyboard again: focus stays on the tab that was chosen
    await page.getByTestId('ws-view-workshop').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('conversation-view')).toBeVisible();
    await expect(page.getByTestId('ws-view-chat')).toBeFocused();
  } finally {
    await context.close();
    await api.ctx.dispose();
  }
});

test('a plain member cannot rehearse: the Rehearse tab is switched off with the reason in plain words; the server still refuses; Build still opens for them', async ({ browser, isMobile, playwright }) => {
  test.setTimeout(120_000);
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/bots/releaser/chat?view=workshop&mode=rehearse', isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    await expect(page.getByTestId('workshop-tab')).toBeVisible();
    // the tab is there, says it is off, and says why where anyone can read it
    await expect(page.getByTestId('ws-mode-rehearse')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('ws-mode-rehearse-why')).toHaveText('Only a team lead or an admin can rehearse a bot.');
    // the address asked for Rehearse, but this person lands on Build: Rehearse stays switched off, is not the chosen tab, and none of its own words show
    await expect(page.getByTestId('ws-mode-rehearse')).toHaveAttribute('aria-selected', 'false');
    await expect(page.getByTestId('ws-mode-build')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('workshop-tab')).toHaveAttribute('data-mode', 'build');
    await expect(page.getByTestId('ws-lead')).toContainText('proposal');
    await expect(page.getByTestId('workshop-tab')).not.toContainText('Try the bot as it really is');
    expect(await noSidewaysScroll(page)).toBe(true);
    // the other tabs are not switched off; choosing the off tab chooses nothing
    await expect(page.getByTestId('ws-mode-build')).not.toHaveAttribute('aria-disabled', 'true');
    await page.getByTestId('ws-mode-live').click();
    await expect(page.getByTestId('ws-mode-live')).toHaveAttribute('aria-selected', 'true');
    // Playwright treats aria-disabled as not clickable, so force the click a person could still make
    await page.getByTestId('ws-mode-rehearse').click({ force: true });
    await expect(page.getByTestId('ws-mode-live')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('ws-mode-build').click();
    await expect(page.getByTestId('ws-mode-build')).toHaveAttribute('aria-selected', 'true');
    // the platform does not rely on the tab: asked directly, it refuses in words
    const api = await apiOn(playwright, stack, 'nadia');
    try {
      const refused = await api.ctx.post('/api/teams/engineering/bots/releaser/workshop/sessions', { data: { mode: 'rehearse' }, headers: await api.headers() });
      expect(refused.status()).toBe(403);
      expect(await refused.text()).toContain('Only a team lead or an admin can rehearse a bot');
    } finally {
      await api.ctx.dispose();
    }
  } finally {
    await context.close();
  }
});

test('coming back to Chat from the Workshop tab by keyboard (ArrowLeft, Home) keeps focus on the Chat tab, not in the message box', async ({ browser, isMobile, playwright }) => {
  test.setTimeout(120_000);
  // a bot that answers conversations, so its Chat side has a message box that could take focus
  const admin = await apiOn(playwright, stack, 'omar');
  try {
    await addBot(stack, admin, 'chatty', brainMd(['Hello?']).replace('name: Brain', 'name: Chatty'));
  } finally {
    await admin.ctx.dispose();
  }
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/bots/chatty/chat?view=workshop', isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    for (const key of ['ArrowLeft', 'Home']) {
      await expect(page.getByTestId('workshop-tab')).toBeVisible();
      await page.getByTestId('ws-view-workshop').focus();
      await page.keyboard.press(key);
      await expect(page.getByTestId('ws-view-chat')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('ws-view-chat')).toBeFocused();
      // and a moment later, once the message box has appeared, focus is still on the tab
      await page.waitForTimeout(600);
      await expect(page.getByTestId('ws-view-chat')).toBeFocused();
      await expect(page.getByTestId('composer')).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Message Chatty' })).not.toBeFocused();
      // on to the Workshop again with the keyboard, for the next key
      await page.keyboard.press('End');
      await expect(page.getByTestId('ws-view-workshop')).toBeFocused();
    }
  } finally {
    await context.close();
  }
});
