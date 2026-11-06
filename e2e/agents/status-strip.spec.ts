import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { actorOf } from '../files/support.ts';
import { noSidewaysScroll, openOn, PHONE } from '../support/stack-browser.ts';

/*
 * Agents and Projects open with a status strip (PLAN P21-18, POLISH 5.8): one line per connection or project with a dot, the state in words and
 * when it was last known; "How to connect" is folded below; the internal address is shown only to a workspace admin. Runs on desktop and mobile-web.
 */
test.describe.configure({ mode: 'serial' });

const POD = 'http://10.42.0.1:8642';
let stack: Stack;

test.beforeAll(async () => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'repo' });
  await stack.sql(
    `INSERT INTO app.hermes_connections (workspace_id, team_id, name, kind, agent, base_url, secret_id, status, last_checked_at)
     SELECT t.workspace_id, t.id, 'pod-one', 'external', 'hermes', $1, NULL, 'ok', now() FROM app.teams t WHERE t.slug = 'engineering'`,
    [POD],
  );
  await stack.sql(
    `INSERT INTO app.projects (workspace_id, team_id, name, repo_url)
     SELECT t.workspace_id, t.id, 'manythreads', 'https://github.com/kahf/manythreads' FROM app.teams t WHERE t.slug = 'engineering'`,
  );
});
test.afterAll(async () => {
  await stack?.stop();
});

test('Agents opens with a status strip and folds How to connect', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/agents', isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    const strip = page.getByTestId('agents-strip');
    await expect(strip).toBeVisible();
    const item = strip.locator('[data-item="pod-one"]');
    await expect(item).toHaveCount(1);
    await expect(item.getByTestId('status-strip-word')).toHaveText('Working');
    await expect(item).toContainText('last checked');
    await expect(item).toHaveAttribute('data-tone', 'ok');
    // an admin sees the internal address
    await expect(item.getByTestId('status-strip-detail')).toHaveText(POD);

    // the strip comes before the list of connections, and "How to connect" is closed until opened
    const stripBox = (await strip.boundingBox())!;
    const listBox = (await page.getByTestId('agents-row').first().boundingBox())!;
    expect(stripBox.y).toBeLessThan(listBox.y);
    const fold = page.getByTestId('agents-how-fold');
    await expect(fold).not.toHaveAttribute('open', '');
    await expect(page.getByTestId('agents-how')).toBeHidden();
    await fold.getByText('How to connect', { exact: true }).click();
    await expect(page.getByTestId('agents-how')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Hermes gateway' })).toBeVisible();
    if (isMobile) expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});

test('a team lead who is not an admin sees the strip without the internal address', async ({ browser, playwright, isMobile }) => {
  // the connections list is for a lead or an admin (the route answers 403 to a plain member), so the non-admin reader is a lead
  await stack.sql("UPDATE app.team_members SET role = 'lead' WHERE team_id = (SELECT id FROM app.teams WHERE slug = 'engineering') AND actor_id = $1", [actorOf('nadia')]);
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/agents', isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    const item = page.getByTestId('agents-strip').locator('[data-item="pod-one"]');
    await expect(item).toBeVisible();
    await expect(item.getByTestId('status-strip-word')).toHaveText('Working');
    await expect(page.getByTestId('status-strip-detail')).toHaveCount(0);
    await expect(page.getByTestId('agents-admin-note')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('10.42.0.1');
  } finally {
    await context.close();
  }
});

test('Projects opens with a status strip and folds How to connect', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/projects', isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    const strip = page.getByTestId('projects-strip');
    await expect(strip).toBeVisible();
    const item = strip.locator('[data-item="manythreads"]');
    await expect(item).toBeVisible();
    await expect(item.getByTestId('status-strip-word')).toHaveText('No token yet');
    const stripBox = (await strip.boundingBox())!;
    const rowBox = (await page.getByTestId('projects-row').first().boundingBox())!;
    expect(stripBox.y).toBeLessThan(rowBox.y);
    const fold = page.getByTestId('projects-how-fold');
    await expect(fold).not.toHaveAttribute('open', '');
    await fold.getByText('How to connect', { exact: true }).click();
    await expect(fold).toContainText('Press Add project');
    if (isMobile) expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});

test('the strip is a landmark with a name, and each state is a word as well as a dot', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/agents');
  try {
    await expect(page.getByRole('region', { name: 'Agent connections' })).toBeVisible();
    await expect(page.getByTestId('agents-strip').locator('.ss-dot').first()).toHaveAttribute('aria-hidden', 'true');
    // a failed check turns the word red-and-spelled: "Not working"
    await stack.sql("UPDATE app.hermes_connections SET status = 'error', last_error = 'refused' WHERE name = 'pod-one'");
    await page.reload();
    const item = page.getByTestId('agents-strip').locator('[data-item="pod-one"]');
    await expect(item.getByTestId('status-strip-word')).toHaveText('Not working');
    await expect(item).toHaveAttribute('data-tone', 'bad');
  } finally {
    await context.close();
  }
});
