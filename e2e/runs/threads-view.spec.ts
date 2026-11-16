import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { apiOn, channelsOf, noSidewaysScroll, openOn, PHONE, postAs, type StackApi } from '../support/stack-browser.ts';
import { JOURNEY, ORCHESTRATE } from './scripts.ts';
import { startRunsWorld, type RunsWorld } from './support.ts';

/*
 * The Threads view as a bird's-eye view (PLAN P29-16, P29-17, P29-18; docs/plans/channel-task-view.md section 10c). The world is the `runs` stack. What is real: the two threads and their
 * replies, the mention, the bots' runs, `tasks.todo`, the approval the agent asks for, the three batched reads, the pushes and the web client. Pictures (list and grid, Graphite dark and light,
 * Linen, Harbor, 1440 and 390 px) go to temp/screenshots/p29 (git-ignored).
 */
test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);
test.skip(({ isMobile }) => isMobile, 'the stack is driven once; the 390 px views are opened inside the tests');

const SHOTS = join(import.meta.dirname, '..', '..', 'temp', 'screenshots', 'p29');
let world: RunsWorld;
let dev = '';
let nadia: StackApi;
let omar: StackApi;
let lead: { id: string };
let token = '';
let rootA = ''; // the thread with a to-do list and a mention
let rootB = ''; // the thread with a question waiting

test.beforeAll(async ({ playwright }) => {
  mkdirSync(SHOTS, { recursive: true });
  world = await startRunsWorld();
  nadia = await apiOn(playwright, world.stack, 'nadia');
  omar = await apiOn(playwright, world.stack, 'omar');
  dev = (await channelsOf(nadia))['dev']!;
});
test.afterAll(async () => {
  await nadia?.ctx.dispose();
  await omar?.ctx.dispose();
  await world?.close();
});

async function noOpenRun(slug: string): Promise<void> {
  await expect
    .poll(async () => (await world.stack.sql<{ n: string }>(`SELECT count(*)::text AS n FROM app.bot_runs r JOIN app.bots b ON b.id = r.bot_id WHERE b.slug = $1 AND r.ended_at IS NULL`, [slug]))[0]?.n, { timeout: 60_000 })
    .toBe('0');
}

async function openRun(slug: string): Promise<void> {
  await expect
    .poll(async () => (await world.stack.sql<{ n: string }>(`SELECT count(*)::text AS n FROM app.bot_runs r JOIN app.bots b ON b.id = r.bot_id WHERE b.slug = $1 AND r.ended_at IS NULL`, [slug]))[0]?.n, { timeout: 90_000 })
    .toBe('1');
}

async function tool(id: number, args: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${world.stack.origin}/api/mcp/bots/${lead.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'tasks.todo', arguments: args } }),
  });
  expect(JSON.stringify(await res.json()), 'tasks.todo').not.toContain('"isError":true');
}

async function look(palette: string, theme: string): Promise<void> {
  const res = await nadia.ctx.put('/api/me/appearance', { data: { palette, theme }, headers: await nadia.headers() });
  expect(res.status(), await res.text()).toBe(200);
}

const rowOf = (page: Page, root: string) => page.locator(`[data-testid="thread-row"][data-root-id="${root}"]`);
const cardOf = (page: Page, root: string) => page.locator(`[data-testid="thread-card"][data-root-id="${root}"]`);

