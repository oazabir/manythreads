import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, apiOn, openOn } from '../support/stack-browser.ts';
import { brainReady, listRoutines, makeRoutine, patchRoutine, personalText, routineBody, routineStackEnv, runRoutine, runsOf, type RoutineJson } from './routine-support.ts';

/*
 * Whose routines are whose (PLAN P20-10, P20-14, D10): a person's routines, their runs, their action items and the files they write are theirs alone. Another member
 * cannot list, change, run, read the runs of or delete them (a routine of another person is "no such routine", 404), a workspace admin has no wider reach, and a guest
 * has no Personal space so every routine and action-items route is a 403 for them and the pages show no way in. The monthly allowance is the workspace's: everybody may
 * read it and only an owner or admin sets it. Route rules, so one project is enough for the API tests; the guest pages are read on both.
 */
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let nadiaRoutine: RoutineJson;
test.beforeAll(async ({ playwright }) => {
  stack = await startStack(routineStackEnv());
  const nadia = await apiOn(playwright, stack, 'nadia');
  try {
    await brainReady(stack, nadia);
    nadiaRoutine = await makeRoutine(nadia, 'Private routine');
  } finally {
    await nadia.ctx.dispose();
  }
});
test.afterAll(async () => {
  await stack?.stop();
});

test('another member cannot list, change, run, read the runs of or delete a routine that is not theirs', async ({ playwright, isMobile }) => {
  test.skip(isMobile, 'a server-side rule; no layout is under test');
  const rafi = await apiOn(playwright, stack, 'rafi');
  try {
    expect((await listRoutines(rafi)).items).toHaveLength(0);
    const id = nadiaRoutine.id;
    expect((await patchRoutine(rafi, id, { enabled: false })).status()).toBe(404);
    expect((await patchRoutine(rafi, id, { name: 'Mine now' })).status()).toBe(404);
    expect((await runRoutine(rafi, id)).status()).toBe(404);
    expect((await rafi.ctx.get(`/api/me/scheduled-jobs/${id}/runs`)).status()).toBe(404);
    expect((await rafi.ctx.delete(`/api/me/scheduled-jobs/${id}`, { headers: await rafi.headers() })).status()).toBe(404);
    // her routine's file is in her Personal space, not in his
    expect(await personalText(rafi, nadiaRoutine.contractPath)).toBeNull();
  } finally {
    await rafi.ctx.dispose();
  }
  // nothing happened to it
  const nadia = await apiOn(playwright, stack, 'nadia');
  try {
    const mine = (await listRoutines(nadia)).items.find((r) => r.id === nadiaRoutine.id);
    expect(mine).toMatchObject({ name: 'Private routine', enabled: true });
    expect(await runsOf(nadia, nadiaRoutine.id)).toHaveLength(0);
    expect(await personalText(nadia, nadiaRoutine.contractPath)).toContain('Private routine');
  } finally {
    await nadia.ctx.dispose();
  }
});

