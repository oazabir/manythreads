import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { BOTS_STACK_ENV, apiOn, openBot } from './support.ts';

/*
 * The bot page's Deploy action (PLAN P8-34) end to end. A workspace admin presses Deploy on a bot and reads one answer with three parts (the definition, the knowledge, the
 * connection), each with its own words and state; a bot that was already deployed says nothing changed. A member who does not lead the team is not offered the button and the
 * API refuses them too. The refusal cases (no documents, no credential, a lead who is not an admin) are proved on a real server in
 * packages/plugins/workshop/test/deploy.test.ts. Desktop layout.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack(BOTS_STACK_ENV);
});
test.afterAll(async () => {
  await stack?.stop();
});

test('an admin presses Deploy and reads the three outcomes; a second press changes nothing and says so', async ({ browser, playwright }) => {
  const { page, close } = await openBot(browser, playwright, stack, 'omar', 'coder');
  try {
    await expect(page.getByTestId('deploy-result')).toHaveCount(0);
    await page.getByTestId('deploy-bot').click();
    const result = page.getByTestId('deploy-result');
    await expect(result).toBeVisible();
    for (const step of ['definition', 'knowledge', 'connection']) {
      const row = page.getByTestId(`deploy-outcome-${step}`);
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute('data-state', /^(changed|unchanged|not_used|refused|not_run)$/);
    }
    // the file is what the repo holds and the page has no unsaved changes: nothing is committed
    await expect(page.getByTestId('deploy-outcome-definition')).toHaveAttribute('data-state', 'unchanged');

    await page.getByTestId('deploy-close').click();
    await expect(result).toHaveCount(0);
    await page.getByTestId('deploy-bot').click();
    await expect(page.getByTestId('deploy-headline')).toBeVisible();
    await expect(page.getByTestId('deploy-outcome-definition')).toHaveAttribute('data-state', 'unchanged');
  } finally {
    await close();
  }
});

test('a member who does not lead the team is not offered Deploy, and the API refuses them', async ({ browser, playwright }) => {
  const { page, close } = await openBot(browser, playwright, stack, 'nadia', 'coder');
  try {
    await expect(page.getByTestId('bot-title')).toBeVisible();
    await expect(page.getByTestId('deploy-bot')).toHaveCount(0);
  } finally {
    await close();
  }
  const api = await apiOn(playwright, stack, 'nadia');
  try {
    expect(await api.status('POST', '/api/teams/engineering/bots/coder/deploy', {})).toBe(403);
  } finally {
    await api.ctx.dispose();
  }
});
