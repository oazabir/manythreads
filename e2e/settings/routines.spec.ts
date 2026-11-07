import { expect, test, type Page } from '@playwright/test';
import { PERSONAL_ROUTINE_STOP_WORDS } from '@manythreads/shared';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, apiOn, noSidewaysScroll, openOn } from '../support/stack-browser.ts';
import {
  addKeeper,
  brainReady,
  connectMail,
  listRoutines,
  makeDue,
  makeRoutine,
  messageOf,
  patchRoutine,
  personalText,
  postRoutine,
  routineBody,
  routineStackEnv,
  runsOf,
  setConsent,
  settledRun,
  stopMessagesFor,
  tick,
} from './routine-support.ts';

/*
 * Account > Routines (PLAN P20-10, P20-11, P20-14): a person's own routines. They are made from a sentence and shown as a plan first (nothing is saved or switched
 * on before the yes), can be paused, turned on, run now and deleted (after a confirm), and show the reason when the platform stopped one. The time zone and quiet
 * hours are the person's own and survive a reload. The limits (20 routines, a gap of 15 minutes) are refused with a sentence. Who may read what a routine reads
 * is in routines-privacy.spec.ts; what a run may do is in ../conversations/routine-run.spec.ts.
 *
 * One stack per project, in order: a fresh stack has no routines, and each test says what it leaves behind. A stack runs the stand-in Hermes, so "Run now" is a
 * real run through the real gateway.
 */
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let keeperId = '';
test.beforeAll(async ({ playwright }) => {
  stack = await startStack(routineStackEnv());
  const omar = await apiOn(playwright, stack, 'omar');
  const nadia = await apiOn(playwright, stack, 'nadia');
  try {
    // the workspace Brain is made by a job on a 15-minute cron that a fresh stack has not reached
    await brainReady(stack, nadia);
    keeperId = await addKeeper(stack, omar, [nadia]);
    const zone = await nadia.ctx.put('/api/me/routine-settings', { data: { timeZone: 'Asia/Dubai' }, headers: await nadia.headers() });
    expect(zone.status(), await zone.text()).toBe(200);
  } finally {
    await omar.ctx.dispose();
    await nadia.ctx.dispose();
  }
});
test.afterAll(async () => {
  await stack?.stop();
});

type Who = 'nadia' | 'rafi' | 'priya';
const open = (browser: Parameters<typeof openOn>[0], playwright: Parameters<typeof openOn>[1], isMobile: boolean, who: Who, path = '/account/routines') =>
  openOn(browser, playwright, stack, who, path, isMobile ? { viewport: PHONE, mobile: true } : {});

const rowNamed = (page: Page, name: string) => page.getByTestId('routine').filter({ has: page.getByTestId('routine-name-text').filter({ hasText: name }) });
const recipeCard = (page: Page, id: string) => page.locator(`[data-testid="routine-recipe"][data-recipe="${id}"]`);

test('a new person sees no routines, the ready ones to start from, and the limits in words', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await open(browser, playwright, isMobile, 'nadia');
  try {
    await expect(page.getByRole('heading', { level: 1, name: 'Your routines' })).toBeVisible();
    await expect(page.getByTestId('routines-none')).toContainText('You have no routines yet');
    await expect(page.getByTestId('routine')).toHaveCount(0);
    // the shelf: the six ready routines, each with a button that only opens a proposal
    await expect(page.getByTestId('routine-recipe')).toHaveCount(6);
    for (const id of ['mail-summary', 'action-items', 'meeting-prep', 'weekly-recap', 'catch-me-up', 'follow-ups']) await expect(recipeCard(page, id)).toBeVisible();
    await expect(page.getByTestId('routine-count')).toHaveText('0 of 20 routines.');
    await expect(page.getByTestId('routine-allowance')).toContainText('$0.00 of your $5.00 allowance used this month, $5.00 left.');
    await expect(page.getByTestId('routine-limits')).toHaveText('A routine runs at most once every 15 minutes and makes at most 40 tool calls in one run.');
    await expect(page.getByTestId('routine-to-action-items')).toHaveAttribute('href', '/account/action-items');
    if (isMobile) expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});

