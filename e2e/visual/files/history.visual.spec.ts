import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { apiOn } from '../../support/stack-browser.ts';
import { DESKTOP, comparePlate, openPage, type PlateSpec } from '../support/vt.ts';

/*
 * The team repo with a file open and its History in the right panel vs [proto §11 plate 1 · Team repo and history] (section cabinet, plate 1).
 * Class P: landmarks within 6 px, at most 6% differing pixels of the whole frame (1440x700). The plate's tree is the prototype's own and its
 * editor shows the prototype's BOT.md: both are masked on both sides, with times, avatars and the names of authors. What is compared is the layout: the shell, the
 * header, the file's own band (path, who and when, History), the right panel's head, the commit list with the diff of the selected one, and the
 * Restore button.
 */
const PLATE: PlateSpec = {
  section: 'cabinet',
  n: 1,
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
  masks: ['.av', 'time', '.nav .pill', '.nav > .grp', '.nav > .grp ~ *', '.ftree', '.fvb', '.fvh .m', '.t2', '.rph .sub', '.chead .topic', '.commit .who2 b'],
};

// what happened to the bot, oldest first: the plate's five commits (all Omar's here: only a team lead changes bots/)
const EDITS = [
  'widen visibility to workspace',
  'triggers: add task_assigned',
  'approve rule: warn that updates restart',
  'lessons: batch per-tenant writes',
  'Add Spanish handling',
];

let stack: Stack;
test.skip(({ isMobile }) => isMobile, 'desktop plate');
test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'repo', MANYTHREADS_CLOCK: 'fixed' });
  const omar = await apiOn(playwright, stack, 'omar');
  const path = 'bots/coder/BOT.md';
  for (const message of EDITS) {
    const blob = await omar.get<{ content: string; blobSha: string }>(`/api/teams/engineering/repo/blob?path=${encodeURIComponent(path)}`);
    const res = await omar.ctx.post('/api/teams/engineering/repo/commit', {
      data: { changes: [{ op: 'put', path, content: `${blob.content.trimEnd()}\n\n${message}.\n`, encoding: 'utf8', baseBlobSha: blob.blobSha }], message },
      headers: await omar.headers(),
    });
    expect(res.status(), await res.text()).toBe(201);
  }
  await omar.ctx.dispose();
});
test.afterAll(async () => {
  await stack?.stop();
});

test('the team repo with History matches plate 1 (P)', async ({ browser }, testInfo) => {
  const { page, close } = await openPage(browser, stack, 'omar', DESKTOP);
  try {
    await page.goto('/t/engineering/files?open=bots/coder/BOT.md&panel=history:bots/coder/BOT.md');
    await expect(page.getByTestId('commit-row')).toHaveCount(EDITS.length + 1);
    // the plate shows the second commit with its change
    await page.getByTestId('commit-row').nth(1).getByRole('button').first().click();
    await expect(page.getByTestId('text-diff')).toBeVisible();
    // the file as the plate shows it: the Markdown source
    await page.getByTestId('file-view').getByRole('button', { name: 'Raw', exact: true }).click();
    await page.setViewportSize({ width: DESKTOP.width, height: 700 });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await comparePlate(page, browser, testInfo, {
      cls: 'P',
      spec: PLATE,
      liveRegion: '[data-testid="app-frame"]',
      height: 700,
      liveMasks: ['.av', '.rail .hint', '.rail .channel-groups', '.rail [data-slot="direct-messages"]', '.rail .sec', '.rail .dm-empty', '.rail .dm-new', '.fhead-actions', '.ftree', '.fvb', '.fvh .m', '.t2', '.panel-sub', '.chead .topic', '.bell', '.commit .who2 b'],
      order: ['team-switch', 'search', 'sidebar', 'header', 'tree', 'list', 'right-panel'],
      exact: ['team-switch', 'search', 'sidebar', 'header', 'tree', 'list', 'right-panel'],
    });
  } finally {
    await close();
  }
});
