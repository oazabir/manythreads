import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type BrowserContext, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn, channelsOf, DESKTOP, PHONE, type StackApi } from '../support/stack-browser.ts';
import { meetingsStack, type Who } from '../meetings/support.ts';

/**
 * The pictures of P33-05: the channel header with and without a live voice room, the room card (live; as its starter; when the reader is in the room), the Members panel
 * as a lead and as a member, the End confirm, and a 44-character channel name, in Graphite dark and Linen light, at 1440 and 390 px, and the header alone at 800, 1000 and 1100 px with the Members panel closed and open. A tool, not a check: it is skipped
 * unless MANYTHREADS_HEADER_PICTURES=1, and it writes the PNGs to MANYTHREADS_HEADER_PICTURES_DIR (default temp/screenshots/p33 in the repository). Run it with
 * `MANYTHREADS_HEADER_PICTURES=1 pnpm e2e --project=desktop channels/header-pictures.spec.ts`. One browser takes both sizes, so the phone project is not needed.
 */
test.skip(!process.env['MANYTHREADS_HEADER_PICTURES'], 'a picture tool, run on purpose');
test.skip(({ isMobile }) => isMobile, 'takes its own sizes');
test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 10_000 });

const OUT = process.env['MANYTHREADS_HEADER_PICTURES_DIR'] ?? fileURLToPath(new URL('../../temp/screenshots/p33/', import.meta.url));
const LOOKS = [
  { name: 'graphite-dark', theme: 'dark', palette: 'graphite' },
  { name: 'linen-light', theme: 'light', palette: 'linen' },
] as const;
const SIZES = [
  { name: '1440', mobile: false },
  { name: '390', mobile: true },
] as const;
const LONG = 'hdr-' + 'x'.repeat(40);
const T = { timeout: 15_000 };

/** The header's strip at twice the size, so the icons can be judged (the page pictures are 1x). */
async function strip(page: Page, path: string): Promise<void> {
  const h = page.locator('[data-landmark="header"]');
  const box = (await h.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, box.x + box.width - 460), y: box.y, width: Math.min(460, box.width), height: box.height, scale: 2 } });
  await cdp.detach();
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path, Buffer.from(data, 'base64'));
}

let stack: Stack;
let dev = '';
let longId = '';
const SMALL = 'p33-small';
test.beforeAll(async ({ playwright }) => {
  mkdirSync(OUT, { recursive: true });
  stack = await meetingsStack('content');
  const omar = await apiOn(playwright, stack, 'omar');
  dev = (await channelsOf(omar))['dev']!;
  longId = (await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name: LONG })).channel.id;
  // a small channel, so the Members panel has team members outside it to show (everyone is in #dev)
  const small = (await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name: SMALL })).channel.id;
  expect(await omar.post(`/api/channels/${small}/join`)).toEqual({ joined: true });
  const rafiApi = await apiOn(playwright, stack, 'rafi');
  expect(await rafiApi.post(`/api/channels/${small}/join`)).toEqual({ joined: true });
  await rafiApi.ctx.dispose();
  await omar.ctx.dispose();
});
test.afterAll(async () => {
  await stack?.stop();
});