test('a routine made in words: a plan with notes first, nothing saved until the yes, then it is on', async ({ browser, playwright, isMobile }) => {
  const nadia = await apiOn(playwright, stack, 'nadia');
  const { page, context } = await open(browser, playwright, isMobile, 'nadia');
  try {
    await page.getByTestId('routine-new').click();
    await expect(page.getByTestId('dialog-new-routine')).toBeVisible();
    // too short a sentence asks for nothing
    await expect(page.getByTestId('routine-propose')).toBeDisabled();
    await page.getByTestId('routine-sentence').fill('Every weekday at 8:00 AM tell me which threads are waiting on me');
    await page.getByTestId('routine-propose').click();
    await expect(page.getByTestId('dialog-routine-plan')).toBeVisible();
    await expect(page.getByTestId('routine-said')).toContainText('You said: Every weekday at 8:00 AM tell me which threads are waiting on me');
    await expect(page.getByTestId('routine-when-words')).toContainText('8:00');
    await expect(page.getByTestId('routine-zone')).toHaveValue('Asia/Dubai');
    await expect(page.locator('[data-testid="routine-source"][data-source="threads"]')).toBeChecked();
    // a plan is not a routine: nothing is saved yet
    expect((await listRoutines(nadia)).items).toHaveLength(0);

    // back to the sentence: it is kept; with no time in it the plan says so in a note
    await page.getByTestId('routine-back').click();
    await expect(page.getByTestId('routine-sentence')).toHaveValue('Every weekday at 8:00 AM tell me which threads are waiting on me');
    await page.getByTestId('routine-sentence').fill('Summarise my threads for me');
    await page.getByTestId('routine-propose').click();
    await expect(page.getByTestId('routine-notes')).toContainText('I could not tell when it should run, so it is set to every day at 9:00 AM');
    expect((await listRoutines(nadia)).items).toHaveLength(0);

    await page.getByTestId('routine-name').fill('Thread watch');
    await page.getByTestId('routine-confirm').click();
    await expect(page.getByTestId('dialog-routine-plan')).toHaveCount(0);
    const row = rowNamed(page, 'Thread watch');
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('data-enabled', 'true');
    await expect(row.getByTestId('routine-state')).toHaveText('On');
    await expect(row.getByTestId('routine-schedule')).toContainText('9:00');
    await expect(row.getByTestId('routine-schedule')).toContainText('(Asia/Dubai)');
    await expect(page.getByTestId('routine-count')).toHaveText('1 of 20 routines.');

    const saved = (await listRoutines(nadia)).items;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: 'Thread watch', botSlug: 'brain', timeZone: 'Asia/Dubai', sources: ['threads'], enabled: true, stoppedReason: null });
    if (isMobile) expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
    await nadia.ctx.dispose();
  }
});

test('a ready routine from the shelf only opens the proposal; it is saved only on the yes', async ({ browser, playwright, isMobile }) => {
  const nadia = await apiOn(playwright, stack, 'nadia');
  const { page, context } = await open(browser, playwright, isMobile, 'nadia');
  try {
    const before = (await listRoutines(nadia)).items.length;
    // from the page: Set up opens the plan straight away, made by the recipe (not by the assistant)
    await recipeCard(page, 'weekly-recap').getByTestId('routine-recipe-use').click();
    await expect(page.getByTestId('dialog-routine-plan')).toBeVisible();
    await expect(page.getByTestId('routine-by-rules')).toHaveCount(0);
    await expect(page.getByTestId('routine-name')).not.toHaveValue('');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dialog-routine-plan')).toHaveCount(0);
    expect((await listRoutines(nadia)).items).toHaveLength(before);

    // from the dialog's own shelf
    await page.getByTestId('routine-new').click();
    await expect(page.getByTestId('routine-shelf-small').getByTestId('routine-pick')).toHaveCount(6);
    await page.locator('[data-testid="routine-pick"][data-recipe="catch-me-up"]').click();
    await expect(page.getByTestId('dialog-routine-plan')).toBeVisible();
    await page.keyboard.press('Escape');
    expect((await listRoutines(nadia)).items).toHaveLength(before);

    // the yes saves it, and remembers which ready routine it came from
    await recipeCard(page, 'weekly-recap').getByTestId('routine-recipe-use').click();
    const name = await page.getByTestId('routine-name').inputValue();
    await page.getByTestId('routine-confirm').click();
    await expect(rowNamed(page, name)).toHaveCount(1);
    const items = (await listRoutines(nadia)).items;
    expect(items).toHaveLength(before + 1);
    expect(items.find((r) => r.name === name)?.recipeId).toBe('weekly-recap');
  } finally {
    await context.close();
    await nadia.ctx.dispose();
  }
});

