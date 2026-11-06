import { expect, test, type Page } from '@playwright/test';
import { startFakeLlm, type FakeLlm } from '../../tools/fake-llm/src/server.ts';
import { conversationStackEnv } from '../conversations/support.ts';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, apiOn, noSidewaysScroll, openOn } from '../support/stack-browser.ts';

/*
 * "Add a bot" in the browser (PLAN P7-02 to P7-04): a person writes a brief, a helper looks at what the team has, the platform grades each need, the helper asks one list of questions,
 * and proposes the bot as a diff that waits for Approve. The model is a stand-in that answers with the tool calls this spec scripts (the helper's choices); everything else is the
 * real server: the grading, the refusals, the proposals and the approval. Both layouts. Runs on a stack of its own because approving commits a bot.
 */
test.describe.configure({ mode: 'serial' });

type Call = { name: string; args: unknown };
let script: Call[] = [];
let fake: FakeLlm;
let stack: Stack;

test.beforeAll(async ({ playwright }) => {
  fake = await startFakeLlm({
    masterKey: 'sk-fake',
    completion: () => {
      const next = script.shift();
      if (!next) return 'done';
      return {
        status: 200,
        body: {
          id: 'chatcmpl-e2e',
          model: 'smart',
          choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `call_${script.length}`, type: 'function', function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 },
        },
      };
    },
  });
  stack = await startStack({ ...conversationStackEnv(), MANYTHREADS_LITELLM_URL: fake.url, MANYTHREADS_LITELLM_MASTER_KEY: 'sk-fake' });
  const api = await apiOn(playwright, stack, 'omar');
  const headers = await api.headers();
  const created = await api.ctx.post('/api/workspace/llm/providers', { data: { name: 'OpenAI', kind: 'openai', apiKey: ['sk-e2e', 'setup-key-0001'].join('') }, headers });
  expect(created.status(), await created.text()).toBeLessThan(300);
  const providerId = ((await created.json()) as { provider: { id: string } }).provider.id;
  const bound = await api.ctx.put('/api/workspace/llm/aliases/smart', { data: { providerId, model: 'gpt-4o', fallbacks: [] }, headers });
  expect(bound.status(), await bound.text()).toBe(200);
  // a save reaches the proxy a moment later: move it into the past instead of waiting
  await stack.sql(`UPDATE app.llm_aliases SET updated_at = updated_at - interval '1 minute'`);
  await stack.sql(`UPDATE app.llm_providers SET updated_at = updated_at - interval '1 minute'`);
});

test.afterAll(async () => {
  await stack?.stop();
  await fake?.close();
});

const REQ = [
  { id: 'post', text: 'Answer in channels', kind: 'capability', name: 'messages.post' },
  { id: 'mail', text: 'Watch the support mailbox', kind: 'connection', name: 'mailbox' },
  { id: 'tone', text: 'Friendly but short', kind: 'other' },
];

const botMd = (name: string): string =>
  ['---', 'schema: 1', `name: ${name}`, 'role: Answers questions about the release checklist.', 'kind: agent', 'runtime: hermes', 'model:', '  aliases: [smart]', 'triggers:', '  - type: mention', 'capabilities:', '  native: [messages.post]', '---', '', 'You answer questions about the release checklist. If you do not know, say so and ask a person.', ''].join('\n');

const BRIEF = 'A bot that answers questions about our release checklist and watches the support mailbox.';

/** Writes the brief, starts the helper and waits for its one list of questions. */
async function askAndWait(page: Page): Promise<void> {
  await page.getByTestId('setup-brief').fill(BRIEF);
  await page.getByTestId('setup-name').fill('Release helper');
  await page.getByTestId('setup-start').click();
  await expect(page.getByTestId('setup-questions')).toBeVisible({ timeout: 60_000 });
}

/** What the example cards should offer the Engineering team, worked out from the server's own lists: not from the screen's code. */
async function expectedExamples(api: Awaited<ReturnType<typeof apiOn>>): Promise<{ teamOwn: string[]; available: string[] }> {
  const { templates } = await api.get<{ templates: Array<{ id: string; bots: Array<{ slug: string; role: string }> }> }>('/api/templates');
  const { team } = await api.get<{ team: { template: string | null } }>('/api/teams/engineering');
  const { bots } = await api.get<{ bots: Array<{ slug: string }> }>('/api/teams/engineering/bots');
  const have = new Set(bots.map((b) => b.slug));
  const offered = (t: { bots: Array<{ slug: string; role: string }> }): string[] => t.bots.filter((b) => b.slug !== 'brain' && b.role.trim() !== '' && !have.has(b.slug)).map((b) => b.slug);
  const available = [...new Set(templates.flatMap(offered))];
  const own = templates.find((t) => t.id === team.template);
  return { teamOwn: own ? offered(own) : [], available };
}