async function openLooking(browser: Browser, playwright: PlaywrightWorkerArgs['playwright'], who: Who, path: string, look: (typeof LOOKS)[number], mobile: boolean, width?: number): Promise<{ page: Page; context: BrowserContext }> {
  const api = await apiOn(playwright, stack, who);
  const saved = await api.ctx.put('/api/me/appearance', { data: { theme: look.theme, density: 'comfortable', palette: look.palette }, headers: await api.headers() });
  expect(saved.status(), 'saving the look').toBe(200);
  const state = await api.ctx.storageState();
  await api.ctx.dispose();
  const value = JSON.stringify({ theme: look.theme, density: 'comfortable', palette: look.palette });
  const storageState = { ...state, origins: [...state.origins.filter((o) => o.origin !== stack.origin), { origin: stack.origin, localStorage: [{ name: 'mt.appearance', value }] }] };
  const context = await browser.newContext({
    baseURL: stack.origin,
    viewport: mobile ? PHONE : width ? { width, height: DESKTOP.height } : DESKTOP,
    storageState,
    colorScheme: look.theme,
    reducedMotion: 'reduce',
    permissions: ['microphone'],
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await context.newPage();
  await page.goto(path);
  return { page, context };
}

/* the Members panel: the header icon, or on a phone (P34-05: the header is the name and the bell) the details menu's "Members (n)" */
async function openMembersPanel(page: Page, mobile: boolean): Promise<void> {
  if (!mobile) {
    await page.getByTestId('members-open').click();
    return;
  }
  await page.getByTestId('channel-details-button').click();
  await page.getByTestId('details-members-open').click();
}

/* the tools are drawn once their data is in: visible on a wide screen, hidden (their items are in the details menu) on a phone */
async function expectTools(page: Page, mobile: boolean): Promise<void> {
  for (const tool of ['members-open', 'call-start']) {
    if (mobile) {
      await expect(page.getByTestId(tool)).toHaveCount(1, T);
      await expect(page.getByTestId(tool)).toBeHidden();
    } else await expect(page.getByTestId(tool)).toBeVisible(T);
  }
}

async function endLive(api: StackApi): Promise<void> {
  const rooms = await api.get<{ meetings: Array<{ meeting: { id: string; channelId: string } }> }>('/api/meetings/live').catch(() => ({ meetings: [] }));
  for (const r of rooms.meetings) await api.post(`/api/meetings/${r.meeting.id}/end`).catch(() => undefined);
}

for (const look of LOOKS) {
  for (const size of SIZES) {
    test(`${look.name} at ${size.name}`, async ({ browser, playwright }) => {
      const base = `${OUT}${look.name}-${size.name}-`;
      const nadiaApi = await apiOn(playwright, stack, 'nadia');
      await endLive(nadiaApi);
      const contexts: BrowserContext[] = [];
      try {
        // 1. the header with no room
        const omar = await openLooking(browser, playwright, 'omar', '/t/engineering/c/dev', look, size.mobile);
        contexts.push(omar.context);
        await expectTools(omar.page, size.mobile);
        await omar.page.waitForTimeout(400);
        await omar.page.screenshot({ path: `${base}header-no-room.png` });
        await strip(omar.page, `${base}strip-no-room.png`);
        if (size.mobile) {
          // the details menu with the header's tools at its top
          await omar.page.getByTestId('channel-details-button').click();
          await expect(omar.page.getByTestId('details-members-open')).toBeVisible(T);
          await omar.page.waitForTimeout(300);
          await omar.page.screenshot({ path: `${base}details-menu.png` });
          await omar.page.keyboard.press('Escape');
        }

        // 2. the members panel as a lead, then as a member
        const lead = await openLooking(browser, playwright, 'omar', `/t/engineering/c/${SMALL}`, look, size.mobile);
        contexts.push(lead.context);
        await openMembersPanel(lead.page, size.mobile);
        await expect(lead.page.getByTestId('members-out').getByTestId('member-add').first()).toBeVisible(T);
        await lead.page.waitForTimeout(300);
        await lead.page.screenshot({ path: `${base}members-lead.png` });
        await lead.context.close();
        const rafi = await openLooking(browser, playwright, 'rafi', `/t/engineering/c/${SMALL}`, look, size.mobile);
        contexts.push(rafi.context);
        await openMembersPanel(rafi.page, size.mobile);
        await expect(rafi.page.getByTestId('members-panel')).toBeVisible(T);
        await expect(rafi.page.getByTestId('members-no-add')).toBeVisible(T);
        await rafi.page.waitForTimeout(300);
        await rafi.page.screenshot({ path: `${base}members-member.png` });
        await rafi.context.close();

        // 3. a room is live (Nadia starts it): the header, the card for a reader, the card for its starter, and the End confirm
        const started = await nadiaApi.post<{ meeting: { id: string } }>(`/api/channels/${dev}/meetings`, {});
        expect(started.meeting.id).toBeTruthy();
        await omar.page.reload();
        await expect(omar.page.getByTestId('room-card')).toBeVisible(T);
        await omar.page.getByTestId('room-card').scrollIntoViewIfNeeded();
        await omar.page.waitForTimeout(400);
        await omar.page.screenshot({ path: `${base}header-live-room.png` });
        await strip(omar.page, `${base}strip-live.png`);
        await omar.page.getByTestId('room-card').screenshot({ path: `${base}room-card-live.png` });

        const nadia = await openLooking(browser, playwright, 'nadia', '/t/engineering/c/dev', look, size.mobile);
        contexts.push(nadia.context);
        await expect(nadia.page.getByTestId('room-card-end')).toBeVisible(T);
        await nadia.page.getByTestId('room-card').scrollIntoViewIfNeeded();
        await nadia.page.waitForTimeout(300);
        await nadia.page.screenshot({ path: `${base}header-live-starter.png` });
        await nadia.page.getByTestId('room-card').screenshot({ path: `${base}room-card-starter.png` });
        await nadia.page.getByTestId('room-card-end').click();
        await expect(nadia.page.getByTestId('room-end-confirm')).toBeVisible(T);
        // the confirm makes the card taller: the list goes back to the latest message so the buttons are not under the message box
        const jump = nadia.page.getByRole('button', { name: /Jump to latest/ });
        if (await jump.isVisible()) await jump.click();
        await nadia.page.getByTestId('room-end-confirm').scrollIntoViewIfNeeded();
        await nadia.page.waitForTimeout(300);
        await nadia.page.screenshot({ path: `${base}end-confirm.png` });
        await nadia.page.getByTestId('room-card').screenshot({ path: `${base}end-confirm-card.png` });
        await nadia.page.getByTestId('room-end-confirm-no').click();

        // 4. the starter in the room: the icon is a state, the card says so
        await nadia.page.getByTestId('room-card-join').click();
        await expect(nadia.page.getByTestId('call-dock')).toHaveAttribute('data-phase', 'connected', { timeout: 20_000 });
        await expect(nadia.page.getByTestId('room-card-in')).toBeVisible(T);
        await nadia.page.getByTestId('room-card').scrollIntoViewIfNeeded();
        await nadia.page.waitForTimeout(400);
        await nadia.page.screenshot({ path: `${base}header-in-room.png` });
        await strip(nadia.page, `${base}strip-in-room.png`);
        await nadia.page.getByTestId('room-card').screenshot({ path: `${base}room-card-in-room.png` });
        await nadia.page.getByTestId('call-leave').click();
        await expect(nadia.page.getByTestId('call-dock')).toBeHidden(T);
        await endLive(nadiaApi);

        // 5. a 44-character channel name
        const long = await openLooking(browser, playwright, 'omar', `/t/engineering/c/${LONG}`, look, size.mobile);
        contexts.push(long.context);
        await expectTools(long.page, size.mobile);
        await long.page.waitForTimeout(400);
        await long.page.screenshot({ path: `${base}header-long-name.png` });
        expect(longId).toBeTruthy();
      } finally {
        for (const c of contexts) await c.close().catch(() => undefined);
        await endLive(nadiaApi);
        await nadiaApi.ctx.dispose();
      }
    });
  }
}

/** The in-between widths: the header with the Members panel closed and open, and no icon pushed out of the header or onto another. */
for (const look of LOOKS) {
  for (const width of [800, 1000, 1100]) {
    test(`${look.name} header at ${width}`, async ({ browser, playwright }) => {
      const base = `${OUT}${look.name}-${width}-`;
      const o = await openLooking(browser, playwright, 'omar', `/t/engineering/c/${LONG}`, look, false, width);
      try {
        const members = o.page.getByTestId('members-open');
        await expect(members).toBeVisible(T);
        for (const state of ['closed', 'open'] as const) {
          if (state === 'open') {
            await members.click();
            await expect(o.page.getByTestId('members-panel')).toBeVisible(T);
          }
          await o.page.waitForTimeout(400);
          await o.page.screenshot({ path: `${base}header-long-name-${state}.png`, clip: { x: 0, y: 0, width, height: 120 } });
          const fit = await o.page.evaluate(() => {
            const head = document.querySelector('header.chead') as HTMLElement;
            const right = head.getBoundingClientRect().right;
            const tools = [...head.querySelectorAll<HTMLElement>('.chead-actions > *')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.getBoundingClientRect());
            const overlaps = tools.some((a, i) => tools.slice(i + 1).some((b) => a.left < b.right - 0.5 && b.left < a.right - 0.5));
            return { over: head.scrollWidth - head.clientWidth, sideways: head.scrollWidth > head.clientWidth, pastEdge: tools.some((r) => r.right > right + 0.5), overlaps, height: Math.round(head.getBoundingClientRect().height) };
          });
          expect(fit, `the header at ${width} with the panel ${state}: ${JSON.stringify(fit)}`).toMatchObject({ sideways: false, pastEdge: false, overlaps: false });
          // one row: the 52 px of the design (53 with the border); a wrapped header would be taller
          expect(fit.height, `the header's height at ${width} with the panel ${state}`).toBeLessThanOrEqual(53);
        }
      } finally {
        await o.context.close();
      }
    });
  }
}