test('pause, turn on, run now and delete (after a confirm)', async ({ browser, playwright, isMobile }) => {
  const nadia = await apiOn(playwright, stack, 'nadia');
  const made = await makeRoutine(nadia, 'Note taker', { botSlug: 'keeper', prompt: 'Write me a short note. TAG-note' });
  const { page, context } = await open(browser, playwright, isMobile, 'nadia');
  try {
    const row = rowNamed(page, 'Note taker');
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('routine-state')).toHaveText('On');
    await expect(row.getByTestId('routine-last')).toContainText('It has not run yet.');

    await row.getByTestId('routine-pause').click();
    await expect(row).toHaveAttribute('data-enabled', 'false');
    await expect(row.getByTestId('routine-state')).toHaveText('Paused');
    await expect(row.getByTestId('routine-run-now')).toBeDisabled();
    expect((await listRoutines(nadia)).items.find((r) => r.id === made.id)?.enabled).toBe(false);

    await row.getByTestId('routine-turn-on').click();
    await expect(row).toHaveAttribute('data-enabled', 'true');
    await expect(row.getByTestId('routine-state')).toHaveText('On');

    // run now: a real run; the answer lands in the routine's output file
    await row.getByTestId('routine-run-now').click();
    await expect(page.getByTestId('routine-notice')).toContainText(`“Note taker” was asked to run. Its answer lands in ${made.outputPath}.`);
    await expect(row.getByTestId('routine-runs')).toBeVisible();
    const run = await settledRun(nadia, made.id);
    expect(run.status, run.reason).toBe('done');
    await expect.poll(() => personalText(nadia, made.outputPath), { timeout: 30_000 }).toContain('Routine note:');
    await row.getByTestId('routine-runs-refresh').click();
    await expect(row.getByTestId('routine-run').first()).toHaveAttribute('data-status', 'done');
    await expect(row.getByTestId('routine-run-status').first()).toHaveText('Finished');
    await expect(row.getByTestId('routine-run-sources').first()).toBeVisible();

    // delete asks first; Keep leaves it alone
    await row.getByTestId('routine-delete').click();
    await expect(row.getByTestId('routine-delete-yes')).toBeVisible();
    await row.getByTestId('routine-delete-no').click();
    await expect(row.getByTestId('routine-delete-yes')).toHaveCount(0);
    await expect(row).toHaveCount(1);
    expect((await listRoutines(nadia)).items.some((r) => r.id === made.id)).toBe(true);
    await row.getByTestId('routine-delete').click();
    await row.getByTestId('routine-delete-yes').click();
    await expect(rowNamed(page, 'Note taker')).toHaveCount(0);
    expect((await listRoutines(nadia)).items.some((r) => r.id === made.id)).toBe(false);
    // its folder goes with it, the report it wrote included
    expect(await personalText(nadia, made.outputPath)).toBeNull();
  } finally {
    await context.close();
    await nadia.ctx.dispose();
  }
});