test('the box comes first and six cards fit the team', async ({ browser, playwright, isMobile }) => {
  const api = await apiOn(playwright, stack, 'omar');
  const { teamOwn, available } = await expectedExamples(api);
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/bots/new', isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    const box = page.getByTestId('setup-brief');
    const cards = page.getByTestId('setup-example');
    await expect(box).toBeVisible();
    await expect(cards).toHaveCount(Math.min(6, available.length));
    // the box is above the cards, not after them
    const boxY = (await box.boundingBox())?.y ?? Number.NaN;
    const firstY = (await cards.first().boundingBox())?.y ?? Number.NaN;
    expect(boxY).toBeLessThan(firstY);

    // the team's own template leads, and a bot the team already has is not offered
    const shown = await cards.evaluateAll((els) => els.map((el) => el.getAttribute('data-example') ?? ''));
    expect(new Set(shown).size).toBe(shown.length);
    for (const slug of shown) expect(available).toContain(slug);
    expect(shown.slice(0, Math.min(6, teamOwn.length))).toEqual(teamOwn.slice(0, 6));
    // each card shows a name and one line about it
    await expect(cards.first().locator('.su-ex-name')).not.toBeEmpty();
    await expect(cards.first().locator('.su-ex-role')).not.toBeEmpty();

    // phone: one card per row; desktop: two
    const a = await cards.nth(0).boundingBox();
    const b = await cards.nth(1).boundingBox();
    if (isMobile) expect(Math.abs((a?.x ?? 0) - (b?.x ?? 99))).toBeLessThan(2);
    else expect(Math.abs((a?.y ?? 0) - (b?.y ?? 99))).toBeLessThan(2);
    expect(await noSidewaysScroll(page)).toBe(true);

    // picking a card fills the box, marks the card and leaves the cursor in the box
    await cards.nth(1).click();
    await expect(cards.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(box).toHaveValue(/^Like the .+ bot\./);
    await expect(box).toBeFocused();
    await expect(page.getByTestId('setup-start')).toBeEnabled();
    // typing in the box lets go of the pick
    await box.press('End');
    await page.keyboard.type(' Only on weekdays.');
    await expect(cards.nth(1)).toHaveAttribute('aria-pressed', 'false');
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});

test('See all lists every example', async ({ browser, playwright, isMobile }) => {
  const api = await apiOn(playwright, stack, 'omar');
  const { available } = await expectedExamples(api);
  test.skip(available.length <= 6, 'the stack offers six examples or fewer, so there is no "See all"');
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/bots/new', isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    const open = page.getByTestId('setup-examples-all');
    await expect(open).toHaveText(`See all ${available.length}`);
    await open.click();
    const dialog = page.getByRole('dialog', { name: 'All examples' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('setup-example-all')).toHaveCount(available.length);
    expect(await noSidewaysScroll(page)).toBe(true);

    // the filter box narrows the list and says how many are left
    const filter = dialog.getByTestId('setup-examples-filter');
    await filter.fill('zzzz-no-such-bot');
    await expect(dialog.getByTestId('setup-example-all')).toHaveCount(0);
    await expect(dialog.getByTestId('setup-examples-count')).toContainText(`0 of ${available.length}`);
    await filter.fill('');
    await expect(dialog.getByTestId('setup-example-all')).toHaveCount(available.length);

    // Esc closes it and focus goes back to the button that opened it
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(open).toBeFocused();

    // picking from the list fills the box, closes the dialog and leaves the cursor in the box
    await open.click();
    const last = page.getByRole('dialog', { name: 'All examples' }).getByTestId('setup-example-all').last();
    await last.click();
    await expect(page.getByRole('dialog', { name: 'All examples' })).toHaveCount(0);
    await expect(page.getByTestId('setup-brief')).toHaveValue(/^Like the .+ bot\./);
    await expect(page.getByTestId('setup-brief')).toBeFocused();
  } finally {
    await context.close();
  }
});

test('an admin (who also leads Engineering) writes a brief, sees the grades and the questions, answers them by keyboard, and approves: the bot exists only then', async ({ browser, playwright, isMobile }) => {
  test.setTimeout(240_000);
  script = [
    { name: 'describe_self', args: {} },
    { name: 'ask_clarification', args: { summary: 'A release checklist helper.', requirements: REQ } },
    { name: 'propose_config', args: { slug: 'release-helper', name: 'Release helper', summary: 'Answers release checklist questions when mentioned.', botMd: botMd('Release helper'), requirements: REQ } },
  ];
  const api = await apiOn(playwright, stack, 'omar');
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/bots', isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    // ---- the way in: a button on the Bots page
    await page.getByTestId('roster-add-bot').click();
    await expect(page).toHaveURL(/\/t\/engineering\/bots\/new$/);
    await expect(page.getByTestId('setup-screen')).toBeVisible();
    await expect(page.getByLabel('What should this bot do?')).toBeVisible();
    await expect(page.getByText('What happens next')).toBeVisible();
    await expect(page.getByTestId('setup-start')).toBeDisabled();
    expect(await noSidewaysScroll(page)).toBe(true);

    // ---- discovery: what the team has, each need graded by the platform, one question for each gap
    await askAndWait(page);
    await expect(page).toHaveURL(/[?&]s=/);
    await expect(page.getByTestId('setup-inventory')).toContainText('What Engineering has');
    const chips = page.locator('[data-testid="setup-feasibility"] [data-requirement]');
    await expect(chips).toHaveCount(3);
    await expect(page.locator('[data-requirement="post"] [data-grade]')).toHaveAttribute('data-grade', 'covered');
    await expect(page.locator('[data-requirement="mail"] [data-grade]')).toHaveAttribute('data-grade', 'missing');
    await expect(page.locator('[data-requirement="tone"] [data-grade]')).toHaveAttribute('data-grade', 'unclear');
    await expect(page.locator('[data-testid="setup-questions"] [data-question]')).toHaveCount(2);
    await expect(page.getByTestId('setup-send')).toBeDisabled();
    expect(await noSidewaysScroll(page)).toBe(true);
    // nothing was filed while the helper only asked
    expect((await api.ctx.get('/api/teams/engineering/proposals')).ok()).toBe(true);
    const before = await api.get<{ proposals: Array<{ path: string }> }>('/api/teams/engineering/proposals');
    expect(before.proposals.some((p) => p.path === 'bots/release-helper/BOT.md')).toBe(false);

    // ---- answering by keyboard: focus an option, press Enter; type into the other box
    const first = page.locator('[data-question="q1"] [data-testid="setup-option"]').first();
    await first.focus();
    await page.keyboard.press('Enter');
    await expect(first).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#su-a-q2').fill('Short answers');
    await expect(page.getByTestId('setup-send')).toBeEnabled();
    await page.locator('#su-a-q2').press('Enter');

    // ---- the proposal: the file as a diff, what it will not do, and a button that waits for a person
    await expect(page.getByTestId('setup-proposal')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('setup-file').first()).toContainText('bots/release-helper/BOT.md');
    await expect(page.getByTestId('proposal-diff')).toContainText('name: "Release helper"');
    await expect(page.getByTestId('setup-limits')).toContainText('mailbox');
    expect(await noSidewaysScroll(page)).toBe(true);
    const missing = await api.ctx.get('/api/teams/engineering/bots/release-helper');
    expect(missing.status()).toBe(404);

    // ---- Approve creates the bot
    await page.getByTestId('setup-approve').click();
    await expect(page.getByTestId('setup-created')).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await api.ctx.get('/api/teams/engineering/bots/release-helper')).status(), { timeout: 30_000 }).toBe(200);
    await page.getByTestId('setup-open-bot').click();
    await expect(page.getByTestId('bot-page')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('a team lead who is not an admin gets the same help, but the approval waits for an admin: the proposal is filed and the page says so', async ({ browser, playwright, isMobile }) => {
  test.setTimeout(240_000);
  // Tariq leads Marketing and is a plain member of the workspace: the one real "lead only" person in the fixtures
  script = [
    { name: 'describe_self', args: {} },
    { name: 'ask_clarification', args: { requirements: [REQ[1], REQ[2]] } },
    { name: 'propose_config', args: { slug: 'lead-helper', name: 'Lead helper', botMd: botMd('Lead helper'), requirements: [REQ[1], REQ[2]] } },
  ];
  const { page, context } = await openOn(browser, playwright, stack, 'tariq', '/t/marketing/bots/new', isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    await askAndWait(page);
    await page.locator('[data-question="q1"] [data-testid="setup-option"]').first().click();
    await page.locator('#su-a-q2').fill('Short answers');
    await page.getByTestId('setup-send').click();
    await expect(page.getByTestId('setup-proposal')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('setup-file').first()).toContainText('bots/lead-helper/BOT.md');
    await expect(page.getByTestId('setup-approve')).toHaveCount(0);
    await expect(page.getByTestId('setup-cannot-approve')).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
    const api = await apiOn(playwright, stack, 'omar');
    expect((await api.ctx.get('/api/teams/marketing/bots/lead-helper')).status()).toBe(404);

    // ---- the person who asked cannot reject their own proposal, but can take it back: Withdraw, announced, focus on the heading
    await expect(page.getByTestId('setup-reject')).toHaveCount(0);
    await page.getByTestId('setup-withdraw').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('setup-decided')).toContainText('Withdrawn', { timeout: 30_000 });
    await expect(page.locator('#su-prop-h')).toContainText('Withdrawn');
    await expect(page.locator('#su-prop-h')).toBeFocused();
    await expect(page.getByTestId('setup-withdraw')).toHaveCount(0);
    const listed = await api.get<{ proposals: Array<{ path: string; status: string }> }>('/api/teams/marketing/proposals');
    expect(listed.proposals.find((p) => p.path === 'bots/lead-helper/BOT.md')?.status).toBe('withdrawn');
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});

test('a member gets the same help, but the approval is for an admin: the proposal waits and the page says so', async ({ browser, playwright, isMobile }) => {
  test.setTimeout(240_000);
  script = [
    { name: 'describe_self', args: {} },
    { name: 'ask_clarification', args: { requirements: [REQ[1], REQ[2]] } },
    { name: 'propose_config', args: { slug: 'wait-helper', name: 'Wait helper', botMd: botMd('Wait helper'), requirements: [REQ[1], REQ[2]] } },
  ];
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/bots/new', isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    await askAndWait(page);
    await page.locator('[data-question="q1"] [data-testid="setup-option"]').first().click();
    await page.locator('#su-a-q2').fill('Short answers');
    await page.getByTestId('setup-send').click();
    await expect(page.getByTestId('setup-proposal')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('setup-approve')).toHaveCount(0);
    await expect(page.getByTestId('setup-cannot-approve')).toBeVisible();
    await expect(page.getByTestId('setup-edit')).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
    const api = await apiOn(playwright, stack, 'omar');
    expect((await api.ctx.get('/api/teams/engineering/bots/wait-helper')).status()).toBe(404);
  } finally {
    await context.close();
  }
});

test('a helper that stops after the answers offers Try again, which finishes from the answers already given', async ({ browser, playwright, isMobile }) => {
  test.setTimeout(240_000);
  // round one asks; after the answers the stand-in has nothing scripted, so the helper gives up (the same sentence a slow model call ends with)
  script = [
    { name: 'describe_self', args: {} },
    { name: 'ask_clarification', args: { requirements: [REQ[1], REQ[2]] } },
  ];
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/bots/new', isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    await askAndWait(page);
    await page.locator('[data-question="q1"] [data-testid="setup-option"]').first().click();
    await page.locator('#su-a-q2').fill('Short answers');
    await page.getByTestId('setup-send').click();
    await expect(page.getByTestId('setup-failed')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('setup-retry')).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);

    // the helper can finish now: Try again runs the last round from the stored answers; the conversation is the same one
    const url = page.url();
    script = [{ name: 'propose_config', args: { slug: 'retry-helper', name: 'Retry helper', botMd: botMd('Retry helper'), requirements: [REQ[1], REQ[2]] } }];
    await page.getByTestId('setup-retry').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('setup-announce')).toContainText('working');
    await expect(page.getByTestId('setup-proposal')).toBeVisible({ timeout: 60_000 });
    expect(page.url()).toBe(url);
    await expect(page.getByTestId('setup-file').first()).toContainText('bots/retry-helper/BOT.md');
    // what the person decided is shown as decided, not as still open
    await expect(page.getByTestId('setup-limits')).toContainText('You decided');
    await expect(page.getByTestId('setup-limits')).not.toContainText('Not settled');
    expect(await noSidewaysScroll(page)).toBe(true);
    const api = await apiOn(playwright, stack, 'omar');
    expect((await api.ctx.get('/api/teams/engineering/bots/retry-helper')).status()).toBe(404);
  } finally {
    await context.close();
  }
});

test('a helper that cannot finish says so in one sentence and offers to start again', async ({ browser, playwright, isMobile }) => {
  test.setTimeout(120_000);
  // the stand-in answers in plain words twice: the helper must finish with a tool, so it gives up
  script = [];
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/bots/new', isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    await page.getByTestId('setup-brief').fill(BRIEF);
    await page.getByTestId('setup-start').click();
    await expect(page.getByTestId('setup-failed')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('setup-failed')).toContainText('did not finish');
    await page.getByTestId('setup-again').click();
    await expect(page.getByTestId('setup-brief')).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});
