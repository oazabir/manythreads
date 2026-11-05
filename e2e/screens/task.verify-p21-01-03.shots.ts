/* eslint-disable @typescript-eslint/no-explicit-any -- live probe */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, request, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

/*
 * Live check of P21-01 (message runs, hover time, presence on the avatar corner) and P21-03 (reply previews, "Show more", bot @mention chips).
 * Run: set -a; . ~/manythreads.passwords.env; set +a; MANYTHREADS_URL=https://manythreads.kahf.to \
 *   pnpm -C e2e exec playwright test -c screens/task.config.ts task.verify-p21-01-03
 * Signs in as Omar through the form (OMAR_EMAIL / OMAR_PASSWORD from the environment; never printed) and as Nadia through the sign-in route (NADIA_EMAIL /
 * NADIA_PASSWORD) for the replies. It makes one channel of its own and archives it at the end. A message that @mentions a bot starts that bot's run on the
 * live site: set VERIFY_SKIP_BOT=1 to leave the bot chip out (its assertions are then skipped).
 */
const BASE = process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to';
const OUT = process.env['MANYTHREADS_SHOTS_DIR'] ?? '/tmp/claude-0/-root-manythreads/daef2f10-3041-491b-8f76-f5e85142bb02/scratchpad/v2101';
// Rafi is not a team lead, so he cannot create a channel (403); the default user is Omar. Set VERIFY_AS=RAFI to change.
const WHO = process.env['VERIFY_AS'] ?? 'OMAR';
const OTHER = process.env['VERIFY_OTHER'] ?? 'NADIA';
const SKIP_BOT = process.env['VERIFY_SKIP_BOT'] === '1';
const T = { timeout: 20_000 };
const log = (s: string): void => console.log(`[v] ${s}`);
const sfx = Date.now().toString(36);
mkdirSync(OUT, { recursive: true });
test.describe.configure({ mode: 'serial' });
let ctx: BrowserContext;
let page: Page;
let other: APIRequestContext;
let otherCsrf: Record<string, string> = {};
let chanId = '';
let chanName = '';
let botHandle = '';
const ids: Record<string, string> = {};
const fivexx: string[] = [];

const csrf = async (): Promise<Record<string, string>> => {
  const c = (await ctx.cookies()).find((x) => x.name.endsWith('manythreads_csrf'));
  return c ? { 'x-csrf-token': c.value } : {};
};
const shoot = async (n: string): Promise<void> => {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.screenshot({ path: join(OUT, `${n}.png`) });
  log(`shot ${n}`);
};
const post = async (body: string, threadRootId: string | null = null): Promise<string> => {
  const res = await page.request.post(`/api/channels/${chanId}/messages`, { headers: await csrf(), data: { channelId: chanId, body, threadRootId } });
  expect(res.status(), `post ${body.slice(0, 30)}`).toBeLessThan(300);
  return ((await res.json()) as any).id as string;
};
const postAsOther = async (body: string, threadRootId: string): Promise<string> => {
  const res = await other.post(`/api/channels/${chanId}/messages`, { headers: otherCsrf, data: { channelId: chanId, body, threadRootId } });
  expect(res.status(), `other post ${body.slice(0, 30)}`).toBeLessThan(300);
  return ((await res.json()) as any).id as string;
};
const row = (key: string): ReturnType<Page['locator']> => page.locator(`[data-message-id="${ids[key]}"]`);
const noSideways = async (label: string): Promise<void> => {
  const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  log(`${label} scrollWidth ${w.sw} client ${w.cw} => ${w.sw <= w.cw ? 'OK' : 'SIDEWAYS'}`);
  expect(w.sw).toBeLessThanOrEqual(w.cw);
};

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  page = await ctx.newPage();
  page.on('response', (r) => {
    if (r.status() >= 500) {
      fivexx.push(`${r.status()} ${r.request().method()} ${r.url()}`);
      log(`SERVER ${r.status()} ${r.request().method()} ${r.url()}`);
    }
  });
  page.on('pageerror', (e) => log(`PAGEERROR ${e.message}`));
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(process.env[`${WHO}_EMAIL`] ?? '');
  await page.getByLabel('Password', { exact: true }).fill(process.env[`${WHO}_PASSWORD`] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/, T);
  // the second person, by the API (never printed)
  other = await request.newContext({ baseURL: BASE });
  const res = await other.post('/api/auth/password/sign-in', { data: { email: process.env[`${OTHER}_EMAIL`] ?? '', password: process.env[`${OTHER}_PASSWORD`] ?? '' } });
  expect(res.ok(), `sign in as ${OTHER}`).toBe(true);
  const c = (await other.storageState()).cookies.find((x) => x.name.endsWith('manythreads_csrf'));
  otherCsrf = c ? { 'x-csrf-token': c.value } : {};
});
test.afterAll(async () => {
  log(`5xx responses: ${fivexx.length}`);
  // do not leave the probe channel on the live site
  if (chanId) {
    const res = await page.request.post(`/api/channels/${chanId}/archive`, { headers: await csrf() }).catch(() => undefined);
    log(`archive ${chanName}: ${res?.status() ?? 'failed'}`);
  }
  await other?.dispose();
  await ctx?.close();
});