test('a routine the platform stopped shows why, says so once in Reminders, and turns back on only when the reason is gone', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'the stop is made by the scheduler; the row is the same on a phone as on the desktop (the visual spec has its plate)');
  test.setTimeout(150_000); // five ticks (each a job and the job that tells owners, picked up within the worker's 5 s poll) and a reload
  const nadia = await apiOn(playwright, stack, 'nadia');
  const made = await makeRoutine(nadia, 'Watcher', { botSlug: 'keeper', prompt: 'Write me a short note.' });
  const { page, context } = await open(browser, playwright, false, 'nadia');
  try {
    const row = rowNamed(page, 'Watcher');
    await expect(row.getByTestId('routine-state')).toHaveText('On');

    // consent withdrawn: Nadia says no to the bot reading her Personal space; the next tick stops the routine
    await setConsent(nadia, keeperId, false);
    await makeDue(stack, made.id);
    await tick(stack);
    const stopped = (await listRoutines(nadia)).items.find((r) => r.id === made.id)!;
    expect(stopped).toMatchObject({ enabled: false, stoppedReason: 'consent_withdrawn' });
    await page.reload();
    await expect(row).toHaveAttribute('data-stopped', 'consent_withdrawn');
    await expect(row.getByTestId('routine-state')).toHaveText('Stopped');
    await expect(row.getByTestId('routine-stop-reason')).toHaveText(`This routine was turned off because ${PERSONAL_ROUTINE_STOP_WORDS.consent_withdrawn}.`);
    await expect(row.getByTestId('routine-turn-on')).toHaveText('Turn back on');
    await expect(row.getByTestId('routine-run-now')).toBeDisabled();
    // told once, in her Reminders
    await expect.poll(async () => (await stopMessagesFor(stack, 'Watcher')).length, { timeout: 30_000 }).toBe(1);
    await tick(stack);
    expect(await stopMessagesFor(stack, 'Watcher')).toHaveLength(1);

    // while the reason stands, turning it back on is refused in words
    await row.getByTestId('routine-turn-on').click();
    await expect(row.getByTestId('routine-error')).toContainText('cannot read your Personal space. Turn that on in Account, under Bots, and try again.');
    await expect(row.getByTestId('routine-state')).toHaveText('Stopped');

    // the reason gone: it turns back on and the stop is cleared
    await setConsent(nadia, keeperId, true);
    await row.getByTestId('routine-turn-on').click();
    await expect(row.getByTestId('routine-state')).toHaveText('On');
    await expect(row).toHaveAttribute('data-stopped', '');
    await expect(row.getByTestId('routine-stop-reason')).toHaveCount(0);

    // bot off: the bot is switched off for everyone
    await stack.sql(`UPDATE app.bots SET status = 'disabled' WHERE id = $1`, [keeperId]);
    try {
      await makeDue(stack, made.id);
      await tick(stack);
      expect((await listRoutines(nadia)).items.find((r) => r.id === made.id)).toMatchObject({ enabled: false, stoppedReason: 'bot_off' });
      const refused = await patchRoutine(nadia, made.id, { enabled: true });
      expect(refused.status()).toBe(409);
      expect(await messageOf(refused)).toMatch(/Keeper is turned off right now, so a routine cannot use it\.|The bot that runs this routine is no longer there/);
    } finally {
      await stack.sql(`UPDATE app.bots SET status = 'active' WHERE id = $1`, [keeperId]);
    }
    expect((await patchRoutine(nadia, made.id, { enabled: true })).status()).toBe(200);

    // a connection it reads from is gone: a routine that looks at mail stops when the mail connection is removed
    const disconnect = await connectMail(stack, 'nadia@kahf.example');
    const mailer = await makeRoutine(nadia, 'Mail watcher', { botSlug: 'keeper', sources: ['mail'] });
    await disconnect();
    await makeDue(stack, mailer.id);
    await tick(stack);
    expect((await listRoutines(nadia)).items.find((r) => r.id === mailer.id)).toMatchObject({ enabled: false, stoppedReason: 'connection_gone' });
    const needs = await patchRoutine(nadia, mailer.id, { enabled: true });
    expect(needs.status()).toBe(409);
    expect(await messageOf(needs)).toBe('Connect your mail first (Account, then Connections), or take it out of this routine.');
  } finally {
    await setConsent(nadia, keeperId, true);
    await stack.sql(`UPDATE app.bots SET status = 'active' WHERE id = $1`, [keeperId]);
    await context.close();
    await nadia.ctx.dispose();
  }
});

test('the time zone and quiet hours are the person’s own and survive a reload', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await open(browser, playwright, isMobile, 'rafi');
  try {
    const settings = page.getByTestId('routine-settings');
    await expect(settings).toBeVisible();
    await expect(page.getByTestId('routine-quiet-sentence')).toHaveText('No quiet hours: a routine runs when it is due.');
    // a time zone the browser does not know cannot be saved
    await page.getByTestId('routine-settings-zone').fill('Nowhere/City');
    await expect(page.getByTestId('routine-settings-save')).toBeDisabled();
    await page.getByTestId('routine-settings-zone').fill('Europe/Paris');
    await page.getByTestId('routine-quiet-on').check();
    await page.getByTestId('routine-quiet-from').fill('22:00');
    await page.getByTestId('routine-quiet-to').fill('07:00');
    await expect(page.getByTestId('routine-quiet-sentence')).toContainText('Nothing starts between 22:00 and 07:00.');
    await page.getByTestId('routine-settings-save').click();
    await expect(page.getByTestId('routine-settings-saved')).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('routine-settings-zone')).toHaveValue('Europe/Paris');
    await expect(page.getByTestId('routine-quiet-on')).toBeChecked();
    await expect(page.getByTestId('routine-quiet-from')).toHaveValue('22:00');
    await expect(page.getByTestId('routine-quiet-to')).toHaveValue('07:00');

    const rafi = await apiOn(playwright, stack, 'rafi');
    const nadia = await apiOn(playwright, stack, 'nadia');
    try {
      expect((await listRoutines(rafi)).settings).toEqual({ timeZone: 'Europe/Paris', quietHours: { from: '22:00', to: '07:00' } });
      // nobody else's: Nadia's own time zone is as she left it
      expect((await listRoutines(nadia)).settings).toEqual({ timeZone: 'Asia/Dubai', quietHours: null });
    } finally {
      await rafi.ctx.dispose();
      await nadia.ctx.dispose();
    }

    // and quiet hours can be turned off again
    await page.getByTestId('routine-quiet-on').uncheck();
    await page.getByTestId('routine-settings-save').click();
    await expect(page.getByTestId('routine-settings-saved')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('routine-quiet-on')).not.toBeChecked();
    await expect(page.getByTestId('routine-quiet-sentence')).toHaveText('No quiet hours: a routine runs when it is due.');
  } finally {
    await context.close();
  }
});

