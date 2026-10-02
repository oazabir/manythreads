import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { apiOn } from '../../support/stack-browser.ts';
import { DESKTOP, comparePlate, openPage, type PlateSpec } from '../support/vt.ts';

/*
 * A durable page read in the right panel vs [proto §11 plate 2 · Durable pages] (section cabinet, plate 2). Class P-loose: landmarks in the
 * plate's order and at most 12% differing pixels. The plate's channel is the prototype's own (#analytics with a bot's message and a page card),
 * the page its own words: times, avatars, the stream and the body of the page are masked on both sides. What is compared is the shell, the header,
 * the panel's head with the page's name and where it lives, and the footer with its buttons.
 */
const PLATE: PlateSpec = {
  section: 'cabinet',
  n: 2,
  paneSelector: '.app',
  padding: [0, 0, 0, 0],
  railWidth: 0,
  extraWidth: 2,
  regions: {
    'team-switch': '.side .team',
    search: '.side .srch',
    sidebar: '.side .nav',
    header: '.main .chead',
    content: '.main .stream',
    'right-panel': '.rp',
  },
  masks: ['.av', 'time', '.nav .pill', '.nav > .grp', '.nav > .grp ~ *', '.stream', '.rpb', '.rph .sub', '.chead .topic'],
};

const PAGE = 'pages/reports/week-37.md';
const WEEK_37 = `# Week 37

Sessions held steady week over week; the ticket queue grew slightly, mostly follow-ups on the LED flicker batch. Enquiries picked up after the release-notes post went out on Monday.

| Metric | Value |
| --- | --- |
| Sessions | 18.4k |
| Tickets | 312 |
| Enquiries | 14 |

Sources: ga:sessions, support:tickets, release-notes-2.4.md
`;

let stack: Stack;
test.skip(({ isMobile }) => isMobile, 'desktop plate');
test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'repo', MANYTHREADS_CLOCK: 'fixed' });
  const omar = await apiOn(playwright, stack, 'omar');
  const group = await omar.post<{ group: { id: string } }>('/api/teams/engineering/channel-groups', { name: 'Operations' });
  const channel = await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name: 'analytics', purpose: 'Weekly reporting', groupId: group.group.id });
  await omar.post('/api/teams/engineering/pages/write', { mode: 'create', path: PAGE, content: WEEK_37, message: 'Week 37 report' });
  await omar.post(`/api/channels/${channel.channel.id}/messages`, { channelId: channel.channel.id, body: `Week 37 report written. ${PAGE}`, threadRootId: null });
  await omar.ctx.dispose();
});
test.afterAll(async () => {
  await stack?.stop();
});

test('a durable page read in the panel matches plate 2 (P-loose)', async ({ browser }, testInfo) => {
  const { page, close } = await openPage(browser, stack, 'omar', DESKTOP);
  try {
    await page.goto(`/t/engineering/c/analytics?panel=file:${PAGE}`);
    const panel = page.locator('[data-landmark="right-panel"]');
    await expect(panel.getByTestId('panel-title')).toHaveText('week-37.md');
    await expect(panel.locator('.md-prose h1')).toHaveText('Week 37');
    await expect(page.getByTestId('message')).toHaveCount(1);
    await page.setViewportSize({ width: DESKTOP.width, height: 700 });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await comparePlate(page, browser, testInfo, {
      cls: 'P-loose',
      spec: PLATE,
      liveRegion: '[data-testid="app-frame"]',
      height: 700,
      liveMasks: ['.av', '.rail .hint', '.rail .channel-groups', '.rail [data-slot="direct-messages"]', '.rail .sec', '.rail .dm-empty', '.rail .dm-new', '.panel-body', '.panel-sub', '.chead .topic', '.bell', '.chview .vlist', '.chview .composer'],
      order: ['team-switch', 'search', 'sidebar', 'header', 'content', 'right-panel'],
    });
  } finally {
    await close();
  }
});
