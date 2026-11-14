import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import { apiOn, channelsOf, noSidewaysScroll, openOn, PHONE, postAs, type StackApi } from '../support/stack-browser.ts';
import { FAILS, JOURNEY, ORCHESTRATE, SLOW } from './scripts.ts';
import { cardText, startRunsWorld, type RunsWorld } from './support.ts';

/*
 * The run card and the to-do card, end to end (PLAN P25-11 and P25-12; docs/plans/acp.md section 5). The world is the `runs` stack (seed v25: the bots run-demo, run-lead and run-helper, on the
 * seeded Claude Code runner) with a real agent bridge in this process that starts tools/fake-acp-agent. What is real: the mention, the router, the run, the bridge's ACP driver, the kept record
 * (run_view and run_activity), the pushes, the approval of the agent's command, the failure notice, `tasks.todo`, the cards that tick an item, and the web client. What is a script: what the
 * agent does (e2e/runs/scripts.ts). Screenshots (light, dark, 390 px) go to temp/screenshots/p25-12, which is git-ignored.
 */
test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);
test.skip(({ isMobile }) => isMobile, 'the stack is driven once; the 390 px screenshots are taken inside the tests');

const SHOTS = join(import.meta.dirname, '..', '..', 'temp', 'screenshots', 'p25-12');
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

const threadPath = (rootId: string): string => `/t/engineering/c/dev?panel=thread:${rootId}`;

/** Nobody's run of this bot is still open (a mention that arrives while the last run is closing is a race of the test, not of the product). */
async function noOpenRun(slug: string): Promise<void> {
  await expect
    .poll(async () => (await world.stack.sql<{ n: string }>(`SELECT count(*)::text AS n FROM app.bot_runs r JOIN app.bots b ON b.id = r.bot_id WHERE b.slug = $1 AND r.ended_at IS NULL`, [slug]))[0]?.n, { timeout: 60_000, message: `the earlier run of ${slug} to end` })
    .toBe('0');
}

/** Nadia asks a bot, and her page shows the thread. */
async function ask(browser: Browser, playwright: PlaywrightWorkerArgs['playwright'], slug: string, text: string, who = 'nadia'): Promise<{ page: Page; rootId: string; close: () => Promise<void>; api: StackApi }> {
  await noOpenRun(slug);
  const api = await apiOn(playwright, world.stack, who);
  const root = await postAs(api, dev, `@${slug} ${text}`);
  const opened = await openOn(browser, playwright, world.stack, who, threadPath(root.id));
  return {
    page: opened.page,
    rootId: root.id,
    api,
    close: async () => {
      await opened.context.close();
      await api.ctx.dispose();
    },
  };
}

/** The same view three ways, for the gallery: light, dark and a 390 px phone. The page is left as it was. */
async function shoot(browser: Browser, playwright: PlaywrightWorkerArgs['playwright'], page: Page, rootId: string, name: string, who = 'nadia'): Promise<void> {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: join(SHOTS, `${name}.light.png`) });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: join(SHOTS, `${name}.dark.png`) });
  await page.emulateMedia({ colorScheme: 'light' });
  const phone = await openOn(browser, playwright, world.stack, who, threadPath(rootId), { viewport: PHONE, mobile: true });
  try {
    await expect(phone.page.locator('[data-testid="run-card"], [data-testid="run-end"], [data-testid="todo-card"], [data-testid="todo-pin"]').first()).toBeVisible({ timeout: 20_000 });
    expect(await noSidewaysScroll(phone.page), `${name}: nothing scrolls sideways at 390 px`).toBe(true);
    await phone.page.screenshot({ path: join(SHOTS, `${name}.390.png`) });
  } finally {
    await phone.context.close();
  }
}