test('setup: a run of three, a long message, a root answered by another person, a bot mention', async () => {
  chanName = `verify-p21-01-${sfx}`;
  const res = await page.request.post('/api/teams/engineering/channels', { headers: await csrf(), data: { name: chanName } });
  if (res.status() >= 300) log(`create channel ${res.status()} ${(await res.text()).slice(0, 300)}`);
  expect(res.status(), 'create channel').toBeLessThan(300);
  chanId = ((await res.json()) as any).channel.id;
  ids['run1'] = await post('Run one: the first of three quick messages');
  ids['run2'] = await post('Run two: straight after');
  ids['run3'] = await post('Run three: and the last');
  const longBody = ['Long note: the release checklist, in full.', ...Array.from({ length: 14 }, (_, i) => `Step ${i + 1}: check that the thing is done and write it down so nobody asks twice.`)].join('\n\n');
  ids['long'] = await post(longBody);
  ids['root'] = await post('Release plan: who takes the rollout on Friday?');
  ids['quiet'] = await post('A message nobody answered');
  // another person replies (to the root, and to the long note so that a click on it could open a thread)
  await postAsOther('I can take it', ids['root']!);
  await postAsOther('Me too, from 9', ids['root']!);
  await postAsOther('Read it, looks right', ids['long']!);
  if (!SKIP_BOT) {
    const bots = ((await (await page.request.get('/api/teams/engineering/bots')).json()) as any).bots as { slug: string; status: string; mentionable: boolean }[];
    botHandle = bots.find((b) => b.status === 'active' && b.mentionable)?.slug ?? '';
    log(`bot to mention: ${botHandle || 'none found'}`);
    if (botHandle) ids['bot'] = await post(`Question for @${botHandle} and @${OTHER.toLowerCase()}: is the plan ready?`);
  }
  await page.goto(`/t/engineering/c/${chanName}`);
  await expect(row('run1')).toBeVisible(T);
  await shoot('00-channel-desktop');
});

test('P21-01 desktop: one avatar per run, the gutter time on hover with the full date, presence on the avatar corner', async () => {
  const avatars = async (key: string): Promise<number> => row(key).locator('.av:not(.rp-avs .av)').count();
  expect(await avatars('run1'), 'first of the run has the avatar').toBe(1);
  expect(await avatars('run2'), 'second has none').toBe(0);
  expect(await avatars('run3'), 'third has none').toBe(0);
  await expect(row('run1').locator('.who b')).toBeVisible();
  await expect(row('run2').locator('.who b')).toHaveClass(/sr-only/);
  const gutter = row('run2').locator('.run-time');
  await expect(gutter).toHaveCSS('opacity', '0');
  await row('run2').hover();
  await expect(gutter).toHaveCSS('opacity', '1');
  const title = await gutter.getAttribute('title');
  log(`gutter time "${await gutter.innerText()}" title "${title}"`);
  expect(title).toMatch(/^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}( \d{4})?, \d{2}:\d{2}$/);
  await shoot('01-hover-time-desktop');
  // the long note is the fourth of the run; the root comes after a note that has a reply under it, so it starts a run of its own, and so does the one after the root
  expect(await avatars('long')).toBe(0);
  expect(await avatars('root')).toBe(1);
  expect(await avatars('quiet')).toBe(1);
  // presence: the dot, if shown at all, sits on the avatar and not beside the name
  const dots = await row('run1').getByTestId('presence-dot').count();
  log(`presence dots on the first row: ${dots} (in .who: ${await row('run1').locator('.who').getByTestId('presence-dot').count()}, in .av-wrap: ${await row('run1').locator('.av-wrap').getByTestId('presence-dot').count()})`);
  expect(await row('run1').locator('.who').getByTestId('presence-dot').count()).toBe(0);
  expect(await row('run1').locator('.pdot-emoji').count(), 'the status emoji is no longer drawn on a message row').toBe(0);
});

