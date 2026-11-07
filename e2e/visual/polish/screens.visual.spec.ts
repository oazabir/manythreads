import { expect, test, type Page } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { arrangeApprovals } from '../../approvals/support.ts';
import { plate } from '../support/polish.ts';

/*
 * The screens of the workspace in the Phase 21 look (P21-24): Files, Boards and Jobs with nothing in them, the org chart, the team's memory, the Approvals
 * list, the Bots list, a bot's page and its save bar, and the recipe grid, each in light and dark at 1440 and 390 (class W, own baselines under
 * __baselines__/visual/polish/screens.visual.spec.ts/). The world is seed v4 plus two approvals; Engineering has no board and no job, which is what the
 * two empty plates are for. The coder bot is made by the loader a moment after the stack is up, so the bot plates wait for it.
 */
test.skip(({ isMobile }) => isMobile, 'desktop project: the spec sets its own viewports');
test.use({ actionTimeout: 10_000 });
test.setTimeout(180_000);

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(240_000); // the web client is built and the stack is seeded first: slow on a busy machine
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'polish', MANYTHREADS_CLOCK: 'fixed' });
  await arrangeApprovals(stack, [
    { path: 'pages/release-notes.md', requester: 'nadia' },
    { path: 'pages/rollback-steps.md', requester: 'rafi' },
  ]);
});
test.afterAll(async () => {
  await stack?.stop();
});

const heading = (page: Page) => page.getByRole('heading', { level: 1 });

test('files manager: the team files', async ({ browser }) => {
  await plate(browser, stack, 'files-manager', {
    go: async (page) => {
      await page.goto('/t/engineering/files');
      await expect(heading(page)).toBeVisible();
    },
  });
});

test('boards empty: a team with no board yet', async ({ browser }) => {
  await plate(browser, stack, 'boards-empty', {
    go: async (page) => {
      await page.goto('/t/engineering/boards');
      await expect(heading(page)).toBeVisible();
    },
  });
});

test('jobs empty: a team with no scheduled job yet', async ({ browser }) => {
  await plate(browser, stack, 'jobs-empty', {
    go: async (page) => {
      await page.goto('/t/engineering/jobs');
      await expect(heading(page)).toBeVisible();
    },
  });
});

test('org chart: the team and the bots under it', async ({ browser }) => {
  await plate(browser, stack, 'org-chart', {
    go: async (page) => {
      await page.goto('/t/engineering/org');
      await expect(heading(page)).toBeVisible();
    },
  });
});

test('memory list: the concepts of the team memory', async ({ browser }) => {
  await plate(browser, stack, 'memory-list', {
    go: async (page) => {
      await page.goto('/t/engineering/memory');
      await expect(heading(page)).toBeVisible();
      await expect(page.getByText('Deploy freeze windows')).toBeVisible();
    },
  });
});

test('approvals list: two calls waiting for a decision', async ({ browser }) => {
  await plate(browser, stack, 'approvals-list', {
    go: async (page) => {
      await page.goto('/t/engineering/approvals');
      await expect(page.getByTestId('approval-row')).toHaveCount(2);
    },
  });
});

test('bots list: the roster', async ({ browser }) => {
  await plate(browser, stack, 'bots-list', {
    go: async (page) => {
      await page.goto('/t/engineering/bots');
      await expect(page.getByText('Coder').first()).toBeVisible();
    },
  });
});

test('bot page: the definition of a bot', async ({ browser }) => {
  await plate(browser, stack, 'bot-page', {
    go: async (page) => {
      await page.goto('/t/engineering/bots/coder?tab=identity');
      await expect(page.getByTestId('bot-role')).toBeVisible();
    },
  });
});

test('save bar: the bar that appears when the definition changed', async ({ browser }) => {
  await plate(browser, stack, 'save-bar', {
    go: async (page) => {
      await page.goto('/t/engineering/bots/coder?tab=identity');
      await page.getByTestId('bot-role').fill('Reviews the Engineering team’s code changes');
      await expect(page.getByTestId('bot-foot')).toBeVisible();
      await expect(page.getByTestId('dirty-state')).toContainText('Unsaved changes');
    },
  });
});

test('recipes grid: the bots a team can add', async ({ browser }) => {
  await plate(browser, stack, 'recipes-grid', {
    go: async (page) => {
      await page.goto('/t/engineering/recipes');
      await expect(page.getByTestId('recipe-card').first()).toBeVisible();
    },
  });
});
