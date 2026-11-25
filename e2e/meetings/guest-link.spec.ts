import { expect, test, type BrowserContext } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { DESKTOP, PHONE } from '../support/stack-browser.ts';
import { closePerson, dock, enterRoom, meetingsStack, openAs, statusOf, type Person } from './support.ts';

/**
 * Guest links and the waiting room (PLAN P17-04, docs/plans/guest-links.md) between browsers, on the fake media server: Nadia starts a call in #dev with "Let people
 * outside the workspace join with a link" on (her link is copied); Rafi joins and copies a link of his own from the card. A context with no session opens Nadia's
 * link, sees the call's title and the workspace, types a name, asks to join and waits (the address loses its secret); Nadia sees "Ana is waiting" and lets her
 * in; the guest is in the call and sees the names; the members see "Ana (guest)" and "+1 guest". The guest's browser gets 401 from a channel route. A second guest
 * at 390 px is turned away. Step 2: transcription on, the guest says yes and her words read "Ana (guest)"; "Guest links (2)" turns Rafi's link off. Nadia takes Ana out ("You were removed from the call."), turns guest links off (the link is then the expired page) and ends the call.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'one spec drives both widths: the guest at 390 px is a context of its own');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let nadia: Person | undefined;
let rafi: Person | undefined;
const guests: BrowserContext[] = [];
let link = '';
let meetingId = '';

test.beforeAll(async () => {
  stack = await meetingsStack('content');
});
test.afterAll(async () => {
  for (const g of guests) await g.close().catch(() => undefined);
  await closePerson(nadia);
  await closePerson(rafi);
  await stack?.stop();
});


test('the starter turns guest links on in the start dialog and her link is kept; a member copies his own from the card', async ({ browser, playwright }) => {
  nadia = await openAs(browser, playwright, stack, 'nadia');
  const page = nadia.page;
  await page.getByTestId('call-start').click();
  const dialog = page.getByTestId('call-start-dialog');
  await expect(dialog.getByTestId('call-start-submit')).toBeEnabled({ timeout: 6_000 });
  const note = dialog.getByTestId('call-start-notetaker');
  if ((await note.count()) > 0 && (await note.getAttribute('aria-checked')) === 'true' && (await note.getAttribute('aria-disabled')) !== 'true') await note.click();
  const sw = dialog.getByTestId('call-start-guests');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await dialog.getByTestId('call-start-submit').click();
  await expect(dock(nadia)).toHaveAttribute('data-phase', 'connected', { timeout: 15_000 });
  // copied when the browser allows it, else shown to copy by hand
  await expect(page.getByTestId('guest-link-toast')).toContainText(/Guest link copied|Copy this guest link/);
  const kept = await page.evaluate(() => {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i) ?? '';
      if (key.startsWith('manythreads_guest_link:')) return { key, value: sessionStorage.getItem(key) ?? '' };
    }
    return null;
  });
  expect(kept).not.toBeNull();
  meetingId = kept!.key.slice('manythreads_guest_link:'.length);
  link = (JSON.parse(kept!.value) as { url: string }).url;
  expect(link).toMatch(/\/join\/g\/[A-Za-z0-9_-]{43}$/);

  rafi = await openAs(browser, playwright, stack, 'rafi');
  await enterRoom(rafi);
  await rafi.page.getByTestId('room-card-guest-link').first().click();
  await expect(rafi.page.getByTestId('guest-link-toast')).toContainText(/Guest link copied|Copy this guest link/);
  // a member who did not start the call cannot turn links off
  await expect(rafi.page.getByTestId('room-card-guest-off')).toHaveCount(0);
  await expect(nadia.page.getByTestId('room-card-guest-off').first()).toBeVisible();
});

test('a guest with no session knocks, waits, is let in, and is in the call; the members see "(guest)"', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: stack.origin, viewport: DESKTOP, reducedMotion: 'reduce', permissions: ['microphone', 'camera'] });
  guests.push(ctx);
  const g = await ctx.newPage();
  await g.goto(new URL(link).pathname);
  await expect(g.locator('h1')).toHaveText(/^Join .+ · .+$/);
  // never the channel's name or the people before being let in
  await expect(g.locator('body')).not.toContainText('#dev');
  await expect(g.locator('body')).not.toContainText('Nadia');
  await g.getByTestId('guest-join').click();
  await expect(g.getByRole('alert')).toContainText('Write your name');
  await g.getByTestId('guest-name').fill('Ana');
  await g.getByTestId('guest-join').click();
  await expect(g.getByTestId('guest-waiting')).toHaveText('Waiting for the host to let you in…');
  // the secret left the address bar
  expect(new URL(g.url()).pathname).toBe('/join/g/');

  const lobby = nadia!.page.getByTestId('call-lobby');
  await expect(lobby).toContainText('Ana is waiting', { timeout: 10_000 });
  await lobby.getByTestId('call-lobby-admit').click();

  await expect(g.getByTestId('guest-call')).toHaveAttribute('data-phase', 'in-call', { timeout: 15_000 });
  await expect(g.getByTestId('guest-people')).toContainText('Nadia');
  await expect(g.getByTestId('guest-people')).toContainText('Ana (guest)');
  await expect(g.getByTestId('guest-bar')).toBeVisible();
  await expect(nadia!.page.getByTestId('call-guest-face')).toContainText('Ana (guest)', { timeout: 15_000 });
  await expect(rafi!.page.getByTestId('room-card-guests').first()).toContainText('+1 guest', { timeout: 15_000 });

  // the guest's browser reaches no session route
  const channelId = (await stack.sql<{ id: string }>("SELECT c.id FROM app.channels c JOIN app.teams t ON t.id = c.team_id WHERE t.slug = 'engineering' AND c.name = 'dev'"))[0]!.id;
  expect((await g.request.get(`/api/channels/${channelId}/messages`)).status()).toBe(401);
  expect((await g.request.get(`/api/meetings/${meetingId}`)).status()).toBe(401);
});

test('step 2: the guest is asked "Transcribe my voice?", her yes writes her words as "Ana (guest)"; the starter sees the links and turns one off', async () => {
  const g = guests[0]!.pages()[0]!;
  // nothing to ask while the call is not transcribed
  await expect(g.getByTestId('guest-consent')).toHaveCount(0);
  expect(await statusOf(nadia!.api, 'PUT', `/api/meetings/${meetingId}/transcription`, { mode: 'on_device' })).toBe(200);
  // the members answer for themselves (their own question is another spec's), so nothing of theirs covers the card
  for (const p of [nadia!, rafi!]) expect(await statusOf(p.api, 'POST', `/api/meetings/${meetingId}/consent`, { transcribe: 'no' })).toBe(200);
  const ask = g.getByTestId('guest-consent');
  await expect(ask).toContainText('Transcribe my voice?', { timeout: 15_000 });
  // not answered: the guest's device writes nothing
  expect(await g.evaluate(() => (window as unknown as { __manythreadsSay?: (t: string) => boolean }).__manythreadsSay?.('too early') ?? false)).toBe(false);
  await ask.getByTestId('guest-consent-yes').click();
  await expect(g.getByTestId('guest-transcribe-state')).toHaveAttribute('data-consent', 'yes');
  await expect
    .poll(() => g.evaluate(() => (window as unknown as { __manythreadsSay?: (t: string) => boolean }).__manythreadsSay?.('Thanks for having me') ?? false), { timeout: 15_000 })
    .toBe(true);
  await expect
    .poll(async () => {
      const res = await nadia!.api.ctx.fetch(`/api/meetings/${meetingId}/transcript`, { headers: await nadia!.api.headers() });
      return JSON.stringify(await res.json());
    }, { timeout: 15_000 })
    .toContain('Ana (guest)');

  // "Guest links (2)": Nadia's and Rafi's; Rafi's is turned off and the count follows
  const links = nadia!.page.getByTestId('room-card-guest-links').first();
  await expect(links).toHaveText('Guest links (2)', { timeout: 15_000 });
  await links.click();
  const rows = nadia!.page.getByTestId('room-card-link');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'Made by Rafi' })).toHaveCount(1);
  await rows.filter({ hasText: 'Made by Rafi' }).getByTestId('room-card-link-off').click();
  await expect(rows).toHaveCount(1);
  await expect(links).toHaveText('Guest links (1)', { timeout: 15_000 });
  // Nadia's own link still works
  expect((await g.request.post('/api/guest-links/peek', { data: { token: link.slice(link.lastIndexOf('/') + 1) }, headers: { origin: stack.origin } })).status()).toBe(200);
});

test('a second guest on a phone (390 px) is turned away', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: stack.origin, viewport: PHONE, isMobile: true, hasTouch: true, reducedMotion: 'reduce', permissions: ['microphone'] });
  guests.push(ctx);
  const g = await ctx.newPage();
  await g.goto(new URL(link).pathname);
  // one column: Ask to join is as wide as the form
  const join = g.getByTestId('guest-join');
  await expect(join).toBeVisible();
  const box = await join.boundingBox();
  expect(box!.width).toBeGreaterThan(250);
  expect(await g.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await g.getByTestId('guest-name').fill('Ben');
  await join.click();
  await expect(g.getByTestId('guest-waiting')).toBeVisible();
  const lobby = nadia!.page.getByTestId('call-lobby');
  await expect(lobby).toContainText('Ben is waiting', { timeout: 10_000 });
  await lobby.getByTestId('call-lobby-deny').click();
  await expect(g.getByTestId('guest-denied')).toHaveText('The host did not let you in.', { timeout: 10_000 });
});

test('taking the guest out ends her call; turning links off makes the link the expired page; the call ends', async () => {
  const g = guests[0]!.pages()[0]!;
  await nadia!.page.getByTestId('call-guest-remove').click();
  await expect(g.getByTestId('guest-removed')).toHaveText('You were removed from the call.', { timeout: 15_000 });
  await expect(nadia!.page.getByTestId('call-guest-face')).toHaveCount(0, { timeout: 15_000 });

  await nadia!.page.getByTestId('room-card-guest-off').first().click();
  await expect(nadia!.page.getByTestId('guest-link-toast')).toContainText('Guest links turned off');
  const again = await guests[0]!.newPage();
  await again.goto(new URL(link).pathname);
  await expect(again.getByTestId('guest-gone')).toContainText('This guest link has expired or was turned off');

  expect(await nadia!.api.status('POST', `/api/meetings/${meetingId}/end`)).toBe(200);
});