test('P21-03 desktop: Show more opens the text and not the thread; reply preview has avatars, count and the dot; bot chip has the bot tone', async () => {
  const long = row('long');
  await expect(long.locator('.txt')).toHaveClass(/\bclamp\b/, T);
  const cut = (await long.locator('.txt').boundingBox())!.height;
  await shoot('02-long-clamped-desktop');
  await long.getByRole('button', { name: 'Show more' }).click();
  await expect(long.locator('.txt')).not.toHaveClass(/\bclamp\b/);
  expect((await long.locator('.txt').boundingBox())!.height).toBeGreaterThan(cut * 2);
  await expect(page.getByTestId('thread-view')).toHaveCount(0);
  expect(page.url()).not.toContain('panel=');
  log(`Show more: ${Math.round(cut)}px -> ${Math.round((await long.locator('.txt').boundingBox())!.height)}px, no thread opened`);
  await shoot('03-long-expanded-desktop');

  const replies = row('root').locator('button.replies');
  await expect(replies).toContainText('2 replies');
  await expect(replies).toContainText(/Last reply (just now|\d+m ago|\d+h ago)/);
  const faces = await replies.locator('.rp-avs .av').count();
  const dot = await replies.locator('.rp-unread').count();
  log(`reply preview: "${(await replies.innerText()).replace(/\s+/g, ' ')}", avatars ${faces}, unread dot ${dot}`);
  expect(faces).toBe(1); // one other person replied twice: one face
  expect(dot).toBe(1);
  await shoot('04-reply-preview-desktop');
  await replies.click();
  await expect(page.getByTestId('thread-view')).toHaveAttribute('data-root-id', ids['root']!, T);
  await expect(replies.locator('.rp-unread')).toHaveCount(0, T);
  log('the dot cleared after the thread was opened');
  await shoot('05-thread-open-desktop');
  await page.getByRole('button', { name: 'Close panel' }).click();

  if (ids['bot']) {
    const chip = row('bot').locator(`.m[data-mention="${botHandle.toLowerCase()}"]`);
    await expect(chip).toHaveClass(/\bm-bot\b/, T);
    await expect(row('bot').locator(`.m[data-mention="${OTHER.toLowerCase()}"]`)).not.toHaveClass(/\bm-bot\b/);
    log(`bot chip class "${await chip.getAttribute('class')}"`);
    await row('bot').scrollIntoViewIfNeeded();
    await shoot('06-bot-chip-desktop');
  } else log('bot chip: skipped');
});

test('dark mode desktop', async () => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`/t/engineering/c/${chanName}`);
  await expect(row('run1')).toBeVisible(T);
  await shoot('07-channel-dark-desktop');
  await page.emulateMedia({ colorScheme: 'light' });
});

test('phone 390x844: the same run, a tap shows the gutter time, Show more, reply preview, no sideways scroll', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/t/engineering/c/${chanName}`);
  await expect(row('run1')).toBeVisible(T);
  expect(await row('run2').locator('.av:not(.rp-avs .av)').count()).toBe(0);
  await shoot('08-phone-channel');
  await row('run2').locator('.txt').click({ position: { x: 4, y: 4 } });
  await expect(row('run2').locator('.run-time')).toHaveCSS('opacity', '1');
  await shoot('09-phone-tap-time');
  await noSideways('phone channel');
  await row('long').scrollIntoViewIfNeeded();
  await shoot('10-phone-long');
  await row('long').getByRole('button', { name: 'Show more' }).click();
  await expect(page.getByTestId('thread-view')).toHaveCount(0);
  await expect(row('long').locator('.txt')).not.toHaveClass(/\bclamp\b/);
  await shoot('11-phone-long-expanded');
  await row('root').scrollIntoViewIfNeeded();
  await expect(row('root').locator('button.replies .rp-avs .av')).toHaveCount(1);
  await shoot('12-phone-reply-preview');
  await noSideways('phone after expand');
  expect(fivexx, fivexx.join('\n')).toEqual([]);
});