test('working, a helper, a plan, a question, Yes, done and folded; the record is there after a reload', async ({ browser, playwright }) => {
  world.script(JOURNEY);
  const nadia = await ask(browser, playwright, 'run-demo', 'please change the thread panel');
  const omar = await openOn(browser, playwright, world.stack, 'omar', threadPath(nadia.rootId));
  try {
    const card = nadia.page.getByTestId('run-card');
    // it is working: who, in what state, what it does now, and the counts
    await expect(card, await cardText(nadia.page)).toBeVisible({ timeout: 60_000 });
    await expect(card.getByTestId('run-state')).toContainText(/Starting|Working/);
    await expect(card.getByTestId('run-now')).not.toBeEmpty();
    await expect(card.getByTestId('run-work')).toContainText(/\d+ steps?/, { timeout: 60_000 });
    // the plan, folded to its current item, and a helper among the counts
    await expect(card.getByTestId('run-plan-fold')).toContainText('Plan', { timeout: 60_000 });
    await expect(card.getByTestId('run-plan-fold')).toContainText('1 of 3');
    await expect(card.getByTestId('run-plan-fold')).toContainText('Write the change');
    await expect(card.getByTestId('run-work')).toContainText('1 helper');
    // the step list opens in place: same kind folds, the helper is its own row
    await card.getByTestId('run-work-fold').click();
    await expect(card.getByTestId('run-work-fold')).toHaveAttribute('aria-expanded', 'true');
    await expect(card.getByTestId('run-steps')).toContainText('Check the tests');
    await expect(card.getByTestId('run-steps')).toContainText('Read 4 files');
    await card.getByTestId('run-work-fold').click();

    // it asks to run a command: the question is in the card itself, and the card says who is expected to answer
    await expect(card.getByTestId('run-state')).toContainText('Waiting for', { timeout: 60_000 });
    await expect(card.getByTestId('run-questions')).toBeVisible();
    // a question is asked in one place: the strip under the replies does not repeat it
    await expect(nadia.page.getByTestId('thread-approvals')).toHaveCount(0);
    // each person's card says "for you" only when the server says that person may answer (the same flag decides the buttons)
    const mayAnswer = async (page: Page, api: StackApi): Promise<boolean> => {
      const list = await api.get<{ items: Array<{ canDecide: boolean; status: string }> }>(`/api/threads/${nadia.rootId}/approvals`);
      const can = list.items.some((a) => a.status === 'pending' && a.canDecide);
      const state = page.getByTestId('run-card').getByTestId('run-state');
      if (can) await expect(state).toContainText('Waiting for you', { timeout: 30_000 });
      else await expect(state).toContainText(/Waiting for (?!you)/, { timeout: 30_000 });
      await expect(page.getByTestId('run-card').getByTestId('approval-approve')).toHaveCount(can ? 1 : 0);
      return can;
    };
    const omarApi = await apiOn(playwright, world.stack, 'omar');
    try {
      expect(await mayAnswer(nadia.page, nadia.api)).toBe(true);
      await mayAnswer(omar.page, omarApi);
    } finally {
      await omarApi.ctx.dispose();
    }
    await shoot(browser, playwright, nadia.page, nadia.rootId, 'waiting');
    await omar.page.screenshot({ path: join(SHOTS, 'waiting-other-viewer.light.png') });

    // she says Yes, in the card
    await card.getByTestId('approval-approve').click();

    // it finishes: the card folds into one line under the answer
    const end = nadia.page.getByTestId('run-end');
    await expect(end, await cardText(nadia.page)).toBeVisible({ timeout: 60_000 });
    await expect(nadia.page.getByTestId('run-card')).toHaveCount(0);
    await expect(end).toContainText(/Worked .*\d+ steps?/);
    await expect(end).toContainText('1 helper');
    await expect(nadia.page.getByText('All done.')).toBeVisible();
    await shoot(browser, playwright, nadia.page, nadia.rootId, 'folded');

    // the line opens the record
    await end.getByTestId('run-end-fold').click();
    await expect(end.getByTestId('run-steps')).toContainText('Check the tests');
    await shoot(browser, playwright, nadia.page, nadia.rootId, 'record');

    // after a reload the record is still there, read from the server
    const text = await end.innerText();
    await nadia.page.reload();
    await expect(nadia.page.getByTestId('run-end')).toBeVisible({ timeout: 30_000 });
    expect((await nadia.page.getByTestId('run-end').innerText()).split('\n')[0]).toBe(text.split('\n')[0]);
    await nadia.page.getByTestId('run-end-fold').click();
    await expect(nadia.page.getByTestId('run-steps')).toContainText('Check the tests');
  } finally {
    await omar.context.close();
    await nadia.close();
  }
});

