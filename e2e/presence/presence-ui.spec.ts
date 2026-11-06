import { expect, test, type Locator, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, apiOn, noSidewaysScroll, openOn, postAs, type StackApi } from '../support/stack-browser.ts';

/**
 * Presence in the screens (PLAN P14-01, docs/plugins/presence.md): the dot beside a name, the profile card and the out-of-office form.
 *
 * Nadia looks. Rafi has a heartbeat (sent through the API: nothing else beats on this stack), a status with an emoji, a time zone (Karachi, UTC+5,
 * one hour ahead of Nadia's Dubai) and working hours. Priya never beat, so she is Offline. A bot (Coder) posts in the channel too and gets no dot.
 * Lena, a guest, reads #releases and sees no dot beside anybody. The spec starts its own stack (presence is per person and global).
 *
 * The clock cannot be moved here (the card works out "their time" from the browser's clock every 30 s and the repo has no fake-clock helper), so the
 * local time is compared with the clock of the zone read by this process, within two minutes, and the working-hours verdict is computed the same way.
 * The end of an out-of-office note by time is covered by the shared clock rules' unit tests. The phone has its own tests at the end (mobile-web).
 */
test.use({ actionTimeout: 10_000 });
test.describe.configure({ mode: 'serial' });

const T = { timeout: 15_000 };
let stack: Stack;
let nadia: StackApi;
let rafi: StackApi;
let omar: StackApi;
let priya: StackApi;
let lena: StackApi;
let ids = { nadia: '', rafi: '', omar: '', priya: '' };
let chan = { id: '', name: '' };

const HOURS = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' };
const LUNCH = { emoji: '🍽️', text: 'Lunch', clearsAt: null };

type Me = {
  status: { emoji: string | null; text: string; clearsAt: string | null } | null;
  outOfOffice: { active: boolean; returnsOn: string | null; delegatePersonId: string | null; message: string } | null;
  timeZone: string | null;
};
const meOf = (api: StackApi): Promise<Me> => api.get<Me>('/api/presence/me');

async function patchMe(api: StackApi, body: unknown): Promise<void> {
  const res = await api.ctx.patch('/api/presence/me', { data: body, headers: await api.headers() });
  expect(res.status(), `PATCH /api/presence/me ${JSON.stringify(body)}: ${await res.text()}`).toBe(200);
}
/** A heartbeat as the person (the server keeps one for 90 s, so each test sends its own first). */
const beat = (api: StackApi, status: 'online' | 'away' = 'online'): Promise<unknown> => api.post('/api/presence', { status });

/** Clock facts of a zone at this moment, read here with Intl (the test's own reading, independent of the client's code). */
function zoneNow(zone: string, at = new Date()): { minutes: number; weekday: number; clock: string } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  return { minutes, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')), clock: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` };
}
const minutesOfClock = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
/** Distance between two times of day on a 24 hour circle. */
const apart = (a: number, b: number): number => Math.min(Math.abs(a - b), 1440 - Math.abs(a - b));
/** `YYYY-MM-DD` of the calendar day `plus` days from today in `zone`. */
function dayIn(zone: string, plus: number): { iso: string; day: number; mon: string } {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + plus));
  return { iso: t.toISOString().slice(0, 10), day: t.getUTCDate(), mon: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][t.getUTCMonth()]! };
}