test('two threads: one with a to-do list and a mention, one with a question that waits', async ({ browser, playwright }) => {
  await look('graphite', 'light');
  // thread A: the lead bot has a to-do list; a colleague names Nadia, then adds a plain reply
  world.script(ORCHESTRATE);
  lead = await world.bot('run-lead');
  const a = await postAs(nadia, dev, '@run-lead build the run card and test it');
  rootA = a.id;
  await postAs(omar, dev, '@nadia can you decide the order of the cards before the bot goes on?', rootA);
  await postAs(omar, dev, 'I will look at the colours meanwhile, no hurry on the second part.', rootA);
  await openRun('run-lead');
  token = (await omar.post<{ token: string }>('/api/teams/engineering/bots/run-lead/pairing-tokens', {})).token;
  await tool(1, {
    action: 'set',
    title: 'Run card',
    items: [
      { id: 'plan', text: 'Plan the parts', status: 'done' },
      { id: 'build', text: 'Build the run card', status: 'working' },
      { id: 'docs', text: 'Write the notes', status: 'waiting' },
      { id: 'ship', text: 'Tell the team', status: 'waiting' },
    ],
  });
  // thread B: the demo bot asks to run a command
  await noOpenRun('run-demo');
  world.script(JOURNEY);
  const b = await postAs(nadia, dev, '@run-demo change the thread panel, then run the tests');
  rootB = b.id;
  await postAs(omar, dev, 'The tests are slow today, so wait for them.', rootB);

  const opened = await openOn(browser, playwright, world.stack, 'nadia', '/t/engineering/threads');
  const page = opened.page;
  const requests: string[] = [];
  page.on('request', (r) => requests.push(`${r.method()} ${new URL(r.url()).pathname}`));
  try {
    await expect(rowOf(page, rootA)).toBeVisible({ timeout: 60_000 });
    // thread A: one line of progress, and the mention is shown first, then the latest reply (the mention is older)
    const a1 = rowOf(page, rootA);
    await expect(a1.getByTestId('thread-progress')).toContainText('1 of 4', { timeout: 60_000 });
    await expect(a1.getByTestId('thread-progress')).toContainText('Build the run card');
    await expect(a1.getByTestId('thread-needs-you')).toBeVisible();
    await expect(a1.locator('.thc-blk')).toHaveCount(2);
    await expect(a1.getByTestId('thread-mention-block')).toContainText('Mentions you');
    await expect(a1.getByTestId('thread-latest-block')).toContainText('Latest reply');
    await expect(a1.getByTestId('thread-latest-block')).toContainText('run-lead'); // the bot's to-do card is the newest message
    // thread B: a question waits: the chip and the "Needs you" group
    await expect(rowOf(page, rootB).getByTestId('thread-needs-you')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('thread-needs-group')).toBeVisible();
    // the reply that is only a reply has no mention block: B's latest reply is from Omar and does not name Nadia
    await expect(rowOf(page, rootB).locator('.thc-blk')).toHaveCount(1);
    // nothing asked per row: no request names a thread's own runs, todo or approvals paths for the listed roots
    expect(requests.filter((r) => /\/api\/threads\/[0-9a-f-]{36}\/(runs|todo|approvals)\b/.test(r) && !r.includes(rootA)), 'no per-row reads').toEqual([]);
    expect(requests.filter((r) => r.includes('/api/thread-batch/')).length, 'the batches').toBeGreaterThan(0);
    await page.screenshot({ path: join(SHOTS, 'threads-list.graphite.light.png') });

    // a tick on the bot's list is on the row without a reload
    await tool(2, { action: 'update', id: 'build', status: 'done' });
    await expect(a1.getByTestId('thread-progress')).toContainText('2 of 4', { timeout: 30_000 });

    // the filter: words, with the match marked; the address holds it; Escape clears it
    const box = page.getByTestId('threads-filter-input');
    await box.fill('decide');
    await expect(page).toHaveURL(/[?&]q=decide/);
    await expect(rowOf(page, rootA)).toBeVisible();
    await expect(rowOf(page, rootB)).toHaveCount(0);
    await expect(rowOf(page, rootA).locator('mark.thc-hit').first()).toBeVisible();
    await expect(page.getByTestId('threads-filter-status')).toContainText('1 thread matches');
    await box.press('Escape');
    await expect(box).toHaveValue('');
    await expect(page).not.toHaveURL(/[?&]q=/);
    await expect(rowOf(page, rootB)).toBeVisible();
    // a word only an older reply holds is found by the server
    await box.fill('colours');
    await expect(rowOf(page, rootA)).toBeVisible({ timeout: 30_000 });
    await expect(rowOf(page, rootB)).toHaveCount(0);
    // the channel's name is a word too, and its matches come first
    await box.fill('dev');
    await expect(rowOf(page, rootA)).toBeVisible();
    // @name: the threads that mention that person; a name nobody has says so
    await box.fill('@nadia');
    await expect(rowOf(page, rootA)).toBeVisible({ timeout: 30_000 });
    await expect(rowOf(page, rootB)).toHaveCount(0);
    await box.fill('@nobodyatall');
    await expect(page.getByTestId('threads-filter-empty')).toContainText('Nobody has that name');
    await page.getByRole('button', { name: 'Clear the filter' }).last().click();
    await expect(box).toHaveValue('');
    // the address opens with the filter already in it
    await page.goto('/t/engineering/threads?q=colours');
    await expect(page.getByTestId('threads-filter-input')).toHaveValue('colours');
    await expect(rowOf(page, rootB)).toHaveCount(0);
    await page.goto('/t/engineering/threads');
    // "Needs you first" off: plain time order, no group
    await page.getByTestId('threads-order').click();
    await expect(page.getByTestId('thread-needs-group')).toHaveCount(0);
    await expect(page).toHaveURL(/order=time/);
    await page.getByTestId('threads-order').click();
    await expect(page.getByTestId('thread-needs-group')).toBeVisible();
  } finally {
    await opened.context.close();
  }
});

