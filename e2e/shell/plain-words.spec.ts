import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, openOn } from '../support/stack-browser.ts';
import { actorOf } from '../files/support.ts';

/*
 * Plain words (PLAN P21-13): the screens say what a thing is, not where its file lives. An empty Org chart says there are no bots, a Memory row shows the
 * concept's title and description with the file path only as a tooltip, the bot page offers "Open the bot's file" and its trigger options read as plain
 * phrases (the code name is the tooltip), and the Agents screen shows the connection's address only to someone who can manage it.
 * One stack for the file (the specs only read what the first test makes).
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout');
test.describe.configure({ mode: 'serial' });

const CONCEPT_PATH = 'memory/facts/release-day.md';
const CONCEPT_TITLE = 'Release day is Friday';
const CONCEPT_DESC = 'The team ships on Fridays after the checks pass.';
const POD = 'http://pod.internal:8642';

let stack: Stack;

test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'repo' });
  // a team with nobody but its creator and no bot
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    await omar.post('/api/teams', { name: 'Quiet Team' });
    await omar.post('/api/teams/engineering/repo/commit', {
      changes: [{ op: 'put', path: CONCEPT_PATH, content: `---\ntype: fact\ntitle: ${CONCEPT_TITLE}\ndescription: ${CONCEPT_DESC}\n---\n\nShip on Fridays.\n` }],
      message: 'add a concept',
    });
  } finally {
    await omar.ctx.dispose();
  }
  await stack.sql(
    `INSERT INTO app.hermes_connections (workspace_id, team_id, name, kind, agent, base_url, secret_id, status)
     SELECT t.workspace_id, t.id, 'pod-one', 'external', 'hermes', $1, NULL, 'ok' FROM app.teams t WHERE t.slug = 'engineering'`,
    [POD],
  );
});
test.afterAll(async () => {
  await stack?.stop();
});

test('the Org chart of a team without bots says so in plain words', async ({ browser, playwright }) => {
  const slugs = await stack.sql<{ slug: string }>("SELECT slug FROM app.teams WHERE name = 'Quiet Team'");
  expect(slugs).toHaveLength(1);
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/${slugs[0]!.slug}/org`);
  try {
    await expect(page.getByTestId('org-chart')).toBeVisible();
    await expect(page.getByTestId('org-count')).toContainText('0 bots');
    await expect(page.getByTestId('org-chart')).toContainText('No bots on this team yet.');
    await expect(page.getByTestId('org-chart')).not.toContainText('BOT.md');
  } finally {
    await context.close();
  }
});

test('a Memory row shows the title and description; the file path is only the tooltip', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/memory');
  try {
    const row = page.getByTestId('concept-row').filter({ hasText: CONCEPT_TITLE });
    await expect(row).toHaveCount(1, { timeout: 20_000 });
    await expect(row).toContainText(CONCEPT_DESC);
    await expect(row).not.toContainText('release-day.md');
    await expect(row).not.toContainText('memory/');
    await expect(row.getByText(CONCEPT_TITLE, { exact: true })).toHaveAttribute('title', CONCEPT_PATH);
  } finally {
    await context.close();
  }
});

test('the bot page offers "Open the bot\'s file" and its trigger options are plain phrases', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/bots/coder?tab=audit');
  try {
    await expect(page.getByTestId('bot-page')).toBeVisible();
    const open = page.getByTestId('bot-open-file');
    await expect(open).toHaveText("Open the bot's file");
    await expect(open).toHaveAttribute('href', /bots(%2F|\/)coder(%2F|\/)BOT\.md/);

    await page.getByTestId('tab-triggers').click();
    const select = page.getByLabel('Trigger type to add');
    await expect(select).toBeVisible();
    const labels = await select.locator('option').allTextContents();
    expect(labels).toEqual([
      'When someone talks to it',
      'When mentioned',
      'On a schedule',
      'When a card is assigned to it',
      'When mail arrives',
      'On every message in a channel',
      'When another service calls in',
    ]);
    for (const label of labels) expect(label).not.toMatch(/_/);
    // the code name stays as the value and the tooltip
    await expect(select.locator('option', { hasText: 'On a schedule' })).toHaveAttribute('value', 'routine');
    await expect(select.locator('option', { hasText: 'On a schedule' })).toHaveAttribute('title', 'routine');
  } finally {
    await context.close();
  }
});

test('the Agents screen shows a connection address to a workspace admin and hides it from a team lead who is not one', async ({ browser, playwright }) => {
  const admin = await openOn(browser, playwright, stack, 'omar', '/t/engineering/agents');
  try {
    const row = admin.page.locator('[data-testid="agents-row"][data-connection="pod-one"]');
    await expect(row).toContainText(POD);
    await expect(row.getByRole('button', { name: 'Test' })).toBeVisible();
  } finally {
    await admin.context.close();
  }
  // a lead who is not a workspace admin sees that the connection exists and can test it, but not where it points
  await stack.sql("UPDATE app.team_members SET role = 'lead' WHERE team_id = (SELECT id FROM app.teams WHERE slug = 'engineering') AND actor_id = $1", [actorOf('nadia')]);
  const lead = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/agents');
  try {
    const row = lead.page.locator('[data-testid="agents-row"][data-connection="pod-one"]');
    await expect(row).toBeVisible();
    await expect(row).toContainText('Set by an admin');
    await expect(row).not.toContainText('pod.internal');
    await expect(row).not.toContainText(POD);
  } finally {
    await lead.context.close();
  }
});