test('Stop: one press, it says Stopping, and the line under the thread says who stopped it', async ({ browser, playwright }) => {
  world.script(SLOW);
  const nadia = await ask(browser, playwright, 'run-demo', 'run the whole test suite');
  try {
    const card = nadia.page.getByTestId('run-card');
    await expect(card.getByTestId('run-now')).toContainText(/command/i, { timeout: 60_000 });
    await shoot(browser, playwright, nadia.page, nadia.rootId, 'working');
    await card.getByTestId('run-stop').click();
    await expect(nadia.page.getByTestId('run-end')).toContainText(/Stopped by .+ after/, { timeout: 60_000 });
    await expect(nadia.page.getByTestId('run-card')).toHaveCount(0);
    await shoot(browser, playwright, nadia.page, nadia.rootId, 'stopped');
    // the record says the same after a reload
    await nadia.page.reload();
    await expect(nadia.page.getByTestId('run-end')).toContainText(/Stopped by .+ after/, { timeout: 30_000 });
  } finally {
    await nadia.close();
  }
});

test('a run that fails says so in plain words, and says who can fix it', async ({ browser, playwright }) => {
  world.script(FAILS);
  const nadia = await ask(browser, playwright, 'run-demo', 'try the failing one');
  try {
    const end = nadia.page.getByTestId('run-end');
    await expect(end, await cardText(nadia.page)).toBeVisible({ timeout: 90_000 });
    await expect(end).toContainText(/Failed after/);
    await expect(end).toHaveAttribute('data-tone', 'failed');
    // the cause is one sentence of the bot's own, in the thread, with the run's id on it; the card does not say it twice
    const notices = await world.stack.sql<{ body: string }>(`SELECT body FROM app.messages WHERE thread_root_id = $1 AND meta ? 'runFailure'`, [nadia.rootId]);
    if (notices.length > 0) {
      await expect(nadia.page.getByText(notices[0]!.body.slice(0, 40), { exact: false }).first()).toBeVisible();
      await expect(end.getByTestId('run-who')).toHaveCount(0);
    } else {
      await expect(end.getByTestId('run-who')).toContainText('tell a workspace admin');
    }
    await shoot(browser, playwright, nadia.page, nadia.rootId, 'failed');
  } finally {
    await nadia.close();
  }
});

