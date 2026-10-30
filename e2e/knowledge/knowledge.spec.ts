import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { BOTS_STACK_ENV, commitDefinition, openBot } from '../bots/support.ts';
import { apiOn } from '../support/stack-browser.ts';

/*
 * Knowledge (PLAN P8-07, P8-08, P8-33): a team lead gives a bot a knowledge base on its page, uploads a runbook, sees it become searchable, asks a
 * question and gets the passage with its document and version; a changed file is the next version; a member sees the same page and cannot write; a
 * file that cannot be read says why. Runs on its own stack (it writes to the team repo and the blob store).
 */
test.describe.configure({ mode: 'serial' });

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack({ ...BOTS_STACK_ENV });
});
test.afterAll(async () => {
  await stack?.stop();
});

const RUNBOOK_V1 = '# Release runbook\n\nThe canary is held for 30 minutes before the full release.\n\n## Rollback\n\nRoll back with the release tool and tell the team channel.\n';
const RUNBOOK_V2 = '# Release runbook\n\nThe canary is held for 45 minutes before the full release.\n\n## Rollback\n\nRoll back with the release tool and tell the team channel.\n';

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'the phone has its own test below');

  test('a lead adds a base to the bot, uploads a runbook and finds a passage in it with its document and version', async ({ browser, playwright }) => {
    const { page, close } = await openBot(browser, playwright, stack, 'omar', 'coder', '?tab=knowledge');
    try {
      await expect(page.getByText('No knowledge bases')).toBeVisible();
      await page.getByLabel('Knowledge base slug').fill('runbooks');
      await page.getByRole('button', { name: 'Add base' }).click();
      await page.getByTestId('save-bot').click();
      await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();

      // the base is named by the bot but was never made: the page says so and offers to make it
      await expect(page.getByTestId('knowledge-missing')).toContainText('does not exist yet');
      await page.getByRole('button', { name: 'Create it' }).click();
      await expect(page.getByTestId('knowledge-empty')).toBeVisible();
      await expect(page.getByTestId('knowledge-state')).toContainText('Empty');

      await page.getByTestId('knowledge-file').setInputFiles({ name: 'Release runbook.md', mimeType: 'text/markdown', buffer: Buffer.from(RUNBOOK_V1) });
      const doc = page.getByTestId('knowledge-doc');
      await expect(doc).toHaveCount(1);
      await expect(doc).toContainText('Release runbook.md');
      await expect(doc).toContainText('Markdown');
      await expect(doc).toContainText('version 1');
      await expect(doc).toContainText('Searchable');
      await expect(page.getByTestId('knowledge-state')).toContainText('Ready');
      await expect(page.getByTestId('knowledge-notice')).toContainText('was added');

      await page.getByTestId('knowledge-question').fill('how long is the canary held?');
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      const hits = page.getByTestId('knowledge-hits');
      await expect(hits).toContainText('Release runbook.md');
      await expect(hits).toContainText('version 1');
      await expect(hits).toContainText('30 minutes');

      // the same file again changes nothing
      await page.getByTestId('knowledge-file').setInputFiles({ name: 'Release runbook.md', mimeType: 'text/markdown', buffer: Buffer.from(RUNBOOK_V1) });
      await expect(page.getByTestId('knowledge-notice')).toContainText('same content as before');
      await expect(doc).toContainText('version 1');

      // changed content is the next version, and only it is found
      await page.getByTestId('knowledge-file').setInputFiles({ name: 'Release runbook.md', mimeType: 'text/markdown', buffer: Buffer.from(RUNBOOK_V2) });
      await expect(page.getByTestId('knowledge-notice')).toContainText('version 2');
      await expect(doc).toContainText('version 2');
      await page.getByTestId('knowledge-question').fill('how long is the canary held?');
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await expect(page.getByTestId('knowledge-hits')).toContainText('45 minutes');
      await expect(page.getByTestId('knowledge-hits')).not.toContainText('30 minutes');

      // a file nobody can read says why, and the base asks for attention
      await page.getByTestId('knowledge-file').setInputFiles({ name: 'Scan.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 this is not a pdf') });
      await expect(page.getByTestId('knowledge-notice')).toContainText('could not be read');
      await expect(page.locator('[data-testid="knowledge-doc"][data-status="failed"]')).toContainText('PDF');
      await expect(page.getByTestId('knowledge-state')).toContainText('Needs attention');
    } finally {
      await close();
    }
  });

  test('a member sees the documents and can try a question, with nothing to change', async ({ browser, playwright }) => {
    const { page, close } = await openBot(browser, playwright, stack, 'nadia', 'coder', '?tab=knowledge');
    try {
      await expect(page.getByTestId('knowledge-base')).toBeVisible();
      await expect(page.getByTestId('knowledge-doc').first()).toContainText('Release runbook.md');
      await expect(page.getByTestId('knowledge-upload')).toHaveCount(0);
      await expect(page.getByTestId('knowledge-resync')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
      await expect(page.getByText('Only a team lead or a workspace admin can add or remove documents.')).toBeVisible();
      await page.getByTestId('knowledge-question').fill('rollback');
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await expect(page.getByTestId('knowledge-hits')).toContainText('Rollback');
    } finally {
      await close();
    }

    const nadia = await apiOn(playwright, stack, 'nadia');
    try {
      expect(await nadia.status('POST', '/api/teams/engineering/knowledge/runbooks/resync')).toBe(403);
      expect(await nadia.status('POST', '/api/teams/engineering/knowledge', { slug: 'mine' })).toBe(403);
    } finally {
      await nadia.ctx.dispose();
    }
  });

  test('a person of another team cannot search the base', async ({ playwright }) => {
    const outsider = await apiOn(playwright, stack, 'sameera');
    try {
      expect(await outsider.status('GET', '/api/teams/engineering/knowledge/runbooks/search?q=canary')).toBe(403);
    } finally {
      await outsider.ctx.dispose();
    }
  });
});