test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'work' });
  [omar, nadia, rafi, priya, lena] = await Promise.all(['omar', 'nadia', 'rafi', 'priya', 'lena'].map((who) => apiOn(playwright, stack, who))) as [StackApi, StackApi, StackApi, StackApi, StackApi];
  const idOf = async (api: StackApi): Promise<string> => (await api.get<{ person: { id: string } }>('/api/session')).person.id;
  ids = { nadia: await idOf(nadia), rafi: await idOf(rafi), omar: await idOf(omar), priya: await idOf(priya) };

  const name = 'presence-ui';
  chan = { id: (await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name })).channel.id, name };

  // Rafi: a status with an emoji, Karachi time and working hours. Nadia: Dubai time (neither zone has daylight saving, so "one hour ahead" holds all year).
  await patchMe(rafi, { status: LUNCH, timeZone: 'Asia/Karachi', workingHours: HOURS });
  await patchMe(nadia, { timeZone: 'Asia/Dubai' });
  // Omar: words only, no picture
  await patchMe(omar, { status: { emoji: null, text: 'Heads down', clearsAt: null } });

  await postAs(rafi, chan.id, 'Rafi writes: the runbook is updated.');
  await postAs(priya, chan.id, 'Priya writes: the checklist is done.');
  await postAs(omar, chan.id, 'Omar writes: thanks both.');
  // the bot's message goes in straight (a bot posts through the runtime; the row is the same)
  const bot = (await stack.sql<{ id: string; workspace_id: string }>(`SELECT a.id, a.workspace_id FROM app.actors a JOIN app.bots b ON a.kind = 'bot' AND a.ref_id = b.id WHERE b.slug = 'coder'`))[0];
  expect(bot, 'the seeded coder bot').toBeTruthy();
  await stack.sql(`INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain) VALUES ($1, $2, $3, $4, $4)`, [bot!.workspace_id, chan.id, bot!.id, 'Coder writes: the build is green.']);

  // Nadia has a conversation with Rafi, one with Priya and one with both of them
  await nadia.post('/api/dms', { personIds: [ids.rafi] });
  await nadia.post('/api/dms', { personIds: [ids.priya] });
  await nadia.post('/api/dms', { personIds: [ids.rafi, ids.priya] });
});
test.afterAll(async () => {
  await Promise.all([omar?.ctx.dispose(), nadia?.ctx.dispose(), rafi?.ctx.dispose(), priya?.ctx.dispose(), lena?.ctx.dispose()]);
  await stack?.stop();
});

