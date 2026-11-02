import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { openOn } from '../support/stack-browser.ts';
import { actorOf } from '../files/support.ts';
import { BOTS_STACK_ENV, apiOn, commitDefinition, definitionOf, openBot } from './support.ts';
import type { StackApi } from '../support/stack-browser.ts';

/*
 * Where a bot runs, on the Placement tab (PLAN P19-03): one select "Runs on" with the runners an admin set up and this team may use, the default
 * preselected, a runner that is not Ready choosable with a plain note, no address, key or node anywhere; the free-text Node and Runner fields are gone,
 * an older placement shows read-only under "Old placement" with a button "Move to a runner"; a member who may not edit sees no select.
 * Runs on its own stack because it commits.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout; the narrow layout is checked inside');
test.describe.configure({ mode: 'serial' });

let stack: Stack;

const addRunner = async (name: string, fields: { label: string; kind: string; status: string; enabled?: boolean; allTeams?: boolean; isDefault?: boolean; baseUrl?: string; teams?: string[] }): Promise<void> => {
  const [row] = await stack.sql<{ id: string }>(
    `INSERT INTO app.bot_runners (workspace_id, name, label, kind, status, enabled, all_teams, is_default, base_url)
     VALUES ((SELECT workspace_id FROM app.teams WHERE slug = 'engineering'), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [name, fields.label, fields.kind, fields.status, fields.enabled ?? true, fields.allTeams ?? false, fields.isDefault ?? false, fields.baseUrl ?? null],
  );
  for (const team of fields.teams ?? []) {
    await stack.sql('INSERT INTO app.bot_runner_teams (runner_id, team_id) VALUES ($1, (SELECT id FROM app.teams WHERE slug = $2))', [row!.id, team]);
  }
};

/**
 * Put the Coder's `placement:` block as the test needs it (null = no block), built from the file the repo holds now: the frontmatter's `placement:` lines are
 * dropped and the new ones go before its closing fence; everything else is kept as it is. Then wait for the loader to project it onto the roster row.
 */
async function placeCoder(playwright: Parameters<typeof apiOn>[0], lines: string[] | null, projected: (placement: Record<string, unknown> | null) => boolean): Promise<void> {
  const api: StackApi = await apiOn(playwright, stack, 'omar');
  try {
    const def = await definitionOf(api);
    const text = def.content.split('\n');
    const close = text.indexOf('---', 1);
    expect(close, 'the definition has a frontmatter').toBeGreaterThan(0);
    const kept: string[] = [];
    let inPlacement = false;
    text.slice(0, close).forEach((line) => {
      if (/^placement:/.test(line)) inPlacement = true;
      else if (inPlacement && /^\s/.test(line)) return;
      else inPlacement = false;
      if (!inPlacement) kept.push(line);
    });
    const next = [...kept, ...(lines === null ? [] : ['placement:', ...lines.map((l) => `  ${l}`)]), ...text.slice(close)].join('\n');
    if (next !== def.content) await commitDefinition(api, next, 'Place the Coder for the runs-on spec', def.blobSha);
  } finally {
    await api.ctx.dispose();
  }
  await expect
    .poll(async () => projected(((await stack.sql<{ placement: Record<string, unknown> | null }>("SELECT placement FROM app.bots WHERE slug = 'coder'"))[0] ?? { placement: null }).placement), { timeout: 20_000 })
    .toBe(true);
}

test.beforeAll(async () => {
  stack = await startStack({ ...BOTS_STACK_ENV });
  await addRunner('house', { label: 'House Hermes', kind: 'hermes_gateway', status: 'ready', isDefault: true, baseUrl: 'http://secret-address.example.test:8642', teams: ['engineering'] });
  await addRunner('pod', { label: 'Team pod', kind: 'hermes_pod', status: 'starting', allTeams: true });
  await addRunner('claude', { label: 'Claude Code', kind: 'claude_cli', status: 'ready', allTeams: true });
  await addRunner('marketing-only', { label: 'Marketing only', kind: 'hermes_gateway', status: 'ready', teams: ['marketing'] });
});
test.afterAll(async () => {
  await stack?.stop();
});


const NO_RUNS_ON = (placement: Record<string, unknown> | null): boolean => placement === null || placement['runs_on'] === undefined;