test('an admin cannot read or change another person’s routines either', async ({ playwright, browser, isMobile }) => {
  test.skip(isMobile, 'a server-side rule; no layout is under test');
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    expect((await listRoutines(omar)).items).toHaveLength(0);
    expect((await patchRoutine(omar, nadiaRoutine.id, { enabled: false })).status()).toBe(404);
    expect((await runRoutine(omar, nadiaRoutine.id)).status()).toBe(404);
    expect((await omar.ctx.get(`/api/me/scheduled-jobs/${nadiaRoutine.id}/runs`)).status()).toBe(404);
    expect((await omar.ctx.delete(`/api/me/scheduled-jobs/${nadiaRoutine.id}`, { headers: await omar.headers() })).status()).toBe(404);
    expect(await personalText(omar, nadiaRoutine.contractPath)).toBeNull();
  } finally {
    await omar.ctx.dispose();
  }
  // and the page shows an admin only their own
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/account/routines');
  try {
    await expect(page.getByTestId('routines-none')).toBeVisible();
    await expect(page.getByTestId('routine')).toHaveCount(0);
    await expect(page.getByText('Private routine')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('without a session every routine and action-items route is a 401', async ({ playwright, isMobile }) => {
  test.skip(isMobile, 'a server-side rule; no layout is under test');
  const anon = await playwright.request.newContext({ baseURL: stack.origin });
  try {
    for (const path of ['/api/me/scheduled-jobs', `/api/me/scheduled-jobs/${nadiaRoutine.id}/runs`, '/api/me/action-items', '/api/workspace/routine-settings']) {
      expect((await anon.get(path)).status(), path).toBe(401);
    }
  } finally {
    await anon.dispose();
  }
});

test('a guest gets 403 from every routine and action-items route', async ({ playwright, isMobile }) => {
  test.skip(isMobile, 'a server-side rule; no layout is under test');
  const lena = await apiOn(playwright, stack, 'lena');
  try {
    const h = await lena.headers();
    const id = nadiaRoutine.id;
    const answers: Array<[string, number]> = [
      ['list', (await lena.ctx.get('/api/me/scheduled-jobs')).status()],
      ['create', (await lena.ctx.post('/api/me/scheduled-jobs', { data: routineBody('Guest routine'), headers: h })).status()],
      ['draft', (await lena.ctx.post('/api/me/scheduled-jobs/draft', { data: { sentence: 'Every day at 9 tell me the news', timeZone: 'Asia/Dubai' }, headers: h })).status()],
      ['patch', (await lena.ctx.patch(`/api/me/scheduled-jobs/${id}`, { data: { enabled: false }, headers: h })).status()],
      ['run', (await lena.ctx.post(`/api/me/scheduled-jobs/${id}/run`, { headers: h })).status()],
      ['runs', (await lena.ctx.get(`/api/me/scheduled-jobs/${id}/runs`)).status()],
      ['delete', (await lena.ctx.delete(`/api/me/scheduled-jobs/${id}`, { headers: h })).status()],
      ['settings', (await lena.ctx.put('/api/me/routine-settings', { data: { timeZone: 'Asia/Dubai' }, headers: h })).status()],
      ['action items', (await lena.ctx.get('/api/me/action-items')).status()],
      ['add an action item', (await lena.ctx.patch('/api/me/action-items', { data: { revision: null, change: { op: 'add', what: 'Guest item' } }, headers: h })).status()],
    ];
    for (const [what, status] of answers) expect(status, what).toBe(403);
  } finally {
    await lena.ctx.dispose();
  }
});

test('a guest sees no way in and the pages say they are not available', async ({ browser, playwright, isMobile }) => {
  for (const path of ['/account/routines', '/account/action-items']) {
    const { page, context } = await openOn(browser, playwright, stack, 'lena', path, isMobile ? { viewport: PHONE, mobile: true } : {});
    try {
      await expect(page.getByRole('heading', { level: 1, name: 'You do not have access' })).toBeVisible();
      await expect(page.getByTestId('routine-new')).toHaveCount(0);
      await expect(page.getByTestId('action-item-add')).toHaveCount(0);
      if (isMobile) {
        const options = await page.locator('#settings-section option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).label));
        expect(options).not.toContain('Routines');
        expect(options).not.toContain('Action items');
      } else {
        const nav = page.getByRole('navigation', { name: 'Settings' });
        await expect(nav.getByRole('link', { name: 'Profile', exact: true })).toBeVisible();
        await expect(nav.getByRole('link', { name: 'Routines', exact: true })).toHaveCount(0);
        await expect(nav.getByRole('link', { name: 'Action items', exact: true })).toHaveCount(0);
      }
    } finally {
      await context.close();
    }
  }
});

test('the monthly allowance is the workspace’s: everybody reads it, only an owner or admin sets it', async ({ playwright, isMobile }) => {
  test.skip(isMobile, 'a server-side rule; no layout is under test');
  const nadia = await apiOn(playwright, stack, 'nadia');
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    // the default is $5 a person
    expect(await nadia.get('/api/workspace/routine-settings')).toEqual({ monthlyCapUsd: 5 });
    expect((await listRoutines(nadia)).limits.monthlyCapUsd).toBe(5);

    // a member cannot change it, and it stays as it was
    const refused = await nadia.ctx.put('/api/workspace/routine-settings', { data: { monthlyCapUsd: 500 }, headers: await nadia.headers() });
    expect(refused.status()).toBe(403);
    expect(await nadia.get('/api/workspace/routine-settings')).toEqual({ monthlyCapUsd: 5 });

    try {
      const set = await omar.ctx.put('/api/workspace/routine-settings', { data: { monthlyCapUsd: 12.5 }, headers: await omar.headers() });
      expect(set.status(), await set.text()).toBe(200);
      expect(await nadia.get('/api/workspace/routine-settings')).toEqual({ monthlyCapUsd: 12.5 });
      // and it is what each person's page reads
      expect((await listRoutines(nadia)).limits.monthlyCapUsd).toBe(12.5);
      // nonsense is refused
      for (const bad of [-1, 10_001]) {
        const res = await omar.ctx.put('/api/workspace/routine-settings', { data: { monthlyCapUsd: bad }, headers: await omar.headers() });
        expect(res.status(), `a cap of ${String(bad)}`).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
      }
      expect(await omar.get('/api/workspace/routine-settings')).toEqual({ monthlyCapUsd: 12.5 });
    } finally {
      await omar.ctx.put('/api/workspace/routine-settings', { data: { monthlyCapUsd: 5 }, headers: await omar.headers() });
    }
    expect(await nadia.get('/api/workspace/routine-settings')).toEqual({ monthlyCapUsd: 5 });
  } finally {
    await nadia.ctx.dispose();
    await omar.ctx.dispose();
  }
});

test('a routine that is not found for the person is not found for a made-up id either', async ({ playwright, isMobile }) => {
  test.skip(isMobile, 'a server-side rule; no layout is under test');
  const nadia = await apiOn(playwright, stack, 'nadia');
  try {
    const ghost = randomUUID();
    expect((await patchRoutine(nadia, ghost, { enabled: false })).status()).toBe(404);
    expect((await runRoutine(nadia, ghost)).status()).toBe(404);
  } finally {
    await nadia.ctx.dispose();
  }
});
