import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import { apiOn, channelsOf, noSidewaysScroll, openOn, PHONE, postAs, type StackApi } from '../support/stack-browser.ts';
import { JOURNEY, ORCHESTRATE } from './scripts.ts';
import { startRunsWorld, type RunsWorld } from './support.ts';

/*
 * The task view under a thread root in the channel, and the dock above a thread's composer (PLAN P29-06, P29-09, P29-12; docs/plans/channel-task-view.md). The world is the `runs` stack of
 * run-card.spec.ts (a real agent bridge that starts tools/fake-acp-agent). What is real: the mention, the run and its record, the pushes, the channel's lease and its three batched reads,
 * the approval the agent asks for, `tasks.todo`, and the web client. Pictures (light, dark, 390 px) go to temp/screenshots/p29, which is git-ignored.
 */
test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);
test.skip(({ isMobile }) => isMobile, 'the stack is driven once; the 390 px views are opened inside the tests');

const SHOTS = join(import.meta.dirname, '..', '..', 'temp', 'screenshots', 'p29');
let world: RunsWorld;
let dev = '';

test.beforeAll(async ({ playwright }) => {
  mkdirSync(SHOTS, { recursive: true });
  world = await startRunsWorld();
  const nadia = await apiOn(playwright, world.stack, 'nadia');
  try {
    dev = (await channelsOf(nadia))['dev']!;
  } finally {
    await nadia.ctx.dispose();
  }
});
test.afterAll(async () => {
  await world?.close();
});

const channelPath = '/t/engineering/c/dev';
const view = (page: Page, rootId: string) => page.locator(`[data-testid="task-view"][data-root="${rootId}"]`);

async function noOpenRun(slug: string): Promise<void> {
  await expect
    .poll(async () => (await world.stack.sql<{ n: string }>(`SELECT count(*)::text AS n FROM app.bot_runs r JOIN app.bots b ON b.id = r.bot_id WHERE b.slug = $1 AND r.ended_at IS NULL`, [slug]))[0]?.n, { timeout: 60_000 })
    .toBe('0');
}

/** Nadia asks a bot in the channel, and her page shows the channel (no thread open). Every request the page makes is kept, to prove what it did not ask for. */
async function ask(browser: Browser, playwright: PlaywrightWorkerArgs['playwright'], slug: string, text: string, path = channelPath): Promise<{ page: Page; rootId: string; api: StackApi; requests: string[]; close: () => Promise<void> }> {
  await noOpenRun(slug);
  const api = await apiOn(playwright, world.stack, 'nadia');
  const root = await postAs(api, dev, `@${slug} ${text}`);
  const opened = await openOn(browser, playwright, world.stack, 'nadia', path);
  const requests: string[] = [];
  opened.page.on('request', (r) => requests.push(`${r.method()} ${new URL(r.url()).pathname}`));
  return {
    page: opened.page,
    rootId: root.id,
    api,
    requests,
    close: async () => {
      await opened.context.close();
      await api.ctx.dispose();
    },
  };
}

async function shots(page: Page, name: string): Promise<void> {
  await page.waitForFunction(() => [...document.querySelectorAll('img')].every((i) => i.complete), undefined, { timeout: 10_000 }).catch(() => undefined);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: join(SHOTS, `${name}.light.png`) });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: join(SHOTS, `${name}.dark.png`) });
  await page.emulateMedia({ colorScheme: 'light' });
}