test('quiet hours hold a routine that is due: it does not start, and its next run moves to when they end', async ({ playwright, isMobile }) => {
  test.skip(isMobile, 'a server-side rule; no layout is under test');
  const rafi = await apiOn(playwright, stack, 'rafi');
  try {
    const hour = new Date().getUTCHours();
    const at = (h: number): string => `${String((h + 24) % 24).padStart(2, '0')}:00`;
    const set = await rafi.ctx.put('/api/me/routine-settings', { data: { timeZone: 'UTC', quietHours: { from: at(hour - 1), to: at(hour + 2) } }, headers: await rafi.headers() });
    expect(set.status(), await set.text()).toBe(200);
    const made = await makeRoutine(rafi, 'Quiet one', { timeZone: 'UTC' });
    await makeDue(stack, made.id);
    await tick(stack);
    const after = (await listRoutines(rafi)).items.find((r) => r.id === made.id)!;
    expect(await runsOf(rafi, made.id)).toHaveLength(0);
    expect(after.enabled).toBe(true);
    expect(after.stoppedReason).toBeNull();
    expect(new Date(after.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  } finally {
    await rafi.ctx.put('/api/me/routine-settings', { data: { quietHours: null }, headers: await rafi.headers() });
    await rafi.ctx.dispose();
  }
});

test('the limits are refused with a sentence: a schedule under 15 minutes, no yes, and the 21st routine', async ({ browser, playwright, isMobile }) => {
  const priya = await apiOn(playwright, stack, 'priya');
  try {
    // nothing is made without the person's yes
    const noYes = await postRoutine(priya, { ...routineBody('No yes'), confirmed: false });
    expect(noYes.status()).toBeGreaterThanOrEqual(400);
    expect(noYes.status()).toBeLessThan(500);
    expect((await listRoutines(priya)).items).toHaveLength(0);

    // a schedule that fires more often than every 15 minutes
    const fast = await postRoutine(priya, routineBody('Too often', { schedule: '*/5 * * * *', scheduleWords: 'Every 5 minutes' }));
    expect([400, 422]).toContain(fast.status());
    expect(await messageOf(fast)).toBe('A routine can run at most once every 15 minutes');
    expect((await listRoutines(priya)).items).toHaveLength(0);
    // the same through words: the plan rounds it up and says so
    const draft = await priya.ctx.post('/api/me/scheduled-jobs/draft', { data: { sentence: 'Every 5 minutes tell me what changed', timeZone: 'Asia/Dubai' }, headers: await priya.headers() });
    expect(draft.status()).toBe(200);
    const plan = (await draft.json()) as { draft: { scheduleWords: string }; notes: string[]; by: string };
    expect(plan.notes).toContain('A routine runs at most once every 15 minutes, so it is set to every hour.');
    expect(plan.draft.scheduleWords.toLowerCase()).toContain('every hour');
    // asking for a plan saved nothing
    expect((await listRoutines(priya)).items).toHaveLength(0);

    // 20 routines, then the 21st is turned away
    for (let n = 1; n <= 20; n += 1) await makeRoutine(priya, `Routine ${String(n)}`);
    const list = await listRoutines(priya);
    expect(list.items).toHaveLength(20);
    expect(list.limits).toMatchObject({ used: 20, maxRoutines: 20, minIntervalMinutes: 15 });
    const extra = await postRoutine(priya, routineBody('Routine 21'));
    expect(extra.status()).toBe(409);
    expect(await messageOf(extra)).toBe('You already have 20 routines; remove one to make room for another.');
    expect((await listRoutines(priya)).items).toHaveLength(20);
  } finally {
    await priya.ctx.dispose();
  }
  // the page agrees: the New routine buttons are off and the count says so
  const { page, context } = await open(browser, playwright, isMobile, 'priya');
  try {
    await expect(page.getByTestId('routine-count')).toHaveText('20 of 20 routines.');
    await expect(page.getByTestId('routine')).toHaveCount(20);
    await expect(page.getByTestId('routine-new')).toBeDisabled();
    await expect(recipeCard(page, 'weekly-recap').getByTestId('routine-recipe-use')).toBeDisabled();
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});