test('the grid: remembered, a card carries the question and its buttons, and opens the thread', async ({ browser, playwright }) => {
  await look('graphite', 'light');
  const opened = await openOn(browser, playwright, world.stack, 'nadia', '/t/engineering/threads');
  const page = opened.page;
  try {
    await page.getByTestId('threads-layout-grid').click();
    await expect(page.locator('.thg-grid')).toBeVisible();
    await expect(cardOf(page, rootA)).toBeVisible({ timeout: 60_000 });
    await expect(cardOf(page, rootB).getByTestId('tv-question')).toBeVisible({ timeout: 120_000 });
    await expect(cardOf(page, rootA).getByTestId('thread-progress')).toContainText('of 4');
    await expect(cardOf(page, rootA).getByTestId('thread-mention-block')).toBeVisible();
    const columns = await page.locator('.thg-grid').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    expect(columns, 'several columns on a wide screen').toBeGreaterThan(2);
    const widths = await page.locator('[data-testid="thread-card"]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
    for (const w of widths) expect(w, 'a card is at least 320 px wide').toBeGreaterThanOrEqual(300);
    await page.screenshot({ path: join(SHOTS, 'threads-grid.graphite.light.png') });
    // remembered across a reload
    await page.reload();
    await expect(page.locator('.thg-grid')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('threads-layout-grid')).toHaveAttribute('aria-pressed', 'true');
    // open: the thread shows with a way back, and the grid is still the choice
    await cardOf(page, rootA).getByTestId('thread-card-open').click();
    await expect(page.getByTestId('thread-view')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Threads' }).first().click();
    await expect(page.locator('.thg-grid')).toBeVisible();
    // Yes, on the card: the same decide path, the strip goes and the row stops needing Nadia
    await cardOf(page, rootB).getByTestId('tv-question-yes').click();
    await expect(cardOf(page, rootB).getByTestId('tv-question')).toHaveCount(0, { timeout: 60_000 });
    // list again
    await page.getByTestId('threads-layout-list').click();
    await expect(page.locator('.thg-grid')).toHaveCount(0);
    await expect(rowOf(page, rootA)).toBeVisible();
  } finally {
    await opened.context.close();
  }
});

test('read in every look, light and dark, at 1440 and 390 px', async ({ browser, playwright }) => {
  for (const palette of ['graphite', 'linen', 'harbor']) {
    for (const theme of ['light', 'dark']) {
      await look(palette, theme);
      for (const mode of ['list', 'grid'] as const) {
        for (const small of [false, true]) {
          const opened = await openOn(browser, playwright, world.stack, 'nadia', '/t/engineering/threads', small ? { viewport: PHONE, mobile: true } : {});
          const page = opened.page;
          try {
            await expect(page.getByTestId('threads-layout-list')).toBeVisible({ timeout: 60_000 });
            await page.getByTestId(`threads-layout-${mode}`).click();
            await expect(rowOrCard(page, mode, rootA)).toBeVisible({ timeout: 60_000 });
            expect(await noSidewaysScroll(page), `${palette} ${theme} ${mode} ${small ? '390' : '1440'}: nothing scrolls sideways`).toBe(true);
            await page.screenshot({ path: join(SHOTS, `threads-${mode}.${palette}.${theme}.${small ? '390' : '1440'}.png`) });
          } finally {
            await opened.context.close();
          }
        }
      }
    }
  }
  await look('graphite', 'light');
});

function rowOrCard(page: Page, mode: 'list' | 'grid', root: string) {
  return mode === 'grid' ? cardOf(page, root) : rowOf(page, root);
}