test('the channel follows a run and answers its question without opening the thread, with one lease and no request per thread', async ({ browser, playwright }) => {
  world.script(JOURNEY);
  const nadia = await ask(browser, playwright, 'run-demo', 'please change the thread panel');
  try {
    const tv = view(nadia.page, nadia.rootId);
    // the run: who, working, what it does now, the counts and the last few steps, under the root
    await expect(tv.getByTestId('tv-run')).toBeVisible({ timeout: 60_000 });
    await expect(tv.getByTestId('tv-run-state')).toContainText(/Starting|Working|Waiting/);
    await expect(tv.getByTestId('tv-run-work')).toContainText(/\d+ steps?/, { timeout: 60_000 });
    expect(await tv.getByTestId('tv-run-steps').locator(':scope > li').count()).toBeLessThanOrEqual(3);
    await expect(tv.getByTestId('tv-run-stop')).toHaveAttribute('aria-label', /^Stop /);

    // the question it asks is under the root, with Yes and No; the run is waiting
    await expect(tv.getByTestId('tv-question')).toBeVisible({ timeout: 60_000 });
    await expect(tv.getByTestId('tv-question-yes')).toBeVisible();
    await expect(tv.getByTestId('tv-question-no')).toBeVisible();
    // the cards are not live regions; the channel has one line for a screen reader
    await expect(tv.locator('[role="status"], [aria-live]')).toHaveCount(0);
    await expect(nadia.page.getByTestId('task-view-said')).toHaveText('1 question is waiting for an answer');
    await shots(nadia.page, 'channel-run-question');

    // no request of its own for this thread: the channel's lease, and three reads for the whole channel
    const own = nadia.requests.filter((r) => r.includes(`/api/threads/${nadia.rootId}/`) && /\/(runs|watch|todo)\b/.test(r));
    expect(own, 'no per-thread run, watch or to-do call from the channel view').toEqual([]);
    const leasePuts = nadia.requests.filter((r) => r.startsWith('PUT') && r.includes(`/api/channels/${dev}/watch/`));
    expect(leasePuts.length, 'the channel lease is renewed every 20 seconds, not per row').toBeLessThanOrEqual(2);

    // Hide folds the cards to a chip, never the question, and the choice is remembered for this thread
    await tv.getByTestId('tv-hide').click();
    await expect(tv.getByTestId('tv-run')).toHaveCount(0);
    await expect(tv.getByTestId('tv-chip')).toContainText('is working');
    await expect(tv.getByTestId('tv-question')).toBeVisible();
    await nadia.page.reload();
    await expect(view(nadia.page, nadia.rootId).getByTestId('tv-chip')).toBeVisible({ timeout: 30_000 });
    await expect(view(nadia.page, nadia.rootId).getByTestId('tv-run')).toHaveCount(0);
    await view(nadia.page, nadia.rootId).getByTestId('tv-chip').click();
    await expect(view(nadia.page, nadia.rootId).getByTestId('tv-run')).toBeVisible();

    // 390 px: Yes and No are two equal buttons on one row, each at least 44 px high, and nothing scrolls sideways
    const phone = await openOn(browser, playwright, world.stack, 'nadia', channelPath, { viewport: PHONE, mobile: true });
    try {
      const pv = view(phone.page, nadia.rootId);
      await expect(pv.getByTestId('tv-question-yes')).toBeVisible({ timeout: 30_000 });
      const yes = (await pv.getByTestId('tv-question-yes').boundingBox())!;
      const no = (await pv.getByTestId('tv-question-no').boundingBox())!;
      expect(yes.height).toBeGreaterThanOrEqual(44);
      expect(no.height).toBeGreaterThanOrEqual(44);
      expect(Math.abs(yes.width - no.width)).toBeLessThanOrEqual(2);
      expect(Math.abs(yes.y - no.y)).toBeLessThanOrEqual(2);
      expect(await noSidewaysScroll(phone.page), 'nothing scrolls sideways at 390 px').toBe(true);
      await phone.page.screenshot({ path: join(SHOTS, 'channel-run-question.390.png') });
    } finally {
      await phone.context.close();
    }

    // Yes, here: the run goes on without opening the thread, the strip goes, the run folds to its one line
    await tv.getByTestId('tv-question-yes').click();
    await expect(tv.getByTestId('tv-question')).toHaveCount(0, { timeout: 30_000 });
    await expect(tv.getByTestId('tv-run-ended')).toBeVisible({ timeout: 90_000 });
    await expect(tv.getByTestId('tv-run')).toHaveCount(0);
    await expect(nadia.page.getByTestId('task-view-said')).toHaveText('');
    await shots(nadia.page, 'channel-run-ended');
  } finally {
    await nadia.close();
  }
});

