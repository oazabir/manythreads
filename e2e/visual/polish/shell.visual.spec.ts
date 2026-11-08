import { expect, test, type Page } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { plate } from '../support/polish.ts';
import type { SizeName } from '../support/vt.ts';

/*
 * The frame around the screens in the Phase 21 look (P21-24): the sidebar folded and with unread rows, the Threads inbox, the search panel, the bell,
 * the settings navigation, Account → Appearance, the health page and the sign-in page, each in light and dark at 1440 and 390 (class W, own baselines under
 * __baselines__/visual/polish/shell.visual.spec.ts/). The fixed clock makes every date the same; times and avatars are masked by `data-vt-mask`.
 */
test.skip(({ isMobile }) => isMobile, 'desktop project: the spec sets its own viewports');
test.use({ actionTimeout: 10_000 });
test.setTimeout(180_000);

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(240_000); // the web client is built and the stack is seeded first: slow on a busy machine
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'polish', MANYTHREADS_CLOCK: 'fixed' });
});
test.afterAll(async () => {
  await stack?.stop();
});

/** On a phone the sidebar is a drawer behind the hamburger. */
async function sidebarOpen(page: Page, size: SizeName): Promise<void> {
  if (size === '390') {
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.locator('[data-testid="app-frame"]')).toHaveAttribute('data-drawer', 'open');
  }
  await expect(page.locator('[data-landmark="sidebar"]')).toBeVisible();
  await page.waitForTimeout(350);
}

const directMessages = (page: Page) => page.locator('[data-landmark="sidebar"]').getByRole('button', { name: /^Direct messages, (open|folded)$/ });

test('sidebar with unread: Nadia has an unread direct message and a channel with new messages', async ({ browser }) => {
  await plate(browser, stack, 'sidebar-unread', {
    who: 'nadia',
    go: async (page, size) => {
      await page.goto('/t/engineering/threads');
      await sidebarOpen(page, size);
      const pill = page.locator('[data-landmark="sidebar"] .pill').first();
      await expect(pill).toBeVisible();
      // in the phone drawer the Direct messages are below the fold: the plate shows the row it is about
      await pill.scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
    },
  });
});

test('sidebar folded: the Direct messages section folded to the rows that need the person', async ({ browser }) => {
  await plate(browser, stack, 'sidebar-folded', {
    who: 'nadia',
    go: async (page, size) => {
      await page.goto('/t/engineering/threads');
      await sidebarOpen(page, size);
      await directMessages(page).click();
      await expect(directMessages(page)).toHaveAttribute('aria-expanded', 'false');
    },
  });
});

test('threads inbox: the threads of the person with the unread one marked', async ({ browser }) => {
  await plate(browser, stack, 'threads-inbox', {
    who: 'rafi',
    go: async (page) => {
      await page.goto('/t/engineering/threads');
      await expect(page.getByTestId('thread-list').or(page.locator('[data-landmark="thread-list"]')).first()).toBeVisible();
    },
  });
});

test('search panel: results over the channel, with the matched words marked', async ({ browser }) => {
  await plate(browser, stack, 'search-panel', {
    who: 'nadia',
    go: async (page, size) => {
      await page.goto('/t/engineering/c/polish');
      await expect(page.getByTestId('message').first()).toBeVisible();
      if (size === '390') {
        await page.getByTestId('bar-search').click();
        const box = page.locator('#shell-rail').getByRole('searchbox');
        await box.fill('checklist');
        await box.press('Enter');
      } else {
        const box = page.locator('[data-landmark="search"]').getByRole('searchbox');
        await box.fill('checklist');
        await box.press('Enter');
      }
      await expect(page.getByTestId('search-results')).toBeVisible();
      await expect(page.getByTestId('search-hit').first()).toBeVisible();
    },
  });
});

test('notifications: the bell open over a channel, with the sender and the quoted line', async ({ browser }) => {
  await plate(browser, stack, 'notifications', {
    who: 'rafi',
    go: async (page) => {
      // the Followed tab opens (and reads) its first thread on a wide screen; the bell plate sits over the Unread tab, which the person chooses from
      await page.goto('/t/engineering/threads?tab=unread');
      await expect(page.getByTestId('bell')).toBeVisible();
      await page.getByTestId('bell').click();
      await expect(page.getByTestId('notifications-popover')).toBeVisible();
    },
  });
});

test('settings navigation: the workspace pages in the left list', async ({ browser }) => {
  await plate(browser, stack, 'settings-nav', {
    go: async (page) => {
      await page.goto('/settings/workspace/general');
      await expect(page.locator('[data-testid="app-frame"]')).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    },
  });
});

test('account appearance: the theme and the density choices', async ({ browser }) => {
  await plate(browser, stack, 'account-appearance', {
    go: async (page) => {
      await page.goto('/account/appearance');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByRole('radio').first()).toBeVisible();
    },
  });
});

/** The numbers of the health page are the machine's (disk, connections), so the plate answers with fixed ones: all fine but one check over its limit. */
const HEALTH = {
  snapshot: {
    takenAt: '2026-03-16T09:00:00.000Z',
    outbox: { backlog: 0, retrying: 0, oldestAgeSeconds: 0 },
    jobs: { ready: 0, running: 0, dead: 0, oldestReadyAgeSeconds: 0, queues: [] },
    runs: { slotsUsed: 0, slotsLimit: 4, queued: 0, oldestQueuedAgeSeconds: 0 },
    approvals: { pending: 2, oldestPendingAgeSeconds: 90_000 },
    budgets: { limits: 0, nearLimit: 0, exhausted: 0, maxBurnPercent: 0 },
    database: { connectionsUsed: 12, connectionsMax: 100 },
    process: { residentBytes: 200_000_000, heapUsedBytes: 100_000_000, eventLoopLagP99Seconds: 0.01, uptimeSeconds: 3600 },
    volumes: [{ name: 'Attachment store', totalBytes: 100_000_000_000, freeBytes: 50_000_000_000, usedPercent: 50 }],
  },
  checks: [
    { name: 'outbox_lag', label: 'Outbox lag', unit: 'seconds', value: 0, threshold: 60, breached: false, since: null },
    { name: 'approval_age', label: 'Oldest pending approval', unit: 'seconds', value: 90_000, threshold: 86_400, breached: true, since: '2026-03-16T08:00:00.000Z' },
    { name: 'db_connections', label: 'Database connections in use', unit: 'percent', value: 12, threshold: 90, breached: false, since: null },
    { name: 'volume_attachments', label: 'Attachment store used', unit: 'percent', value: 50, threshold: 85, breached: false, since: null },
  ],
};

test('health: the system status page, one check over its limit', async ({ browser }) => {
  await plate(browser, stack, 'health-status', {
    go: async (page) => {
      await page.route('**/api/admin/health', (route) => route.fulfill({ json: HEALTH }));
      await page.goto('/settings/workspace/health');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByTestId('health-summary')).toBeVisible();
    },
  });
});

test('sign-in: the page of a person who is signed out', async ({ browser }) => {
  await plate(browser, stack, 'signin', {
    who: null,
    go: async (page) => {
      await page.goto('/sign-in');
      await expect(page.getByLabel('Email')).toBeVisible();
    },
  });
});