test('the to-do card: kept by the orchestrator, an item follows its card, and it ticks as the card is done', async ({ browser, playwright }) => {
  world.script(ORCHESTRATE);
  const lead = await world.bot('run-lead');
  const helper = await world.bot('run-helper');
  const nadia = await ask(browser, playwright, 'run-lead', 'build the run card and test it');
  const omar = await apiOn(playwright, world.stack, 'omar');
  try {
    // the orchestrator's run is open (its step is slow), and a card waits for the helper
    await expect(nadia.page.getByTestId('run-card')).toBeVisible({ timeout: 60_000 });
    const made = await nadia.api.post<{ task: { id: string } }>('/api/teams/engineering/tasks', { title: 'Build the run card', branch: `e2e/run-card-${Date.now()}` });
    const cardId = made.task.id;
    const notes = await nadia.api.post<{ task: { id: string } }>('/api/teams/engineering/tasks', { title: 'Write the notes', branch: `e2e/run-notes-${Date.now()}` });
    const notesId = notes.task.id;

    // the orchestrator writes its list through its own tool endpoint, with the bot's one token, which belongs to its open run
    const minted = await omar.post<{ token: string }>('/api/teams/engineering/bots/run-lead/pairing-tokens', {});
    const call = await fetch(`${world.stack.origin}/api/mcp/bots/${lead.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${minted.token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'tasks.todo',
          arguments: {
            action: 'set',
            title: 'Run card',
            items: [
              { id: 'plan', text: 'Plan the parts', status: 'done' },
              { id: 'build', text: 'Build the run card', status: 'waiting', taskId: cardId },
              { id: 'docs', text: 'Write the notes', status: 'waiting', taskId: notesId },
              { id: 'ship', text: 'Tell the team', status: 'waiting' },
            ],
          },
        },
      }),
    });
    const answer = (await call.json()) as { result?: { isError?: boolean; content: Array<{ text: string }> } };
    expect(answer.result?.isError, JSON.stringify(answer)).not.toBe(true);

    // the list is a card in the thread, and one line stays at the top of the panel while anything is open
    const card = nadia.page.getByTestId('todo-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId('todo-progress')).toHaveText('1 of 4');
    await expect(card.getByTestId('todo-item')).toHaveCount(4);
    const pin = nadia.page.getByTestId('todo-pin');
    await expect(pin).toBeVisible();
    await expect(pin).toContainText('1 of 4');
    // the orchestrator's own plan is not drawn twice
    await expect(nadia.page.getByTestId('run-plan-fold')).toHaveCount(0);
    await shoot(browser, playwright, nadia.page, nadia.rootId, 'todo-open');

    // the card is handed to the helper: the item is being worked on, with the helper as its owner
    await nadia.api.post(`/api/teams/engineering/tasks/${cardId}/claim`, {});
    await nadia.api.post(`/api/teams/engineering/tasks/${cardId}/handoff`, { toActorId: helper.actorId, mode: 'bot', note: 'build it' });
    await expect(card.getByTestId('todo-item').nth(1)).toHaveAttribute('data-status', 'working', { timeout: 30_000 });
    await expect(card.getByTestId('todo-item').nth(1).getByRole('link')).toHaveAttribute('href', new RegExp(`/boards\\?.*card=${cardId}`));
    await shoot(browser, playwright, nadia.page, nadia.rootId, 'todo-working');

    // the other card is claimed and finished by a person: its item ticks by itself
    await nadia.api.post(`/api/teams/engineering/tasks/${notesId}/claim`, {});
    await nadia.api.post(`/api/teams/engineering/tasks/${notesId}/complete`, { testedSha: 'abcdef1' });
    await expect(card.getByTestId('todo-item').nth(2)).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
    await expect(card.getByTestId('todo-progress')).toHaveText('2 of 4');

    // the orchestrator ticks the rest through its own tool: the list says All done and the line at the top goes away
    for (const [n, id] of [[2, 'build'], [3, 'ship']] as const) {
      const tick = await fetch(`${world.stack.origin}/api/mcp/bots/${lead.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${minted.token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name: 'tasks.todo', arguments: { action: 'update', id, status: 'done' } } }),
      });
      expect(JSON.stringify(await tick.json()), `ticking ${id}`).not.toContain('"isError":true');
    }
    await expect(card.getByTestId('todo-progress')).toHaveText('All done', { timeout: 30_000 });
    await expect(nadia.page.getByTestId('todo-pin')).toHaveCount(0);
    await shoot(browser, playwright, nadia.page, nadia.rootId, 'todo-done');

    // after a reload the list is the same
    await nadia.page.reload();
    await expect(nadia.page.getByTestId('todo-card').getByTestId('todo-progress')).toHaveText('All done', { timeout: 30_000 });

    // while the run is going, the channel shows who is on the thread
    const channel = await openOn(browser, playwright, world.stack, 'nadia', '/t/engineering/c/dev');
    try {
      await expect(channel.page.getByTestId('run-chip').first()).toContainText('is working', { timeout: 30_000 });
      await channel.page.screenshot({ path: join(SHOTS, 'channel-chip.light.png') });
    } finally {
      await channel.context.close();
    }
  } finally {
    await omar.ctx.dispose();
    await nadia.close();
  }
});
