import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { apiOn } from '../../support/stack-browser.ts';
import { brainReady, listRoutines, makeDue, makeRoutine, patchRoutine, routineStackEnv, setConsent, tick } from '../../settings/routine-support.ts';
import { DESKTOP, MOBILE, expectWireframe, openPage } from '../support/vt.ts';

/*
 * Account > Routines (PLAN P20-11; own baselines, class W, 1440x900 and 390x844). Baselines are made by the runner on first run and are not committed with this spec.
 *   routines-empty.png / -390          no routines yet: the page, the ready routines to start from (Rafi)
 *   routines-rows.png / -390           three routines: On, Paused and Stopped (consent withdrawn), with the reason under the stopped one (Nadia)
 *   routines-time-limits.png / -390    the page with the Time and limits block (the sidebar stays at the top: the page is not scrolled for the plate): time zone, quiet hours, count and allowance (Nadia)
 *   routine-new-sentence.png / -390    New routine, step one: the sentence and the ready ones
 *   routine-new-plan.png / -390        New routine, step two: the plan the person reads before the yes
 * Times of runs (<time>) carry data-vt-mask. The clock is the real one: the schedule words and the zone are fixed, the date text is masked.
 */
const PAGE = [['page-header'], ['title']];
const DESK = [['nav', 'content'], ...PAGE];
const PHONE_ORDER = [['nav-select', 'content'], ...PAGE];

let stack: Stack;
test.skip(({ isMobile }) => isMobile, 'desktop project: the viewport is set by the spec');
test.beforeAll(async ({ playwright }) => {
  stack = await startStack(routineStackEnv());
  const nadia = await apiOn(playwright, stack, 'nadia');
  const rafi = await apiOn(playwright, stack, 'rafi');
  try {
    const brainId = await brainReady(stack, nadia);
    for (const api of [nadia, rafi]) {
      const res = await api.ctx.put('/api/me/routine-settings', { data: { timeZone: 'Asia/Dubai', ...(api === nadia ? { quietHours: { from: '22:00', to: '07:00' } } : {}) }, headers: await api.headers() });
      expect(res.status(), await res.text()).toBe(200);
    }
    await makeRoutine(nadia, 'Morning mail', { words: 'Every weekday at 9 AM tell me which threads are waiting on me', sources: ['threads'] });
    const paused = await makeRoutine(nadia, 'Weekly recap', { schedule: '0 14 * * 5', scheduleWords: 'Fridays at 6:00 PM', sources: ['cards', 'mentions'] });
    expect((await patchRoutine(nadia, paused.id, { enabled: false })).status()).toBe(200);
    const stopped = await makeRoutine(nadia, 'Catch me up', { schedule: '0 4 * * *', scheduleWords: 'Every day at 8:00 AM', sources: ['mentions'] });
    // the platform stops it: the person said no to the bot reading their Personal space, and the next tick notices
    await setConsent(nadia, brainId, false);
    try {
      await makeDue(stack, stopped.id);
      await tick(stack);
    } finally {
      await setConsent(nadia, brainId, true);
    }
    expect((await listRoutines(nadia)).items.find((r) => r.id === stopped.id)?.stoppedReason).toBe('consent_withdrawn');
  } finally {
    await nadia.ctx.dispose();
    await rafi.ctx.dispose();
  }
});
test.afterAll(async () => {
  await stack?.stop();
});

for (const [suffix, viewport, mobile] of [
  ['', DESKTOP, false],
  ['-390', MOBILE, true],
] as const) {
  const order = mobile ? PHONE_ORDER : DESK;

  test(`Routines with none keeps its layout${suffix || ' at 1440'} (W)`, async ({ browser }) => {
    const { page, close } = await openPage(browser, stack, 'rafi', viewport, mobile);
    try {
      await page.goto('/account/routines');
      await expect(page.getByTestId('routines-none')).toBeVisible();
      await expect(page.getByTestId('routine-recipe')).toHaveCount(6);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await expectWireframe(page, `routines-empty${suffix}`, order);
    } finally {
      await close();
    }
  });

  test(`Routines with an On, a Paused and a Stopped routine keeps its layout${suffix || ' at 1440'} (W)`, async ({ browser }) => {
    const { page, close } = await openPage(browser, stack, 'nadia', viewport, mobile);
    try {
      await page.goto('/account/routines');
      await expect(page.getByTestId('routine')).toHaveCount(3);
      const state = (name: string) => page.getByTestId('routine').filter({ hasText: name }).getByTestId('routine-state');
      await expect(state('Morning mail')).toHaveText('On');
      await expect(state('Weekly recap')).toHaveText('Paused');
      await expect(state('Catch me up')).toHaveText('Stopped');
      await expect(page.getByTestId('routine-stop-reason')).toHaveCount(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await expectWireframe(page, `routines-rows${suffix}`, order);
    } finally {
      await close();
    }
  });

  test(`Routines, Time and limits keeps its layout${suffix || ' at 1440'} (W)`, async ({ browser }) => {
    const { page, close } = await openPage(browser, stack, 'nadia', viewport, mobile);
    try {
      await page.goto('/account/routines');
      await expect(page.getByTestId('routine-settings')).toBeVisible();
      await expect(page.getByTestId('routine-quiet-from')).toHaveValue('22:00');
      await expect(page.getByTestId('routine-count')).toHaveText('3 of 20 routines.');
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await expectWireframe(page, `routines-time-limits${suffix}`, order);
    } finally {
      await close();
    }
  });

  test(`New routine, both steps keep their layout${suffix || ' at 1440'} (W)`, async ({ browser }) => {
    const { page, close } = await openPage(browser, stack, 'rafi', viewport, mobile);
    try {
      await page.goto('/account/routines');
      await page.getByTestId('routine-new').click();
      await expect(page.getByTestId('dialog-new-routine')).toBeVisible();
      await page.getByTestId('routine-sentence').fill('Every weekday at 8:00 AM tell me which threads are waiting on me');
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await expectWireframe(page, `routine-new-sentence${suffix}`, mobile ? [['content']] : [['nav', 'content']]);

      await page.getByTestId('routine-propose').click();
      await expect(page.getByTestId('dialog-routine-plan')).toBeVisible();
      await expect(page.getByTestId('routine-when-words')).toContainText('8:00');
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await expectWireframe(page, `routine-new-plan${suffix}`, mobile ? [['content']] : [['nav', 'content']]);
    } finally {
      await close();
    }
  });
}
