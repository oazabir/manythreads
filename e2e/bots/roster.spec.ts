import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { openOn } from '../support/stack-browser.ts';
import { actorOf } from '../files/support.ts';
import { BOTS_STACK_ENV, BOT_MD, apiOn, commitDefinition, definitionOf, rosterRow } from './support.ts';

/*
 * The bot roster and a bot page as a reader (PLAN P5-05, SPEC §7.5): the Bots entry in the sidebar, the roster the loader fills from
 * `bots/<slug>/BOT.md`, the fourteen tabs of one bot, and the red banner a definition that fails to load raises. Nadia is a member of
 * Engineering who does not lead it, so the roster and the page are read-only to her and the change on offer is the file (a pull request);
 * promoted to a lead she edits an existing bot, while adding or removing one stays the admins'. Runs on its own stack because it commits.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack({ ...BOTS_STACK_ENV });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('the Bots entry opens the team roster; every row says who the bot is and where it runs', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/');
  try {
    // the sidebar contract's Bots section lists the team's bots under its heading: the roster's bot is a row that opens its page, and the
    // empty-state hint is gone because the team has one
    const sidebar = page.locator('[data-landmark="sidebar"]');
    const bots = sidebar.getByTestId('sidebar-bot');
    await expect(bots).toHaveCount(1, { timeout: 15_000 });
    await expect(bots.first()).toContainText('Coder');
    await expect(bots.first()).toHaveAttribute('href', '/t/engineering/bots/coder');
    await expect(sidebar.locator(':scope > .sec', { hasText: 'Bots' })).not.toContainText('No bots yet');
    await sidebar.getByRole('link', { name: /Bots/ }).first().click();
    await expect(page).toHaveURL(/\/t\/engineering\/bots$/);
    await expect(page.getByTestId('bots-roster')).toBeVisible();
    // the loader made the row from the seed's own commit
    const coder = rosterRow(page, 'coder');
    await expect(coder).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('roster-count')).toContainText('1 bot');
    await expect(coder).toContainText('Coder');
    await expect(coder).toContainText('Writes and reviews code changes for the Engineering team');
    await expect(coder).toContainText('agent');
    await expect(coder).toContainText('Hermes');
    await expect(coder).toContainText('this team');
    await expect(coder.getByTestId('bot-open')).toHaveAttribute('href', '/t/engineering/bots/coder');
    await expect(coder.getByTestId('bot-configure')).toHaveAttribute('href', '/t/engineering/bots/coder?tab=identity');
  } finally {
    await context.close();
  }
});

test('a member who does not lead the team reads every tab of one bot, with no Save and the file as the way to change it', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/bots/coder');
  try {
    await expect(page.getByTestId('bot-page')).toBeVisible();
    await expect(page.getByTestId('bot-title')).toContainText('Coder');
    await expect(page.getByTestId('bot-title')).toContainText('agent');
    await expect(page.locator('[data-landmark="bot-head"]')).toContainText('bots/coder/BOT.md');

    // every section of SPEC §7.2 is one tab (Identity … Audit)
    await expect(page.locator('[data-landmark="bot-tabs"] button')).toHaveCount(14);
    await expect(page.getByTestId('bot-foot').getByTestId('read-only-note')).toContainText('go by pull request');
    await expect(page.getByTestId('save-bot')).toHaveCount(0);
    await expect(page.getByTestId('open-readonly')).toHaveAttribute('href', /bots%2Fcoder%2FBOT.md/);

    // Identity shows the fields the loader copied from the file, read-only
    await expect(page.getByTestId('bot-name')).toHaveValue('Coder');
    await expect(page.getByTestId('bot-name')).toHaveAttribute('readonly', '');

    // a tab of its own: the URL follows and the pane is the tab's
    await page.getByTestId('tab-capabilities').click();
    await expect(page).toHaveURL(/tab=capabilities/);
    await expect(page.getByTestId('pane-capabilities')).toContainText('Never bot-writable');
    // the seed declares no capability, and there is no control to add one
    await expect(page.getByTestId('caps-native')).toContainText('none');
    await expect(page.getByTestId('caps-native').getByLabel('Add granted')).toHaveCount(0);

    // Audit is the last tab and carries the runs (none yet) and the definition's file
    await page.getByTestId('tab-audit').click();
    await expect(page.getByTestId('pane-audit')).toContainText('No runs yet');
    await expect(page.getByTestId('pane-audit')).toContainText('bots/coder/BOT.md');
  } finally {
    await context.close();
  }
});

test('a team lead who is not a workspace admin edits an existing bot, but cannot add or remove one', async ({ browser, playwright }) => {
  // promoting Nadia to a lead of Engineering does not make her a workspace admin: an existing bot is hers to edit (SPEC §3 as set here),
  // while adding a bot and removing one stay the admins'.
  await stack.sql("UPDATE app.team_members SET role = 'lead' WHERE team_id = (SELECT id FROM app.teams WHERE slug = 'engineering') AND actor_id = $1", [actorOf('nadia')]);
  const api = await apiOn(playwright, stack, 'nadia');
  try {
    const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/bots/coder');
    try {
      await expect(page.getByTestId('bot-page')).toBeVisible();
      // a lead of the team has Save and no read-only note
      await expect(page.getByTestId('save-bot')).toBeVisible();
      await expect(page.getByTestId('bot-foot').getByTestId('read-only-note')).toHaveCount(0);
    } finally {
      await context.close();
    }

    const def = await definitionOf(api);
    await commitDefinition(api, `${def.content.trimEnd()}\nA lead edits an existing bot.\n`, 'A lead edits the Coder definition', def.blobSha);
    // adding a bot and removing one are refused, so hiding the button is not the rule
    const added = await api.ctx.post('/api/teams/engineering/repo/commit', {
      data: { changes: [{ op: 'put', path: 'bots/nadia-bot/BOT.md', content: '---\nname: Nadia bot\n---\n' }], message: 'a lead adds a bot' },
      headers: await api.headers(),
    });
    expect(added.status()).toBe(403);
    const removed = await api.ctx.post('/api/teams/engineering/repo/commit', {
      data: { changes: [{ op: 'delete', path: BOT_MD }], message: 'a lead removes a bot' },
      headers: await api.headers(),
    });
    expect(removed.status()).toBe(403);
    // Files still offers bots/ read-only to a lead: a bot's own page is where a lead edits a definition
    const tree = await api.get<{ entries: { path: string; readOnly: boolean; readOnlyReason: string | null }[] }>(
      '/api/teams/engineering/files/tree?path=bots/coder',
    );
    const botFile = tree.entries.find((e) => e.path === BOT_MD);
    expect(botFile?.readOnly).toBe(true);
    expect(botFile?.readOnlyReason).toBe('change_by_pull_request');
  } finally {
    await api.ctx.dispose();
    await stack.sql("UPDATE app.team_members SET role = 'member' WHERE team_id = (SELECT id FROM app.teams WHERE slug = 'engineering') AND actor_id = $1", [actorOf('nadia')]);
  }
});

test('a definition that fails to load is the red banner on the page and the roster, and the previous version stays live', async ({ browser, playwright }) => {
  const omar = await apiOn(playwright, stack, 'omar');
  const good = await definitionOf(omar);
  const broken = good.content.replace(/^role: .*$/m, 'role:');
  expect(broken).not.toBe(good.content);
  await commitDefinition(omar, broken, 'Break the Coder definition', good.blobSha);

  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/bots');
  try {
    // the roster notices without the page being opened
    const coder = rosterRow(page, 'coder');
    await expect(coder).toContainText('needs a fix', { timeout: 15_000 });
    await coder.getByTestId('bot-open').click();
    await expect(page.getByTestId('bot-page')).toBeVisible();
    await expect(page.getByTestId('bot-invalid-banner')).toContainText('role');
    await expect(page.getByTestId('bot-invalid-banner')).toContainText('The previous version is still running');
    // the file itself cannot be read as a definition either: the page refuses to rewrite what it cannot parse
    await expect(page.getByTestId('definition-unreadable')).toBeVisible();
    await expect(page.getByTestId('save-bot')).toHaveCount(0);
  } finally {
    await context.close();
  }

  // fixing the file loads the row back to active and clears the banner
  const fixed = broken.replace('role:', 'role: Writes and reviews code changes for the Engineering team');
  await commitDefinition(omar, fixed, 'Fix the Coder definition', (await definitionOf(omar)).blobSha);
  await omar.ctx.dispose();

  const { page: fixedPage, context: fixedContext } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/bots/coder');
  try {
    await expect(fixedPage.getByTestId('bot-invalid-banner')).toHaveCount(0, { timeout: 15_000 });
    await expect(fixedPage.getByTestId('definition-unreadable')).toHaveCount(0);
    await expect(fixedPage.getByTestId('bot-role')).toHaveValue('Writes and reviews code changes for the Engineering team');
  } finally {
    await fixedContext.close();
  }
});

test('a team made from a template starts with its bots: Brain in every template, and the one the team is for', async ({ browser, playwright }) => {
  // the first commit of the new team's repository carries the template's BOT.md files and the loader seats them, so the roster is not empty
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    const made = await omar.post<{ team: { slug: string }; created: boolean }>('/api/teams/from-template', {
      templateId: 'customer-support',
      name: 'Front desk',
      slug: 'front-desk',
    });
    expect(made.created).toBe(true);
  } finally {
    await omar.ctx.dispose();
  }

  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/front-desk/bots');
  try {
    await expect(page.getByTestId('bots-roster')).toBeVisible();
    const brain = rosterRow(page, 'brain');
    await expect(brain).toBeVisible({ timeout: 45_000 });
    await expect(brain).toContainText('Brain');
    await expect(brain).toContainText('agent');
    await expect(brain).toContainText('Hermes');
    await expect(rosterRow(page, 'support-responder')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('roster-count')).toContainText('2 bots');

    // the bot's page reads the file the first commit wrote, and its allowlist is the one SPEC §12.4 names plus the answer tool
    await brain.getByTestId('bot-open').click();
    await expect(page.getByTestId('bot-page')).toBeVisible();
    await expect(page.locator('[data-landmark="bot-head"]')).toContainText('bots/brain/BOT.md');
    await page.getByTestId('tab-capabilities').click();
    const native = page.getByTestId('caps-native');
    for (const capability of ['knowledge.search', 'files.search', 'memory.recall', 'messages.search', 'answer.post', 'pages.write']) {
      await expect(native).toContainText(capability);
    }
  } finally {
    await context.close();
  }
});