test('the to-do list and the run follow the bot in the channel; Stop works from there', async ({ browser, playwright }) => {
  world.script(ORCHESTRATE);
  const lead = await world.bot('run-lead');
  const nadia = await ask(browser, playwright, 'run-lead', 'build the run card and test it');
  const omar = await apiOn(playwright, world.stack, 'omar');
  try {
    const tv = view(nadia.page, nadia.rootId);
    await expect(tv.getByTestId('tv-run')).toBeVisible({ timeout: 60_000 });
    const minted = await omar.post<{ token: string }>('/api/teams/engineering/bots/run-lead/pairing-tokens', {});
    const tool = async (id: number, args: Record<string, unknown>): Promise<void> => {
      const res = await fetch(`${world.stack.origin}/api/mcp/bots/${lead.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${minted.token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'tasks.todo', arguments: args } }),
      });
      expect(JSON.stringify(await res.json()), 'tasks.todo').not.toContain('"isError":true');
    };
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
    // the list appears under the root with no reload, the working item first
    await expect(tv.getByTestId('tv-todo-count')).toHaveText('1 of 4', { timeout: 30_000 });
    await expect(tv.getByTestId('tv-todo-items').locator('li').first()).toContainText('Build the run card');
    await shots(nadia.page, 'channel-todo-run');
    // an item ticks: the count follows
    await tool(2, { action: 'update', id: 'build', status: 'done' });
    await expect(tv.getByTestId('tv-todo-count')).toHaveText('2 of 4', { timeout: 30_000 });
    // the rest: the list says it is done, for a few minutes
    await tool(3, { action: 'update', id: 'docs', status: 'done' });
    await tool(4, { action: 'update', id: 'ship', status: 'done' });
    await expect(tv.getByTestId('tv-todo-count')).toHaveText('4 of 4 done', { timeout: 30_000 });
    await expect(tv.getByTestId('tv-todo-items')).toHaveCount(0);
    // Stop, from the channel: one press, and the folded line says who stopped it
    await tv.getByTestId('tv-run-stop').click();
    await expect(tv.getByTestId('tv-run-ended')).toContainText(/Stopped by Nadia/, { timeout: 60_000 });
    await expect(tv.getByTestId('tv-run-ended')).toHaveAttribute('data-tone', 'stopped');
    // after a reload the same: read from the server, in one go for the whole channel
    await nadia.page.reload();
    await expect(view(nadia.page, nadia.rootId).getByTestId('tv-run-ended')).toContainText(/Stopped by Nadia/, { timeout: 30_000 });
  } finally {
    await omar.ctx.dispose();
    await nadia.close();
  }
});

test('open at the side, the channel keeps a chip and the thread holds the question right above the composer', async ({ browser, playwright }) => {
  world.script(JOURNEY);
  const nadia = await ask(browser, playwright, 'run-demo', 'change the panel again');
  try {
    const tv = view(nadia.page, nadia.rootId);
    await expect(tv.getByTestId('tv-question')).toBeVisible({ timeout: 90_000 });
    // "Open thread" opens it at the side; the channel's cards fold to a chip, so the question is asked in one place
    await tv.getByTestId('tv-open-thread').click();
    await expect(nadia.page.getByTestId('thread-view')).toBeVisible();
    await expect(tv.getByTestId('tv-chip')).toContainText('open at the side');
    await expect(tv.getByTestId('tv-question')).toHaveCount(0);
    const dock = nadia.page.getByTestId('thread-view').getByTestId('thread-dock');
    await expect(dock.getByTestId('tv-question')).toBeVisible({ timeout: 30_000 });
    // not repeated in the replies, nor in the run card
    await expect(nadia.page.getByTestId('thread-approvals')).toHaveCount(0);
    await expect(nadia.page.getByTestId('run-questions')).toHaveCount(0);
    // the strip is the lowest thing in the dock and the dock sits directly above the composer
    const strip = (await dock.getByTestId('tv-question').boundingBox())!;
    const dockBox = (await dock.boundingBox())!;
    const composer = (await nadia.page.getByTestId('thread-view').locator('.rpf').boundingBox())!;
    expect(strip.y + strip.height).toBeLessThanOrEqual(dockBox.y + dockBox.height + 1);
    expect(dockBox.y + dockBox.height).toBeLessThanOrEqual(composer.y + 2);
    expect(composer.y - (dockBox.y + dockBox.height)).toBeLessThan(16);
    // folding keeps the question on screen
    if (await dock.getByTestId('dock-toggle').count()) {
      if ((await dock.getByTestId('dock-toggle').getAttribute('aria-expanded')) === 'true') await dock.getByTestId('dock-toggle').click();
      await expect(dock.getByTestId('dock-line')).toBeVisible();
      await expect(dock.getByTestId('tv-question')).toBeVisible();
      await nadia.page.screenshot({ path: join(SHOTS, 'dock-folded.light.png') });
      await dock.getByTestId('dock-toggle').click();
    }
    await shots(nadia.page, 'dock-open');
    // the run card is still followed above the composer: it has the steps it took
    await expect(dock.getByTestId('tv-run')).toBeVisible();

    // 390 px: the strip is above the composer, in sight, and the dock is folded to one line
    const phone = await openOn(browser, playwright, world.stack, 'nadia', `${channelPath}?panel=thread:${nadia.rootId}`, { viewport: PHONE, mobile: true });
    try {
      const pdock = phone.page.getByTestId('thread-dock');
      await expect(pdock.getByTestId('tv-question')).toBeVisible({ timeout: 30_000 });
      await expect(pdock.getByTestId('dock-line')).toBeVisible();
      const q = (await pdock.getByTestId('tv-question').boundingBox())!;
      const c = (await phone.page.locator('.rpf').first().boundingBox())!;
      expect(q.y + q.height).toBeLessThanOrEqual(c.y + 2);
      expect((await pdock.getByTestId('tv-question-yes').boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(await noSidewaysScroll(phone.page)).toBe(true);
      await phone.page.screenshot({ path: join(SHOTS, 'dock-folded.390.png') });
    } finally {
      await phone.context.close();
    }

    // she says Yes in the dock: the run goes on, the strip goes, and the channel gets its chip back as the thread closes
    await dock.getByTestId('tv-question-yes').click();
    await expect(dock.getByTestId('tv-question')).toHaveCount(0, { timeout: 30_000 });
    await expect(nadia.page.getByTestId('run-end')).toBeVisible({ timeout: 90_000 });
  } finally {
    await nadia.close();
  }
});

test('the cards read well in the four palettes, light and dark, at 1440 px and at 390 px', async ({ browser, playwright }) => {
  world.script(JOURNEY);
  const nadia = await ask(browser, playwright, 'run-demo', 'change the panel in every look');
  try {
    await expect(view(nadia.page, nadia.rootId).getByTestId('tv-question')).toBeVisible({ timeout: 90_000 });
    for (const palette of ['graphite', 'linen', 'harbor', 'classic'] as const) {
      for (const theme of ['light', 'dark'] as const) {
        const res = await nadia.api.ctx.put('/api/me/appearance', { data: { palette, theme }, headers: await nadia.api.headers() });
        expect(res.status(), await res.text()).toBe(200);
        for (const phone of [false, true]) {
          const opened = await openOn(browser, playwright, world.stack, 'nadia', phone ? `${channelPath}?panel=thread:${nadia.rootId}` : channelPath, phone ? { viewport: PHONE, mobile: true } : {});
          try {
            const scope = phone ? opened.page.getByTestId('thread-dock') : view(opened.page, nadia.rootId);
            await expect(scope.getByTestId('tv-question')).toBeVisible({ timeout: 30_000 });
            expect(await noSidewaysScroll(opened.page), `${palette} ${theme} ${phone ? '390' : '1440'}`).toBe(true);
            await opened.page.screenshot({ path: join(SHOTS, `palette-${palette}.${theme}.${phone ? '390' : '1440'}.png`) });
          } finally {
            await opened.context.close();
          }
        }
      }
    }
    await nadia.api.ctx.put('/api/me/appearance', { data: { palette: 'classic', theme: 'system' }, headers: await nadia.api.headers() });
    // let the run finish before the stack is taken down
    await nadia.page.reload();
    await view(nadia.page, nadia.rootId).getByTestId('tv-question-yes').click();
    await expect(view(nadia.page, nadia.rootId).getByTestId('tv-run-ended')).toBeVisible({ timeout: 90_000 });
  } finally {
    await nadia.close();
  }
});