test.describe('phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'desktop runs the full flow');

  test('the Knowledge tab fits a 390 px screen: no sideways scroll, documents readable', async ({ browser, playwright }) => {
    const omar = await apiOn(playwright, stack, 'omar');
    try {
      const made = await omar.ctx.post('/api/teams/engineering/knowledge', { data: { slug: 'phone-base' }, headers: await omar.headers() });
      expect([201, 409]).toContain(made.status());
      const up = await omar.ctx.post('/api/teams/engineering/knowledge/phone-base/documents?name=Handbook%20with%20a%20rather%20long%20file%20name%20for%20a%20phone.md', {
        data: Buffer.from('# Handbook\n\nVisitors sign in at the front desk.\n'),
        headers: { ...(await omar.headers()), 'content-type': 'application/octet-stream' },
      });
      expect(up.status(), await up.text()).toBe(200);
    } finally {
      await omar.ctx.dispose();
    }
    // the bot names the base in its definition, so the page draws it
    const writer = await apiOn(playwright, stack, 'omar');
    try {
      const { content, blobSha } = await writer.get<{ content: string; blobSha: string }>('/api/teams/engineering/repo/blob?path=bots%2Fcoder%2FBOT.md');
      if (!content.includes('phone-base')) {
        const withBase = content.replace(/\n---\n/, '\nknowledge:\n  - base: phone-base\n---\n');
        await commitDefinition(writer, withBase, 'coder: knowledge base for the phone test', blobSha);
      }
    } finally {
      await writer.ctx.dispose();
    }
    const { page, close } = await openBot(browser, playwright, stack, 'nadia', 'coder', '?tab=knowledge');
    try {
      await expect(page.getByTestId('knowledge-doc').first()).toContainText('Handbook with a rather long file name');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    } finally {
      await close();
    }
  });
});
