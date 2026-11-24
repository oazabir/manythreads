import { expect, test, type Page } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn, type StackApi } from '../support/stack-browser.ts';
import { closePerson, enterRoom, meetingsStack, openAs, type Person } from './support.ts';

/**
 * The video layouts (PLAN P17-01), on the fake media server: Nadia turns her camera on and the fake media layer plays three other cameras into her room. Grid is
 * the wide-screen default; she picks Speaker (the choice is kept after a reload), pins a tile (it is the large one, and stays so when someone else speaks), unpins;
 * a tile keeps its own video element through the layout switch and a change of the large tile; twenty cameras show as fifteen tiles and a "+5" tile. A weak connection suggests audio only, which stops the other cameras and turns hers off. At 390 px the
 * stage opens in Speaker with a strip that scrolls sideways.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'the desktop layout; the phone case opens its own phone context');
test.describe.configure({ mode: 'serial' });

const ROOM = 'video-layout-room';
const other = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

type FakeMedia = { last(): { remoteVideo(a: string, s: string, on: boolean): void; speak(ids: string[]): void; quality(q: string): void } };
const media = (page: Page, fn: string, ...args: unknown[]): Promise<void> =>
  page.evaluate(
    ([f, a]) => {
      const m = (window as unknown as { __manythreadsFakeMedia: FakeMedia }).__manythreadsFakeMedia.last() as unknown as Record<string, (...x: unknown[]) => void>;
      m[f as string]!(...(a as unknown[]));
    },
    [fn, args] as const,
  );

let stack: Stack;
let omar: StackApi;
let nadia: Person | undefined;
let rafi: Person | undefined;

test.beforeAll(async ({ playwright }) => {
  stack = await meetingsStack('content');
  omar = await apiOn(playwright, stack, 'omar');
  await omar.post('/api/teams/engineering/channels', { name: ROOM });
});
test.afterAll(async () => {
  await closePerson(nadia);
  await closePerson(rafi);
  await omar?.ctx.dispose();
  await stack?.stop();
});

test('Grid and Speaker, the choice kept; pin and unpin; past sixteen a "+N" tile; audio only on a weak connection', async ({ browser, playwright }) => {
  nadia = await openAs(browser, playwright, stack, 'nadia', `/t/engineering/c/${ROOM}`);
  await enterRoom(nadia);
  const page = nadia.page;
  await page.getByTestId('call-camera').click();
  for (const n of [1, 2, 3]) await media(page, 'remoteVideo', other(n), 'camera', true);
  const tiles = page.getByTestId('stage-tile');
  await expect(tiles).toHaveCount(4);

  // Grid by default on a wide screen: no large tile
  await expect(page.getByTestId('call-stage')).toHaveAttribute('data-layout', 'grid');
  await expect(page.getByTestId('stage-layout-grid')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-testid="stage-tile"][data-big]')).toHaveCount(0);

  // Speaker: the one speaking is large. Neither the layout switch nor a new large tile replaces a tile's <video> (no flicker, a floating window stays open)
  const videoOf = (n: number) => page.locator(`[data-testid="stage-tile"][data-key="${other(n)}:camera"] video`);
  const v1 = await videoOf(1).elementHandle();
  const v2 = await videoOf(2).elementHandle();
  await page.getByTestId('stage-layout-speaker').click();
  await expect(page.getByTestId('call-stage')).toHaveAttribute('data-layout', 'speaker');
  await media(page, 'speak', [other(2)]);
  await expect(page.locator('[data-testid="stage-tile"][data-big]')).toHaveAttribute('data-key', `${other(2)}:camera`);
  expect(await videoOf(2).evaluate((el, old) => el === old, v2)).toBe(true);
  expect(await videoOf(1).evaluate((el, old) => el === old, v1)).toBe(true);
  await media(page, 'speak', [other(1)]);
  await expect(page.locator('[data-testid="stage-tile"][data-big]')).toHaveAttribute('data-key', `${other(1)}:camera`);
  expect(await videoOf(1).evaluate((el, old) => el === old, v1)).toBe(true);
  expect(await videoOf(2).evaluate((el, old) => el === old, v2)).toBe(true);

  // pin the third person: large, and still large when the second speaks again
  await page.locator(`[data-testid="stage-tile"][data-key="${other(3)}:camera"]`).hover();
  await page.locator(`[data-testid="stage-tile"][data-key="${other(3)}:camera"] [data-testid="stage-pin"]`).click();
  const big = page.locator('[data-testid="stage-tile"][data-big]');
  await expect(big).toHaveAttribute('data-key', `${other(3)}:camera`);
  await expect(big).toHaveAttribute('data-pinned', 'true');
  await media(page, 'speak', [other(1)]);
  await expect(big).toHaveAttribute('data-key', `${other(3)}:camera`);
  await big.getByTestId('stage-pin').click();
  await expect(big).toHaveAttribute('data-key', `${other(1)}:camera`);

  // twenty cameras: fifteen tiles and "+N" for the rest
  for (let n = 4; n <= 20; n += 1) await media(page, 'remoteVideo', other(n), 'camera', true);
  await expect(tiles).toHaveCount(15);
  await expect(page.getByTestId('stage-overflow')).toContainText('+6');
  for (let n = 4; n <= 20; n += 1) await media(page, 'remoteVideo', other(n), 'camera', false);
  await expect(page.getByTestId('stage-overflow')).toHaveCount(0);

  // a weak connection: a suggestion, not a switch; it lies over the bar, so the stage and the controls stay where they were
  const stageAt = await page.getByTestId('call-stage').boundingBox();
  const muteAt = await page.getByTestId('call-mute').boundingBox();
  await media(page, 'quality', 'poor');
  await expect(page.getByTestId('call-audio-suggest')).toBeVisible();
  await expect(tiles).toHaveCount(4);
  expect(await page.getByTestId('call-stage').boundingBox()).toEqual(stageAt);
  expect(await page.getByTestId('call-mute').boundingBox()).toEqual(muteAt);
  await page.getByTestId('call-audio-suggest-yes').click();
  await expect(page.getByTestId('call-audio-only-chip')).toBeVisible();
  await expect(page.getByTestId('call-stage')).toHaveCount(0);
  await expect(page.getByTestId('call-camera')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('call-camera')).toBeDisabled();
  // the chip turns video back on; her camera stays off until she turns it on
  await page.getByTestId('call-audio-only-chip').click();
  await expect(tiles).toHaveCount(3);
  await expect(page.getByTestId('call-camera')).toBeEnabled();

  // the layout is remembered in this browser
  await page.reload();
  await enterRoom(nadia);
  await page.getByTestId('call-camera').click();
  await expect(page.getByTestId('call-stage')).toHaveAttribute('data-layout', 'speaker');
});

test('at 390 px the stage opens in Speaker, the strip scrolls sideways and nothing is wider than the screen', async ({ browser, playwright }) => {
  rafi = await openAs(browser, playwright, stack, 'rafi', `/t/engineering/c/${ROOM}`, { mobile: true });
  await enterRoom(rafi);
  const page = rafi.page;
  // the sheet opens with the controls
  const grab = page.locator('.call-grab');
  if ((await grab.getAttribute('aria-expanded')) === 'false') await grab.click();
  await page.getByTestId('call-camera').click();
  for (const n of [31, 32, 33, 34]) await media(page, 'remoteVideo', other(n), 'camera', true);
  await expect(page.getByTestId('call-stage')).toHaveAttribute('data-layout', 'speaker');
  const list = page.getByTestId('stage-tiles');
  await expect(list).toBeVisible();
  expect(await list.evaluate((el) => getComputedStyle(el).overflowX)).toBe('auto');
  // the strip is wider than the screen and scrolls sideways; the large tile stays in view
  expect(await list.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await list.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
  const big = await page.locator('[data-testid="stage-tile"][data-big]').boundingBox();
  const box = await list.boundingBox();
  expect(big && box && Math.abs(big.x - box.x)).toBeLessThanOrEqual(1);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(wide).toBeLessThanOrEqual(0);
});
