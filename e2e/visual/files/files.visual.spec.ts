import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { apiOn } from '../../support/stack-browser.ts';
import { buildStory, type Story } from '../support/story.ts';
import { DESKTOP, comparePlate, openPage, type PlateSpec } from '../support/vt.ts';

/*
 * Files vs [proto §02 plate 3 · Files] (section app, plate 3). Class P: landmarks within 6 px, at most 6% differing pixels of the whole frame
 * (1440x700, the plate's size). The plate's tree is the prototype's own (other bots, other channels), its preview a drawn placeholder with six
 * facts: the tree column and the panel's body are masked on both sides, and so are times, names of people and avatars. What is compared is the
 * layout: the shell, the header with its two buttons, the breadcrumb, the filter chips, the table and its rows, the panel's head and buttons.
 */
const PLATE: PlateSpec = {
  section: 'app',
  n: 3,
  paneSelector: '.app',
  padding: [0, 0, 0, 0],
  railWidth: 0,
  extraWidth: 2,
  regions: {
    'team-switch': '.side .team',
    search: '.side .srch',
    sidebar: '.side .nav',
    header: '.main .chead',
    tree: '.ftree',
    list: '.flist',
    'right-panel': '.rp',
  },
  masks: ['.av', 'time', '.nav .pill', '.nav > .grp', '.nav > .grp ~ *', '.ftree', '.frow .src', '.rpb', '.rph .sub', '.chead .topic'],
};

let stack: Stack;
test.skip(({ isMobile }) => isMobile, 'desktop plate');
test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'repo', MANYTHREADS_CLOCK: 'fixed' });
  const story = await buildStory(playwright, stack);
  // the two screenshots of the plate that the story does not post: Tester's schedule-inherited.png and upgrade-2.png
  const rafi = await apiOn(playwright, stack, 'rafi');
  const png = readFileSync(fileURLToPath(new URL('../../fixtures/files/sample.png', import.meta.url)));
  for (const name of ['upgrade-2.png', 'schedule-inherited.png']) {
    const res = await rafi.ctx.post(`/api/channels/${story.channelId}/files`, { headers: { ...(await rafi.headers()), 'content-type': 'image/png', 'x-file-name': name }, data: png });
    expect(res.status()).toBe(201);
  }
  await rafi.ctx.dispose();
  await Promise.all(story.apis.map((a) => a.ctx.dispose()));
});
test.afterAll(async () => {
  await stack?.stop();
});

test('Files matches plate 3 (P)', async ({ browser }, testInfo) => {
  const { page, close } = await openPage(browser, stack, 'omar', DESKTOP);
  try {
    await page.goto('/t/engineering/files?path=channels/release-eng');
    await expect(page.getByTestId('file-row')).toHaveCount(5);
    // the plate selects the newest screenshot
    await page.locator('[data-testid="file-row"][data-path="channels/release-eng/schedule-inherited.png"]').click();
    await expect(page.locator('[data-landmark="right-panel"]').locator('img.media-img')).toBeVisible();
    await page.setViewportSize({ width: DESKTOP.width, height: 700 });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await comparePlate(page, browser, testInfo, {
      cls: 'P',
      spec: PLATE,
      liveRegion: '[data-testid="app-frame"]',
      height: 700,
      liveMasks: ['.av', '.rail .hint', '.rail .channel-groups', '.rail [data-slot="direct-messages"]', '.rail .sec', '.rail .dm-empty', '.rail .dm-new', '.fhead-actions', '.ftree', '.frow .src', '.panel-body', '.panel-sub', '.chead .topic', '.bell'],
      order: ['team-switch', 'search', 'sidebar', 'header', 'tree', 'list', 'right-panel'],
      exact: ['team-switch', 'search', 'sidebar', 'header', 'tree', 'list', 'right-panel'],
    });
  } finally {
    await close();
  }
});