test('a lead picks a runner: only what the team may use is listed, a runner that is not Ready says so, and no address shows', async ({ browser, playwright }) => {
  await placeCoder(playwright, null, NO_RUNS_ON);
  const { page, close } = await openBot(browser, playwright, stack, 'omar', 'coder', '?tab=placement');
  try {
    const select = page.getByTestId('runs-on-select');
    await expect(select).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel('Runs on')).toBeVisible();
    // the free-text fields left the tab
    await expect(page.getByLabel('Node', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Runner', { exact: true })).toHaveCount(0);

    const options = (await select.locator('option').allTextContents()).join(' | ');
    expect(options).toContain('House Hermes');
    expect(options).toContain('Team pod');
    expect(options).not.toContain('Marketing only');
    // the default is named on the empty choice, which is the preselected one
    await expect(select).toHaveValue('');
    expect((await select.locator('option').first().textContent()) ?? '').toContain('House Hermes');
    // a kind that cannot run bots yet is listed and cannot be chosen
    await expect(select.locator('option', { hasText: 'Claude Code' })).toBeDisabled();

    // never an address, a key or a node
    const body = await page.getByTestId('bot-page').innerText();
    expect(body).not.toContain('secret-address');
    expect(body).not.toMatch(/https?:\/\//);

    // a runner that is not Ready can be chosen and the page says so
    await select.selectOption('pod');
    await expect(page.getByTestId('runs-on-note')).toContainText('not ready');
    await expect(page.getByTestId('runs-on-state')).toContainText('Starting');
    await expect(page.getByTestId('dirty-state')).toContainText('Unsaved changes');

    await page.getByTestId('save-bot').click();
    await expect(page.getByTestId('dirty-state')).toContainText('No changes', { timeout: 15_000 });
  } finally {
    await close();
  }
  // the file in the repo says so, and the loader projected it onto the bot
  const api = await apiOn(playwright, stack, 'omar');
  try {
    expect((await definitionOf(api)).content).toContain('runs_on: pod');
  } finally {
    await api.ctx.dispose();
  }
  await expect.poll(async () => (await stack.sql<{ placement: { runs_on?: string } | null }>("SELECT placement FROM app.bots WHERE slug = 'coder'"))[0]?.placement?.runs_on, { timeout: 20_000 }).toBe('pod');
});

test('the choice is kept after a reload; the select takes focus, Tab leaves it, and a choice made by keyboard counts as a change', async ({ browser, playwright }) => {
  await placeCoder(playwright, ['runs_on: pod'], (p) => p?.['runs_on'] === 'pod');
  const { page, close } = await openBot(browser, playwright, stack, 'omar', 'coder', '?tab=placement');
  try {
    const select = page.getByTestId('runs-on-select');
    await expect(select).toHaveValue('pod', { timeout: 15_000 });
    await select.focus();
    await expect(select).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(select).not.toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(select).toBeFocused();
    await select.selectOption('house');
    await expect(select).toHaveValue('house');
    await expect(page.getByTestId('dirty-state')).toContainText('Unsaved changes');
  } finally {
    await close();
  }
});

test('a member who may not edit the bot sees where it runs as text and no select', async ({ browser, playwright }) => {
  await stack.sql("UPDATE app.team_members SET role = 'member' WHERE team_id = (SELECT id FROM app.teams WHERE slug = 'engineering') AND actor_id = $1", [actorOf('nadia')]);
  await placeCoder(playwright, ['runs_on: pod'], (p) => p?.['runs_on'] === 'pod');
  const { page, close } = await openBot(browser, playwright, stack, 'nadia', 'coder', '?tab=placement');
  try {
    await expect(page.getByTestId('runs-on-readonly')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('runs-on-select')).toHaveCount(0);
    await expect(page.getByTestId('runs-on-text')).toContainText('Team pod');
    await expect(page.getByTestId('save-bot')).toHaveCount(0);
  } finally {
    await close();
  }
});

test('an older placement shows read-only under "Old placement" and "Move to a runner" replaces it', async ({ browser, playwright }) => {
  await placeCoder(playwright, ['runner: test-server-01'], (p) => p?.['runner'] === 'test-server-01');
  const { page, close } = await openBot(browser, playwright, stack, 'omar', 'coder', '?tab=placement');
  try {
    await expect(page.getByTestId('old-placement')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('old-placement')).toContainText('test-server-01');
    await expect(page.getByTestId('runs-on-select')).toHaveCount(0);
    await page.getByTestId('move-to-runner').click();
    await expect(page.getByTestId('runs-on-select')).toBeVisible();
    await expect(page.getByTestId('dirty-state')).toContainText('Unsaved changes');
    await page.getByTestId('save-bot').click();
    await expect(page.getByTestId('dirty-state')).toContainText('No changes', { timeout: 15_000 });
  } finally {
    await close();
  }
  const api = await apiOn(playwright, stack, 'omar');
  try {
    const def = await definitionOf(api);
    expect(def.content).toContain('runs_on:');
    expect(def.content).not.toContain('test-server-01');
  } finally {
    await api.ctx.dispose();
  }
});

test('at 390 px the tab does not scroll sideways and the select stays inside the screen', async ({ browser, playwright }) => {
  await stack.sql("UPDATE app.team_members SET role = 'lead' WHERE team_id = (SELECT id FROM app.teams WHERE slug = 'engineering') AND actor_id = $1", [actorOf('nadia')]);
  await placeCoder(playwright, null, NO_RUNS_ON);
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/bots/coder?tab=placement');
  try {
    await page.setViewportSize({ width: 390, height: 800 });
    const select = page.getByTestId('runs-on-select');
    await expect(select).toBeVisible({ timeout: 15_000 });
    const box = (await select.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await context.close();
  }
});