const row = (page: Page, text: string): Locator => page.locator('[data-testid="message"]').filter({ hasText: text });
const dotOf = (scope: Locator | Page): Locator => scope.getByTestId('presence-dot');
const fill = (dot: Locator): Promise<string> => dot.locator('.pdot').evaluate((el) => getComputedStyle(el).backgroundColor);
const TRANSPARENT = /^(rgba\(0, 0, 0, 0\)|transparent)$/;

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'the desktop layout; the phone has its own tests below');

  test('a person with a heartbeat is Active on the corner of the avatar (P21-01), the status said in words and no longer drawn as an emoji; a person who never beat has the Offline ring; a bot has no dot', async ({ browser, playwright }) => {
    await beat(rafi);
    await beat(omar);
    const { page, context } = await openOn(browser, playwright, stack, 'nadia', `/t/engineering/c/${chan.name}`);
    try {
      for (const who of ['Rafi writes', 'Priya writes', 'Omar writes', 'Coder writes']) await expect(row(page, who)).toBeVisible(T);

      // Rafi: Active (a filled dot), named in words, with his status in the words (the picture of the status is not drawn on a message row any more)
      const rafiDot = dotOf(row(page, 'Rafi writes').locator('.av-wrap'));
      await expect(rafiDot).toHaveCount(1, T);
      await expect(rafiDot).toHaveAttribute('data-presence', 'online');
      await expect(rafiDot).toHaveAccessibleName(/^Active, .*Lunch/);
      await expect(rafiDot).toHaveAttribute('title', /^Active, .*Lunch/);
      await expect(rafiDot.locator('.pdot-emoji')).toHaveCount(0);
      expect(await fill(rafiDot)).not.toMatch(TRANSPARENT);
      // it sits on the bottom-right corner of the avatar, and no longer beside the name
      await expect(row(page, 'Rafi writes').locator('.who').getByTestId('presence-dot')).toHaveCount(0);
      const [avBox, dotBox] = [await row(page, 'Rafi writes').locator('.av-wrap .av').boundingBox(), await rafiDot.boundingBox()];
      expect(dotBox!.x + dotBox!.width / 2).toBeGreaterThan(avBox!.x + avBox!.width / 2);
      expect(dotBox!.y + dotBox!.height / 2).toBeGreaterThan(avBox!.y + avBox!.height / 2);
      expect(dotBox!.x).toBeLessThan(avBox!.x + avBox!.width + 6);

      // Omar: Active with words only, so no picture is drawn, and the words are in the name
      const omarDot = dotOf(row(page, 'Omar writes').locator('.av-wrap'));
      await expect(omarDot).toHaveAccessibleName('Active, Heads down');
      await expect(omarDot.locator('.pdot-emoji')).toHaveCount(0);

      // Priya never beat: an empty ring, Offline
      const priyaDot = dotOf(row(page, 'Priya writes').locator('.av-wrap'));
      await expect(priyaDot).toHaveAttribute('data-presence', 'offline');
      await expect(priyaDot).toHaveAccessibleName('Offline');
      expect(await fill(priyaDot)).toMatch(TRANSPARENT);
      await expect(priyaDot.locator('.pdot-emoji')).toHaveCount(0);

      // the bot: no dot, no profile button, a plain name
      const bot = row(page, 'Coder writes');
      await expect(dotOf(bot)).toHaveCount(0);
      await expect(bot.getByTestId('profile-open')).toHaveCount(0);
      await expect(bot.locator('.pcard-avatar')).toHaveCount(0);
      await expect(bot.locator('.who b')).toHaveText(/\S/);
    } finally {
      await context.close();
    }
  });

  test('a person whose last beat says away has the half-filled Away dot', async ({ browser, playwright }) => {
    await beat(rafi, 'away');
    const { page, context } = await openOn(browser, playwright, stack, 'nadia', `/t/engineering/c/${chan.name}`);
    try {
      const dot = dotOf(row(page, 'Rafi writes').locator('.av-wrap'));
      await expect(dot).toHaveAttribute('data-presence', 'away', T);
      await expect(dot).toHaveAccessibleName(/^Away, /);
      // half filled: a gradient, not a flat fill and not an empty ring
      expect(await dot.locator('.pdot').evaluate((el) => getComputedStyle(el).backgroundImage)).toContain('linear-gradient');
    } finally {
      await context.close();
      await beat(rafi);
    }
  });

  test('nothing is drawn until the cards have arrived, and nothing on a server without the plugin (an unknown answer is not Offline)', async ({ browser, playwright }) => {
    await beat(rafi);
    const { page, context } = await openOn(browser, playwright, stack, 'nadia', `/t/engineering/c/${chan.name}`);
    try {
      await expect(dotOf(row(page, 'Rafi writes'))).toHaveCount(1, T);

      // held: the answer is on its way, so the names are plain and no dot says Offline
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      await page.route('**/api/presence/people', async (route) => {
        await gate;
        await route.continue();
      });
      await page.reload();
      await expect(row(page, 'Rafi writes')).toBeVisible(T);
      await page.waitForTimeout(1_500);
      await expect(dotOf(page)).toHaveCount(0);
      await expect(page.getByTestId('profile-open')).toHaveCount(0);
      release();
      await expect(dotOf(row(page, 'Rafi writes'))).toHaveAttribute('data-presence', 'online', T);
      await expect(page.getByTestId('profile-open').first()).toBeVisible();

      // a server that answers 404 (no plugin): still nothing, and the name stays text
      await page.unroute('**/api/presence/people');
      await page.route('**/api/presence/**', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' }));
      await page.reload();
      await expect(row(page, 'Rafi writes')).toBeVisible(T);
      await page.waitForTimeout(1_500);
      await expect(dotOf(page)).toHaveCount(0);
      await expect(page.getByTestId('profile-open')).toHaveCount(0);
      await expect(row(page, 'Rafi writes').locator('.who b')).toContainText('Rafi');
    } finally {
      await context.close();
    }
  });

  test('the @ picker, the new-message picker and the one-to-one conversation row carry the same dots; a group conversation has none', async ({ browser, playwright }) => {
    await beat(rafi);
    await beat(omar);
    const { page, context } = await openOn(browser, playwright, stack, 'nadia', `/t/engineering/c/${chan.name}`);
    try {
      await expect(dotOf(row(page, 'Rafi writes'))).toHaveCount(1, T);

      // the @ picker: a dot in each person's option, and in its accessible name
      await page.getByRole('textbox', { name: /Message/ }).click();
      await page.keyboard.type('@');
      const list = page.getByRole('listbox');
      await expect(list).toBeVisible(T);
      const rafiOption = list.getByRole('option', { name: /Rafi/ });
      await expect(dotOf(rafiOption)).toHaveAttribute('data-presence', 'online');
      await expect(rafiOption).toHaveAccessibleName(/Rafi.*Active, .*Lunch/);
      await expect(dotOf(rafiOption).locator('.pdot-emoji')).toContainText('🍽');
      const priyaOption = list.getByRole('option', { name: /Priya/ });
      await expect(dotOf(priyaOption)).toHaveAttribute('data-presence', 'offline');
      await expect(priyaOption).toHaveAccessibleName(/Priya.*Offline/);
      await page.keyboard.press('Escape');

      // the direct messages in the sidebar: one-to-one rows show the other person's dot, the group row none
      const dms = page.locator('[data-slot="direct-messages"] a.it');
      await expect(dms).toHaveCount(3, T);
      const withRafi = dms.filter({ has: page.locator('.it-label', { hasText: /^Rafi$/ }) });
      await expect(dotOf(withRafi)).toHaveAttribute('data-presence', 'online', T);
      await expect(withRafi).toHaveAccessibleName(/Rafi.*Active/);
      const withPriya = dms.filter({ has: page.locator('.it-label', { hasText: /^Priya$/ }) });
      await expect(dotOf(withPriya)).toHaveAttribute('data-presence', 'offline');
      await expect(dotOf(dms)).toHaveCount(2); // the group of three has none
      expect(await noSidewaysScroll(page)).toBe(true);

      // the "New message" picker lists people with the same dots
      await page.getByRole('button', { name: 'New message', exact: true }).click();
      const picker = page.getByRole('dialog', { name: 'New message' });
      await expect(dotOf(picker.locator('label', { hasText: 'Rafi' }))).toHaveAttribute('data-presence', 'online', T);
      await expect(dotOf(picker.locator('label', { hasText: 'Priya' }))).toHaveAttribute('data-presence', 'offline');
      await page.keyboard.press('Escape');
    } finally {
      await context.close();
    }
  });

  test('the team roster (People) carries the dots and opens the card', async ({ browser, playwright }) => {
    await beat(rafi);
    const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/settings/team/engineering/roster');
    try {
      const rafiRow = page.locator('.person-row[data-person="rafi@kahf.example"]');
      await expect(rafiRow).toBeVisible(T);
      await expect(dotOf(rafiRow)).toHaveAttribute('data-presence', 'online', T);
      await expect(dotOf(rafiRow).locator('.pdot-emoji')).toContainText('🍽');
      await expect(dotOf(page.locator('.person-row[data-person="priya@kahf.example"]'))).toHaveAttribute('data-presence', 'offline');
      // bots in the roster keep their own look
      await expect(dotOf(page.locator('.mrow:not(.person-row)'))).toHaveCount(0);
      // a name in the roster opens the card too
      await rafiRow.getByTestId('profile-open').click();
      await expect(page.getByTestId('profile-card')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('profile-card')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('a name opens the profile card: status, local time against the reader, working hours; Esc closes it and gives the focus back', async ({ browser, playwright }) => {
    await beat(rafi);
    const { page, context } = await openOn(browser, playwright, stack, 'nadia', `/t/engineering/c/${chan.name}`);
    try {
      const open = row(page, 'Rafi writes').getByTestId('profile-open');
      await expect(open).toBeVisible(T);
      await open.focus();
      await page.keyboard.press('Enter');
      const card = page.getByTestId('profile-card');
      await expect(card).toBeVisible();
      await expect(card).toHaveAccessibleName(/Rafi/);
      await expect(card.getByTestId('profile-presence')).toContainText('Active');
      await expect(card.getByTestId('profile-status')).toContainText('Lunch');
      await expect(card.getByTestId('profile-status')).toContainText('🍽');

      // local time: the clock of Karachi (within two minutes: the card refreshes its clock every 30 s), the zone with its offset, and 1 h ahead of Dubai
      const time = card.getByTestId('profile-time');
      const text = (await time.innerText()).replace(/\s+/g, ' ');
      const clock = /\b(\d\d):(\d\d)\b/.exec(text);
      expect(clock, `a HH:MM clock in "${text}"`).not.toBeNull();
      expect(apart(minutesOfClock(clock![0]), zoneNow('Asia/Karachi').minutes)).toBeLessThanOrEqual(2);
      expect(text).toContain('Karachi (UTC+5)');
      expect(text).toContain('1 h ahead of you');

      // working hours, with the verdict worked out from Karachi's clock (either answer is allowed within two minutes of an edge)
      const hours = card.getByTestId('profile-hours');
      await expect(hours).toContainText('Mon to Fri, 09:00 to 17:00');
      const k = zoneNow('Asia/Karachi');
      const nearEdge = [540, 1020].some((edge) => apart(k.minutes, edge) <= 2);
      const inside = HOURS.days.includes(k.weekday) && k.minutes >= 540 && k.minutes < 1020;
      const verdict = (await hours.innerText()).includes('Outside working hours now') ? false : (await hours.innerText()).includes('Working hours now') ? true : null;
      expect(verdict, 'the card says whether it is inside working hours').not.toBeNull();
      if (!nearEdge) expect(verdict).toBe(inside);

      // no out-of-office note yet
      await expect(card.getByTestId('profile-ooo')).toHaveCount(0);

      // Esc closes it and the name has the focus again
      await page.keyboard.press('Escape');
      await expect(card).toHaveCount(0);
      await expect(open).toBeFocused();

      // the avatar opens the same card with the pointer; the Close button closes it
      await row(page, 'Rafi writes').locator('.pcard-avatar').click();
      await expect(card).toBeVisible();
      await expect(card.getByTestId('profile-presence')).toContainText('Active');
      await card.getByRole('button', { name: 'Close' }).click();
      await expect(card).toHaveCount(0);

      // Priya shared nothing and never beat: Offline, with a plain line that says so
      await row(page, 'Priya writes').getByTestId('profile-open').click();
      await expect(card.getByTestId('profile-presence')).toContainText('Offline');
      await expect(card.getByTestId('profile-empty')).toContainText('Priya has not shared a status, time zone or working hours.');
      await expect(card.getByTestId('profile-time')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(card).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('the out-of-office form saves through the real route; the card shows the day back and the delegate; switching it off clears it', async ({ browser, playwright }) => {
    await beat(rafi);
    const back = dayIn('Asia/Karachi', 5);
    const today = dayIn('Asia/Karachi', 0);
    const rafiPage = await openOn(browser, playwright, stack, 'rafi', '/account#status-and-dnd');
    try {
      const section = rafiPage.page.getByTestId('presence-settings');
      await expect(section).toBeVisible(T);
      await expect(section.getByTestId('status-visible')).toHaveText('Everyone in the workspace can see this.');
      const form = section.getByTestId('ooo-editor');
      await expect(form.getByTestId('ooo-save')).toBeDisabled();
      await form.getByTestId('ooo-switch').click();
      await expect(form.getByTestId('ooo-switch')).toHaveAttribute('aria-checked', 'true');
      // the day is read in his saved zone, and the form says so
      await expect(form.getByTestId('ooo-zone')).toContainText('Karachi');

      // today is not a return day: a plain sentence, nothing saved
      await form.getByTestId('ooo-returns').fill(today.iso);
      await form.getByTestId('ooo-save').click();
      await expect(form.getByTestId('ooo-error')).toHaveText('Choose a return day after today.');
      expect((await meOf(rafi)).outOfOffice).toBeNull();

      await form.getByTestId('ooo-returns').fill(back.iso);
      await form.getByTestId('ooo-delegate').selectOption({ label: 'Omar' });
      await form.getByTestId('ooo-message').fill('Travelling, urgent things go to Omar');
      await form.getByTestId('ooo-save').click();
      await expect(form.getByTestId('ooo-note')).toHaveText('Out of office saved.', T);
      await expect(form.getByTestId('ooo-error')).toHaveCount(0);
      expect((await meOf(rafi)).outOfOffice).toEqual({ active: true, returnsOn: back.iso, delegatePersonId: ids.omar, message: 'Travelling, urgent things go to Omar' });
      await expect(form.getByTestId('ooo-save')).toBeDisabled();

      // a reload shows what is saved
      await rafiPage.page.reload();
      await expect(rafiPage.page.getByTestId('ooo-switch')).toHaveAttribute('aria-checked', 'true', T);
      await expect(rafiPage.page.getByTestId('ooo-returns')).toHaveValue(back.iso);
      await expect(rafiPage.page.getByTestId('ooo-message')).toHaveValue('Travelling, urgent things go to Omar');

      // Nadia: the dot says it in words and the card shows the day back, the note and the delegate by name
      await beat(rafi);
      const nadiaPage = await openOn(browser, playwright, stack, 'nadia', `/t/engineering/c/${chan.name}`);
      try {
        const dot = dotOf(row(nadiaPage.page, 'Rafi writes').locator('.av-wrap'));
        await expect(dot).toHaveAccessibleName(/^Active, .*Lunch, Out of office$/, T);
        await row(nadiaPage.page, 'Rafi writes').getByTestId('profile-open').click();
        const card = nadiaPage.page.getByTestId('profile-card');
        const ooo = card.getByTestId('profile-ooo');
        await expect(ooo).toBeVisible();
        await expect(ooo).toContainText(new RegExp(`Back [A-Z][a-z]{2},? ${back.day} ${back.mon}`));
        await expect(ooo).toContainText('Travelling, urgent things go to Omar');
        await expect(ooo).toContainText('Ask Omar meanwhile');
        await nadiaPage.page.keyboard.press('Escape');
        await nadiaPage.page.keyboard.press('Escape');

        // switched off: the form clears the whole note, and the card has none after the next read
        await rafiPage.page.getByTestId('ooo-switch').click();
        await expect(rafiPage.page.getByTestId('ooo-switch')).toHaveAttribute('aria-checked', 'false');
        await rafiPage.page.getByTestId('ooo-save').click();
        await expect(rafiPage.page.getByTestId('ooo-note')).toHaveText('Out of office is off.', T);
        expect((await meOf(rafi)).outOfOffice).toBeNull();
        await beat(rafi);
        await nadiaPage.page.reload();
        await expect(dotOf(row(nadiaPage.page, 'Rafi writes').locator('.av-wrap'))).toHaveAccessibleName(/^Active, .*Lunch$/, T);
        await row(nadiaPage.page, 'Rafi writes').getByTestId('profile-open').click();
        await expect(nadiaPage.page.getByTestId('profile-card')).toBeVisible();
        await expect(nadiaPage.page.getByTestId('profile-ooo')).toHaveCount(0);
      } finally {
        await nadiaPage.context.close();
      }
    } finally {
      await rafiPage.context.close();
      await patchMe(rafi, { outOfOffice: null });
    }
  });

  test('a guest sees no dot and no profile button beside anybody, and the server serves her only her own card', async ({ browser, playwright }) => {
    await beat(rafi);
    const { page, context } = await openOn(browser, playwright, stack, 'lena', '/');
    try {
      await expect(page).toHaveURL(/\/c\/releases$/, T);
      await expect(page.locator('[data-testid="message"]').first()).toBeVisible(T);
      // wait for her round of cards to finish, so "no dot" is not "not here yet"
      const answered = page.waitForResponse((r) => r.url().includes('/api/presence/people'));
      await page.reload();
      expect((await answered).status()).toBe(200);
      await expect(page.locator('[data-testid="message"]').first()).toBeVisible(T);
      await page.waitForTimeout(1_000);
      await expect(dotOf(page)).toHaveCount(0);
      await expect(page.getByTestId('profile-open')).toHaveCount(0);
      await expect(page.locator('.msg .who b').first()).toHaveText(/^(Omar|Nadia|Rafi)/);

      const cards = await lena.get<{ people: Array<{ personId: string }> }>('/api/presence/people');
      expect(cards.people.every((p) => p.personId === cards.people[0]?.personId)).toBe(true);
      expect(cards.people.map((p) => p.personId)).not.toContain(ids.rafi);
    } finally {
      await context.close();
    }
  });
});

test.describe('phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'a 390 px screen; the desktop layout has its own tests above');

  test('a message row with a dot and a long status does not scroll sideways, and the card fits the screen', async ({ browser, playwright }) => {
    const long = `Out at lunch with the whole department ${'x'.repeat(58)}`.slice(0, 100);
    await patchMe(rafi, { status: { emoji: '🍽️', text: long, clearsAt: null } });
    await beat(rafi);
    const { page, context } = await openOn(browser, playwright, stack, 'nadia', `/t/engineering/c/${chan.name}`, { viewport: PHONE, mobile: true });
    try {
      const mine = row(page, 'Rafi writes');
      await expect(mine).toBeVisible(T);
      const dot = dotOf(mine.locator('.av-wrap'));
      await expect(dot).toHaveAttribute('data-presence', 'online', T);
      await expect(dot).toHaveAccessibleName(/^Active, .*Out at lunch/);
      expect(await noSidewaysScroll(page)).toBe(true);
      const box = (await mine.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
      const dotBox = (await dot.boundingBox())!;
      expect(dotBox.x + dotBox.width).toBeLessThanOrEqual(PHONE.width);

      // the name is a touch target; the card opens with the whole status, inside the screen, and Esc closes it
      const open = mine.getByTestId('profile-open');
      await open.click();
      const card = page.getByTestId('profile-card');
      await expect(card).toBeVisible();
      await expect(card.getByTestId('profile-status')).toContainText('Out at lunch');
      const cardBox = (await card.boundingBox())!;
      expect(cardBox.x).toBeGreaterThanOrEqual(0);
      expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(PHONE.width);
      expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await noSidewaysScroll(page)).toBe(true);
      const close = (await card.getByRole('button', { name: 'Close' }).boundingBox())!;
      expect(close.height).toBeGreaterThanOrEqual(36);
      await page.keyboard.press('Escape');
      await expect(card).toHaveCount(0);
      await expect(open).toBeFocused();
    } finally {
      await context.close();
      await patchMe(rafi, { status: LUNCH });
    }
  });

  test('the out-of-office form fits a 390 px screen and its controls are large enough', async ({ browser, playwright }) => {
    const { page, context } = await openOn(browser, playwright, stack, 'rafi', '/account#status-and-dnd', { viewport: PHONE, mobile: true });
    try {
      const form = page.getByTestId('ooo-editor');
      await expect(form).toBeAttached(T);
      await form.getByTestId('ooo-switch').scrollIntoViewIfNeeded();
      await form.getByTestId('ooo-switch').click();
      for (const id of ['ooo-returns', 'ooo-delegate', 'ooo-message', 'ooo-save']) {
        const el = form.getByTestId(id);
        await el.scrollIntoViewIfNeeded();
        const box = (await el.boundingBox())!;
        expect(box.height, id).toBeGreaterThanOrEqual(36);
        expect(box.x, id).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, id).toBeLessThanOrEqual(PHONE.width);
      }
      expect(await noSidewaysScroll(page)).toBe(true);
    } finally {
      await context.close();
    }
  });
});
